// Dashboard lifecycle: setup order, rollback, disposal, and the error contract
// for every post-dispose and out-of-scope operation.
//
// Contract pinned here (see ../dashboard.ts):
//   - each setup() runs exactly once, in dependency order, and instance.plugins
//     reports that order
//   - a setup() failure discards the build: already-started plugins are cleaned in
//     reverse order, the reported error is 'setup-failed' with the original throw
//     as its cause and any rollback failure in `errors`
//   - setup() must return void or a cleanup function; an accidental async setup is
//     rejected ('invalid-cleanup') rather than silently dropped
//   - dispose() runs cleanups in reverse setup order, keeps the registries readable
//     while they run, drops everything afterwards, reports aggregated cleanup
//     failures ('cleanup-failed'), is idempotent and re-entrant safe
//   - after disposal every operation fails with 'disposed'; unsubscribe handles
//     and repeated dispose() calls stay harmless
//   - registration is scoped to the plugin whose setup() is running; runtime
//     operations (getService/execute/on/emit) are not
//
// Cross-references: ./plugins.test.ts (pre-setup graph rejection),
// ./state.test.ts + ./events.test.ts (what teardown drops).

import { describe, expect, it } from 'vitest';

import { DashboardError, dashboard } from '../dashboard';
import type { Dashboard, DashboardPlugin, DashboardPluginAPI, DashboardState } from '../types';
import type { DashboardErrorCode } from '../core/errors';

function failureOf(operation: () => unknown): DashboardError {
    try {
        operation();
    } catch (error) {
        if (error instanceof DashboardError) return error;
        throw new Error(`Expected a DashboardError, received ${String(error)}`);
    }
    throw new Error('Expected the call to throw, but it completed normally.');
}

// Records `<id>:setup` / `<id>:cleanup` around an optional body. `body` may do
// registration work and may return the plugin's cleanup; the wrapper keeps the
// log uniform whether or not a cleanup was registered.
function lifecyclePlugin(
    log: string[],
    id: string,
    body?: (api: DashboardPluginAPI) => (() => void) | void,
    requires: readonly string[] = []
): DashboardPlugin {
    return {
        id,
        requires,
        setup: (api) => {
            log.push(`${id}:setup`);
            const cleanup = body ? body(api) : undefined;
            if (typeof cleanup !== 'function') return undefined;
            return () => {
                log.push(`${id}:cleanup`);
                cleanup();
            };
        },
    };
}

describe('setup and cleanup ordering', () => {
    it('runs each setup once, in dependency order, and cleans up in reverse', () => {
        const log: string[] = [];
        const instance = dashboard({
            plugins: [
                lifecyclePlugin(log, 'app', () => () => undefined, ['util']),
                lifecyclePlugin(log, 'util', () => () => undefined),
            ],
        });
        expect(instance.plugins).toEqual(['util', 'app']);
        expect(log).toEqual(['util:setup', 'app:setup']);

        instance.dispose();
        expect(log).toEqual(['util:setup', 'app:setup', 'app:cleanup', 'util:cleanup']);
    });

    it('skips plugins that registered no cleanup', () => {
        const log: string[] = [];
        const plain: DashboardPlugin = { id: 'plain', setup: () => { log.push('plain:setup'); } };
        const instance = dashboard({ plugins: [plain, lifecyclePlugin(log, 'cleanable', () => () => undefined)] });

        instance.dispose();
        expect(log).toEqual(['plain:setup', 'cleanable:setup', 'cleanable:cleanup']);
    });

    it('lets a cleanup read state, run commands and use the dashboard while it works', () => {
        const log: string[] = [];
        let instance!: Dashboard;

        const writer = lifecyclePlugin(log, 'writer', (api) => {
            const cell = api.state('count', 0);
            api.command('flush', () => `flushed:${cell.get()}`);
            return () => {
                // The 'disposing' phase keeps every registry reachable on purpose:
                // teardown has to be able to persist what it collected.
                cell.set((previous) => previous + 1);
                log.push(`cleanup-state:${cell.get()}`);
                log.push(`cleanup-command:${api.execute<void, string>('flush')}`);
                log.push(`dashboard-state:${instance.state<number>('count').get()}`);
            };
        });

        instance = dashboard({ plugins: [writer] });
        instance.dispose();

        expect(log).toEqual([
            'writer:setup',
            'writer:cleanup',
            'cleanup-state:1',
            'cleanup-command:flushed:1',
            'dashboard-state:1',
        ]);
        expect(instance.disposed).toBe(true);
    });
});

describe('setup failure and rollback', () => {
    it('cleans the plugins that already started, in reverse order, when a later setup throws', () => {
        const log: string[] = [];
        const failure = new Error('provider unavailable');

        const error = failureOf(() => dashboard({
            plugins: [
                lifecyclePlugin(log, 'a', () => () => undefined),
                lifecyclePlugin(log, 'b', () => () => undefined),
                lifecyclePlugin(log, 'c', () => { throw failure; }),
            ],
        }));

        expect(error.code).toBe('setup-failed');
        expect(error.cause).toBe(failure);
        expect(error.errors.length).toBe(0);
        expect(log).toEqual(['a:setup', 'b:setup', 'c:setup', 'b:cleanup', 'a:cleanup']);
    });

    it('keeps rollback cleanup failures on the setup error instead of masking the original throw', () => {
        const log: string[] = [];
        const original = new Error('setup blew up');
        const rollbackFailure = new Error('cleanup blew up');

        const error = failureOf(() => dashboard({
            plugins: [
                lifecyclePlugin(log, 'a', () => () => { throw rollbackFailure; }),
                { id: 'b', setup: () => { throw original; } },
            ],
        }));

        expect(error.code).toBe('setup-failed');
        expect(error.cause).toBe(original);
        expect(error.errors.length).toBe(1);
        expect(error.errors[0]).toBe(rollbackFailure);
        expect(log).toEqual(['a:setup', 'a:cleanup']);
    });

    it('detaches cells captured by a plugin when the build is discarded', () => {
        let cell!: DashboardState<number>;
        const failure = new Error('second plugin failed');

        const error = failureOf(() => dashboard({
            plugins: [
                { id: 'owner', setup: (api) => { cell = api.state('count', 3); } },
                { id: 'breaker', requires: ['owner'], setup: () => { throw failure; } },
            ],
        }));

        expect(error.code).toBe('setup-failed');
        // Nothing escaped the discarded build, so a retained cell is dead rather
        // than silently stale.
        expect(failureOf(() => cell.get()).code).toBe('disposed');
        expect(failureOf(() => cell.set(4)).code).toBe('disposed');
        expect(failureOf(() => cell.subscribe(() => undefined)).code).toBe('disposed');
    });

    it('rolls back as a disposal: runtime work stays legal, registrations do not, and failures still aggregate', () => {
        const log: string[] = [];
        const attempts: Array<{ name: string; code: string }> = [];
        let failedApi!: DashboardPluginAPI;
        let firstCell!: DashboardState<number>;
        const setupFailure = new Error('breaker threw');
        const cleanupFailure = new Error('first cleanup threw');

        const first: DashboardPlugin = {
            id: 'first',
            setup: (api) => {
                log.push('first:setup');
                firstCell = api.state('first.count', 1);
                api.service('first.config', { mode: 'test' });
                api.command('first.ping', () => 'pong');
                api.on('first.tick', () => { log.push('first:listener'); });

                return () => {
                    log.push('first:cleanup-start');
                    // Records the outcome instead of throwing, so one cleanup can
                    // observe every rule at once.
                    const attempt = (name: string, run: () => unknown): void => {
                        try {
                            run();
                            attempts.push({ name, code: 'ok' });
                        } catch (error) {
                            attempts.push({ name, code: error instanceof DashboardError ? error.code : 'other' });
                        }
                    };

                    // Rolling back a build is a disposal, so a plugin may still
                    // flush: state, services, commands and events all work.
                    attempt('read-state', () => firstCell.get());
                    attempt('write-state', () => firstCell.set(2));
                    attempt('read-service', () => api.getService('first.config'));
                    attempt('run-command', () => api.execute('first.ping'));
                    attempt('emit-event', () => api.emit('first.tick'));

                    // What it may no longer do is register — including through the
                    // handle of the plugin whose setup() just failed, whose
                    // authorization was cleared before the rollback began.
                    attempt('register-own-state', () => api.state('late.own', 1));
                    attempt('register-failed-state', () => failedApi.state('late.other', 1));
                    attempt('register-failed-service', () => failedApi.service('late.other', 1));
                    attempt('register-failed-command', () => failedApi.command('late.other', () => undefined));
                    attempt('register-failed-slot', () => failedApi.slot('late.other', { id: 'x', value: 1 }));
                    log.push('first:cleanup-end');

                    throw cleanupFailure;
                };
            },
        };

        // Succeeds, and proves reverse order by cleaning up BEFORE `first`.
        const second: DashboardPlugin = {
            id: 'second',
            requires: ['first'],
            setup: () => {
                log.push('second:setup');
                return () => { log.push('second:cleanup'); };
            },
        };

        // Captures its own api, then fails: its handle must not be able to register
        // during the rollback it triggers.
        const breaker: DashboardPlugin = {
            id: 'breaker',
            requires: ['second'],
            setup: (api) => {
                log.push('breaker:setup');
                failedApi = api;
                throw setupFailure;
            },
        };

        const error = failureOf(() => dashboard({ plugins: [first, second, breaker] }));

        // The original throw wins the `cause` slot; the cleanup failure is kept in
        // `errors` instead of being allowed to mask it.
        expect(error.code).toBe('setup-failed');
        expect(error.cause).toBe(setupFailure);
        expect(error.errors.length).toBe(1);
        expect(error.errors[0]).toBe(cleanupFailure);

        expect(log).toEqual([
            'first:setup', 'second:setup', 'breaker:setup',
            'second:cleanup',
            'first:cleanup-start', 'first:listener', 'first:cleanup-end',
        ]);

        expect(attempts).toEqual([
            { name: 'read-state', code: 'ok' },
            { name: 'write-state', code: 'ok' },
            { name: 'read-service', code: 'ok' },
            { name: 'run-command', code: 'ok' },
            { name: 'emit-event', code: 'ok' },
            { name: 'register-own-state', code: 'registration-out-of-scope' },
            { name: 'register-failed-state', code: 'registration-out-of-scope' },
            { name: 'register-failed-service', code: 'registration-out-of-scope' },
            { name: 'register-failed-command', code: 'registration-out-of-scope' },
            { name: 'register-failed-slot', code: 'registration-out-of-scope' },
        ]);

        // Terminal state: the discarded build is fully disposed afterwards, so the
        // cell that was still writable during rollback is dead now.
        expect(failureOf(() => firstCell.get()).code).toBe('disposed');
        expect(failureOf(() => firstCell.subscribe(() => undefined)).code).toBe('disposed');
    });

    it('reports invalid-cleanup with no cause and the rollback failures in errors', () => {
        const log: string[] = [];
        const rollbackFailure = new Error('predecessor cleanup failed');

        const error = failureOf(() => dashboard({
            plugins: [
                lifecyclePlugin(log, 'predecessor', () => () => { throw rollbackFailure; }),
                { id: 'offender', setup: () => 'not-a-cleanup' as unknown as void },
            ],
        }));

        // No plugin threw here, so there is no underlying error to carry; the
        // rollback failure rides in `errors` (the same aggregation channel as
        // setup-failed).
        expect(error.code).toBe('invalid-cleanup');
        expect(error.cause).toBeUndefined();
        expect(error.errors.length).toBe(1);
        expect(error.errors[0]).toBe(rollbackFailure);
        expect(log).toEqual(['predecessor:setup', 'predecessor:cleanup']);
    });

    it('rejects a setup return value that is neither void nor a function', () => {
        const offenders: Array<{ label: string; plugin: DashboardPlugin }> = [
            // `async setup()` does not satisfy `void | (() => void)`, so the cast
            // stands in for a plugin that hands back a promise anyway.
            { label: 'promise', plugin: { id: 'offender', setup: async () => undefined } as unknown as DashboardPlugin },
            { label: 'string', plugin: { id: 'offender', setup: () => 'not-a-cleanup' as unknown as void } as DashboardPlugin },
        ];

        const observed: Array<{ label: string; code: DashboardErrorCode }> = [];
        let index = 0;
        while (index < offenders.length) {
            const log: string[] = [];
            const error = failureOf(() => dashboard({
                plugins: [lifecyclePlugin(log, 'predecessor', () => () => undefined), offenders[index].plugin],
            }));
            observed.push({ label: offenders[index].label, code: error.code });
            // The already-set-up plugin is rolled back just like on a throw.
            expect(log).toEqual(['predecessor:setup', 'predecessor:cleanup']);
            index += 1;
        }

        expect(observed).toEqual([
            { label: 'promise', code: 'invalid-cleanup' },
            { label: 'string', code: 'invalid-cleanup' },
        ]);
    });
});

describe('disposal', () => {
    it('runs every cleanup even when several throw, then reports the aggregate', () => {
        const log: string[] = [];
        const firstFailure = new Error('a could not close');
        const lastFailure = new Error('c could not close');

        const instance = dashboard({
            plugins: [
                lifecyclePlugin(log, 'a', () => () => { throw firstFailure; }),
                lifecyclePlugin(log, 'b', () => () => undefined),
                lifecyclePlugin(log, 'c', () => () => { throw lastFailure; }),
            ],
        });

        const error = failureOf(() => instance.dispose());
        expect(error.code).toBe('cleanup-failed');
        // Reverse order means c fails first; cause is the first failure collected
        // and errors keeps both.
        expect(error.cause).toBe(lastFailure);
        expect(error.errors.length).toBe(2);
        expect(error.errors[0]).toBe(lastFailure);
        expect(error.errors[1]).toBe(firstFailure);
        expect(log).toEqual([
            'a:setup', 'b:setup', 'c:setup',
            'c:cleanup', 'b:cleanup', 'a:cleanup',
        ]);
        expect(instance.disposed).toBe(true);

        // A dispose() that threw still leaves the dashboard observably disposed:
        // the retry is a no-op and does not replay any cleanup.
        expect(instance.dispose()).toBeUndefined();
        expect(log).toEqual([
            'a:setup', 'b:setup', 'c:setup',
            'c:cleanup', 'b:cleanup', 'a:cleanup',
        ]);
    });

    it('ignores a dispose() issued from inside a cleanup', () => {
        const log: string[] = [];
        let instance!: Dashboard;

        const disposer = lifecyclePlugin(log, 'disposer', () => () => {
            log.push('disposer:inner-dispose');
            instance.dispose();
        });

        instance = dashboard({ plugins: [lifecyclePlugin(log, 'worker', () => () => undefined), disposer] });
        expect(instance.dispose()).toBeUndefined();

        // The re-entrant call returns immediately, so `worker` is cleaned exactly
        // once, by the original teardown.
        expect(log).toEqual([
            'worker:setup', 'disposer:setup',
            'disposer:cleanup', 'disposer:inner-dispose', 'worker:cleanup',
        ]);
    });

    it('fails every post-dispose operation with the same code', () => {
        const instance = dashboard({
            plugins: [{
                id: 'registry',
                setup: (api) => {
                    api.state('count', 0);
                    api.service('client', { baseUrl: 'http://localhost:5500' });
                    api.command('ping', () => 'pong');
                    api.slot('rails', { id: 'nav', value: 'navigation' });
                },
            }],
        });
        instance.dispose();

        const operations: Array<{ name: string; run: () => unknown }> = [
            { name: 'state', run: () => instance.state('count') },
            { name: 'service', run: () => instance.service('client') },
            { name: 'execute', run: () => instance.execute('ping') },
            { name: 'on', run: () => instance.on('later', () => undefined) },
            { name: 'emit', run: () => instance.emit('later') },
            { name: 'slot', run: () => instance.slot('rails') },
        ];

        const observed: Array<{ name: string; code: DashboardErrorCode }> = [];
        let index = 0;
        while (index < operations.length) {
            observed.push({ name: operations[index].name, code: failureOf(operations[index].run).code });
            index += 1;
        }
        expect(observed).toEqual([
            { name: 'state', code: 'disposed' },
            { name: 'service', code: 'disposed' },
            { name: 'execute', code: 'disposed' },
            { name: 'on', code: 'disposed' },
            { name: 'emit', code: 'disposed' },
            { name: 'slot', code: 'disposed' },
        ]);
    });

    it('keeps outstanding unsubscribe handles harmless after disposal', () => {
        const seen: string[] = [];
        let stateUnsubscribe!: () => void;
        let eventUnsubscribe!: () => void;

        const instance = dashboard({
            plugins: [{
                id: 'subscriber',
                setup: (api) => {
                    const cell = api.state('count', 0);
                    stateUnsubscribe = cell.subscribe(() => { seen.push('state'); });
                    eventUnsubscribe = api.on('tick', () => { seen.push('event'); });
                },
            }],
        });

        instance.dispose();

        expect(stateUnsubscribe()).toBeUndefined();
        expect(stateUnsubscribe()).toBeUndefined();
        expect(eventUnsubscribe()).toBeUndefined();
        expect(seen).toEqual([]);
    });

    it('disposes an empty dashboard repeatedly', () => {
        const instance = dashboard();
        expect(instance.dispose()).toBeUndefined();
        expect(instance.dispose()).toBeUndefined();
        expect(instance.disposed).toBe(true);
    });
});

describe('registration scope', () => {
    it('rejects registrations made after the owning plugin finished setting up', () => {
        let api!: DashboardPluginAPI;
        const instance = dashboard({
            plugins: [{ id: 'keeper', setup: (received) => { api = received; } }],
        });

        const attempts: Array<{ name: string; run: () => unknown }> = [
            { name: 'api.state', run: () => api.state('late', 1) },
            { name: 'api.service', run: () => api.service('late', 1) },
            { name: 'api.command', run: () => api.command('late', () => undefined) },
            { name: 'api.slot', run: () => api.slot('late', { id: 'x', value: 1 }) },
        ];

        const observed: Array<{ name: string; code: DashboardErrorCode }> = [];
        let index = 0;
        while (index < attempts.length) {
            observed.push({ name: attempts[index].name, code: failureOf(attempts[index].run).code });
            index += 1;
        }
        expect(observed).toEqual([
            { name: 'api.state', code: 'registration-out-of-scope' },
            { name: 'api.service', code: 'registration-out-of-scope' },
            { name: 'api.command', code: 'registration-out-of-scope' },
            { name: 'api.slot', code: 'registration-out-of-scope' },
        ]);

        // Nothing partial was written by the rejected calls.
        expect(failureOf(() => instance.state('late')).code).toBe('unknown-state');
        expect(failureOf(() => instance.service('late')).code).toBe('unknown-service');
        expect(failureOf(() => instance.execute('late')).code).toBe('unknown-command');
        expect(instance.slot('late')).toEqual([]);
    });

    it('keeps reads, commands, emits and subscriptions legal for a retained api', () => {
        let api!: DashboardPluginAPI;
        const log: string[] = [];

        const provider: DashboardPlugin = {
            id: 'provider',
            setup: (received) => {
                received.service('config', { label: 'underload' });
                received.command('ping', () => 'pong');
                received.on<string>('hello', (value) => { log.push(`provider:${value}`); });
            },
        };
        // Declared first and without a requires edge: legality here comes from
        // runtime timing (the calls happen after dashboard() returned), not from
        // setup ordering.
        const keeper: DashboardPlugin = {
            id: 'keeper',
            setup: (received) => { api = received; },
        };

        const instance = dashboard({ plugins: [keeper, provider] });

        expect(api.getService<{ label: string }>('config')).toEqual({ label: 'underload' });
        expect(api.execute<void, string>('ping')).toBe('pong');
        const unsubscribe = api.on<string>('hello', (value) => { log.push(`keeper:${value}`); });
        expect(instance.emit('hello', 'world')).toBeUndefined();
        unsubscribe();
        instance.emit('hello', 'ignored');

        // provider subscribed during its setup (before the build finished), keeper
        // only afterwards, so provider is first in the delivery order. The second
        // emit still reaches provider: unsubscribing one handle never touches the
        // other plugin's subscription.
        expect(log).toEqual(['provider:world', 'keeper:world', 'provider:ignored']);
    });

    it('reports disposal, not scope, when a retained api registers after dispose', () => {
        let api!: DashboardPluginAPI;
        const instance = dashboard({ plugins: [{ id: 'keeper', setup: (received) => { api = received; } }] });
        instance.dispose();

        expect(failureOf(() => api.state('after', 1)).code).toBe('disposed');
        expect(failureOf(() => api.slot('after', { id: 'x', value: 1 })).code).toBe('disposed');
        expect(failureOf(() => api.emit('after')).code).toBe('disposed');
    });

    it('rejects a registration made by one plugin through another plugin api handle', () => {
        const log: string[] = [];
        let first!: DashboardPluginAPI;

        const owner: DashboardPlugin = {
            id: 'owner',
            setup: (api) => {
                first = api;
                log.push('owner:setup');
            },
        };
        // `guest` runs after `owner`, so owner's handle is out of scope and its
        // registration must not be attributed to guest.
        const guest: DashboardPlugin = {
            id: 'guest',
            requires: ['owner'],
            setup: (api) => {
                log.push('guest:setup');
                expect(failureOf(() => first.service('stale', 1)).code).toBe('registration-out-of-scope');
                expect(api.state('mine', 1).get()).toBe(1);
            },
        };

        const instance = dashboard({ plugins: [owner, guest] });
        expect(log).toEqual(['owner:setup', 'guest:setup']);
        expect(instance.state<number>('mine').get()).toBe(1);
    });
});
