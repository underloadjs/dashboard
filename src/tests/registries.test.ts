// Service, command and slot registry semantics.
//
// Contract pinned here (see ../extensions/registries.ts):
//   - services publish a value by id, stored and returned by reference; an
//     `undefined` value is still a published service
//   - commands are named actions whose return value (promise included) reaches
//     the caller untouched, so async work stays async and errors stay unwrapped
//   - slots are open named channels: no declaration, no dropping of unknown
//     names, duplicate contribution ids rejected per slot only, and the public
//     snapshot is sorted by order (default 0) then registration order and frozen
//   - every registry failure raised during setup surfaces as 'setup-failed' with
//     the registry error as its cause (../dashboard.ts owns that wrapping)
//
// Cross-references: ./plugins.test.ts (dependency ordering that makes a
// getService call legal during setup), ./lifecycle.test.ts (post-dispose reads).

import { describe, expect, it } from 'vitest';

import { DashboardError, dashboard } from '../dashboard';
import type { Dashboard, DashboardContribution, DashboardPlugin, DashboardPluginAPI } from '../types';
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

// Registration problems are raised inside a plugin's setup(), so the observable
// failure of dashboard() is 'setup-failed' wrapping the registry error. Unwrapping
// here keeps each case focused on the code it actually pins.
function registrationFailure(plugin: DashboardPlugin): DashboardError {
    const error = failureOf(() => dashboard({ plugins: [plugin] }));
    expect(error.code).toBe('setup-failed');
    const cause = error.cause;
    if (!(cause instanceof DashboardError)) {
        throw new Error(`Expected a DashboardError cause, received ${String(cause)}`);
    }
    return cause;
}

function pluginWith(id: string, body: (api: DashboardPluginAPI) => void): DashboardPlugin {
    return { id, setup: body };
}

describe('services', () => {
    it('publishes a value that the dashboard reads back by reference', () => {
        const client = { baseUrl: 'http://localhost:5500', retry: 2 };
        const instance = dashboard({
            plugins: [pluginWith('provider', (api) => { api.service('transport', client); })],
        });

        expect(instance.service<{ baseUrl: string; retry: number }>('transport')).toBe(client);
        expect(instance.service<{ baseUrl: string; retry: number }>('transport')).toEqual({
            baseUrl: 'http://localhost:5500',
            retry: 2,
        });
    });

    it('treats an undefined value as a published service, not a missing one', () => {
        const instance = dashboard({
            plugins: [pluginWith('provider', (api) => { api.service<string | undefined>('maybe', undefined); })],
        });

        expect(instance.service<string | undefined>('maybe')).toBeUndefined();
    });

    it('only resolves for a consumer whose requires edge was set up first', () => {
        const provider: DashboardPlugin = {
            id: 'provider',
            setup: (api) => { api.service('client', 'ready'); },
        };
        const consumer: DashboardPlugin = {
            id: 'consumer',
            requires: ['provider'],
            setup: (api) => { api.service('seen', api.getService<string>('client')); },
        };

        const instance = dashboard({ plugins: [consumer, provider] });
        expect(instance.plugins).toEqual(['provider', 'consumer']);
        expect(instance.service<string>('seen')).toBe('ready');
    });

    it('fails a setup-time read that has no ordering guarantee', () => {
        const provider: DashboardPlugin = {
            id: 'provider',
            setup: (api) => { api.service('client', 'ready'); },
        };
        // No requires edge and declared first, so the service simply does not exist yet.
        const eager: DashboardPlugin = {
            id: 'eager',
            setup: (api) => { api.getService('client'); },
        };

        const error = failureOf(() => dashboard({ plugins: [eager, provider] }));
        expect(error.code).toBe('setup-failed');
        expect((error.cause as DashboardError).code).toBe('unknown-service');
    });

    it('rejects a duplicate provider and names both plugins', () => {
        const first = pluginWith('one', (api) => { api.service('shared', 1); });
        const second = pluginWith('two', (api) => { api.service('shared', 2); });
        const error = failureOf(() => dashboard({ plugins: [first, second] }));

        expect(error.code).toBe('setup-failed');
        expect((error.cause as DashboardError).code).toBe('duplicate-service');
        expect((error.cause as DashboardError).message).toContain('plugin "one"');
        expect((error.cause as DashboardError).message).toContain('plugin "two"');
    });

    it('rejects an unknown id at the read site and a malformed id at the write site', () => {
        const instance = dashboard({ plugins: [pluginWith('one', (api) => { api.service('real', 1); })] });
        expect(failureOf(() => instance.service('ghost')).code).toBe('unknown-service');
        expect(registrationFailure(pluginWith('one', (api) => { api.service('', 1); })).code).toBe('invalid-identifier');
    });
});

describe('commands', () => {
    it('passes the exact input in and the exact output back', () => {
        const received: number[] = [];
        const instance = dashboard({
            plugins: [pluginWith('math', (api) => {
                api.command<number, number>('double', (value) => {
                    received.push(value);
                    return value * 2;
                });
            })],
        });

        expect(instance.execute<number, number>('double', 21)).toBe(42);
        expect(instance.execute<number, number>('double', 5)).toBe(10);
        expect(received).toEqual([21, 5]);
    });

    it('supports commands with no input', () => {
        const seen: unknown[] = [];
        const instance = dashboard({
            plugins: [pluginWith('health', (api) => {
                api.command('ping', (input) => {
                    seen.push(input);
                    return 'pong';
                });
            })],
        });

        expect(instance.execute<void, string>('ping')).toBe('pong');
        expect(seen).toEqual([undefined]);
    });

    it('hands a promise-returning handler straight to the caller', async () => {
        let created: Promise<string> | undefined;
        const instance = dashboard({
            plugins: [pluginWith('data', (api) => {
                api.command<void, Promise<string>>('load', () => {
                    created = Promise.resolve('loaded');
                    return created;
                });
            })],
        });

        const returned = instance.execute<void, Promise<string>>('load');
        // Identity preserved: no await, no re-wrapping, so the caller keeps the
        // handler's own promise (chainable, cancelable, identifiable).
        expect(returned).toBe(created as Promise<string>);
        expect(await returned).toBe('loaded');
    });

    it('keeps a rejected promise unwrapped', async () => {
        const rejection = new Error('transport down');
        const instance = dashboard({
            plugins: [pluginWith('data', (api) => {
                api.command<void, Promise<string>>('load', () => Promise.reject(rejection));
            })],
        });

        const returned = instance.execute<void, Promise<string>>('load');
        let caught: unknown;
        try {
            await returned;
        } catch (error) {
            caught = error;
        }
        expect(caught).toBe(rejection);
    });

    it('propagates a synchronous handler throw unchanged', () => {
        const boom = new Error('handler failed');
        const instance = dashboard({
            plugins: [pluginWith('fragile', (api) => {
                api.command('explode', () => { throw boom; });
            })],
        });

        let caught: unknown;
        try {
            instance.execute('explode');
        } catch (error) {
            caught = error;
        }
        expect(caught).toBe(boom);
        expect(caught instanceof DashboardError).toBe(false);
    });

    it('is callable from another plugin during setup and at runtime through the api', () => {
        const log: string[] = [];
        const provider: DashboardPlugin = {
            id: 'provider',
            requires: ['caller'],
            setup: (api) => {
                api.command('who', () => 'provider');
                log.push(`caller-said:${api.execute<void, string>('ask')}`);
            },
        };
        const caller: DashboardPlugin = {
            id: 'caller',
            setup: (api) => {
                api.command('ask', () => 'caller');
            },
        };

        dashboard({ plugins: [provider, caller] });
        // caller runs first (provider requires it), so the ask command exists.
        expect(log).toEqual(['caller-said:caller']);
    });

    it('rejects an unknown command at the call site and a malformed one at the registration site', () => {
        const instance = dashboard({ plugins: [pluginWith('one', (api) => { api.command('run', () => undefined); })] });
        const unknown = failureOf(() => instance.execute('ghost'));
        expect(unknown.code).toBe('unknown-command');
        expect(unknown.message).toContain('ghost');

        expect(registrationFailure(pluginWith('one', (api) => { api.command('', () => undefined); })).code).toBe('invalid-identifier');
        expect(registrationFailure(pluginWith('one', (api) => { api.command('bad', 'not-a-function' as never); })).code).toBe('invalid-handler');
    });

    it('rejects a duplicate command id and names both owners', () => {
        const first = pluginWith('one', (api) => { api.command('run', () => 'first'); });
        const second = pluginWith('two', (api) => { api.command('run', () => 'second'); });
        const error = failureOf(() => dashboard({ plugins: [first, second] }));

        expect(error.code).toBe('setup-failed');
        expect((error.cause as DashboardError).code).toBe('duplicate-command');
        expect((error.cause as DashboardError).message).toContain('plugin "one"');
        expect((error.cause as DashboardError).message).toContain('plugin "two"');
    });
});

type Rail = { label: string };

describe('slots', () => {
    // Two plugins contribute to one open channel; the expected result is the full
    // sorted snapshot, asserted object by object.
    function railDashboard(): Dashboard {
        const left = pluginWith('left', (api) => {
            api.slot<Rail>('rails', { id: 'a', order: -10, value: { label: 'first' } });
            api.slot<Rail>('rails', { id: 'b', value: { label: 'second' } }); // order defaults to 0
            api.slot<Rail>('rails', { id: 'c', order: 5, value: { label: 'third' } });
        });
        const right = pluginWith('right', (api) => {
            api.slot<Rail>('rails', { id: 'd', order: 0, value: { label: 'fourth' } });
            api.slot<Rail>('rails', { id: 'e', order: 0, value: { label: 'fifth' } });
        });
        return dashboard({ plugins: [left, right] });
    }

    it('sorts by order then by registration order, with a default order of 0', () => {
        const instance = railDashboard();
        const contributions = instance.slot<Rail>('rails');

        expect(contributions.length).toBe(5);
        expect(contributions.map((item) => item.id)).toEqual(['a', 'b', 'd', 'e', 'c']);
        expect(contributions.slice()).toEqual([
            { slot: 'rails', id: 'a', order: -10, value: { label: 'first' } },
            { slot: 'rails', id: 'b', order: 0, value: { label: 'second' } },
            { slot: 'rails', id: 'd', order: 0, value: { label: 'fourth' } },
            { slot: 'rails', id: 'e', order: 0, value: { label: 'fifth' } },
            { slot: 'rails', id: 'c', order: 5, value: { label: 'third' } },
        ]);
    });

    it('keeps the contributed value opaque and by reference', () => {
        const payload = { kind: 'composer', props: { placeholder: 'Ask anything' } };
        const instance = dashboard({
            plugins: [pluginWith('composer', (api) => { api.slot('panels', { id: 'input', value: payload }); })],
        });

        const contributions: readonly DashboardContribution<typeof payload>[] = instance.slot('panels');
        expect(contributions.length).toBe(1);
        expect(contributions[0].value).toBe(payload);
        expect(contributions[0]).toEqual({
            slot: 'panels',
            id: 'input',
            order: 0,
            value: { kind: 'composer', props: { placeholder: 'Ask anything' } },
        });
    });

    it('returns a frozen, identity-stable snapshot per slot', () => {
        const instance = railDashboard();
        const firstRead = instance.slot<Rail>('rails');
        const secondRead = instance.slot<Rail>('rails');

        expect(firstRead).toBe(secondRead);
        expect(Object.isFrozen(firstRead)).toBe(true);
        expect(Object.isFrozen(firstRead[0])).toBe(true);
        // A host that copies the snapshot still gets the same content.
        expect(firstRead.slice().map((item) => item.order)).toEqual([-10, 0, 0, 0, 5]);
    });

    it('treats slot names as open: unknown names are empty, never an error', () => {
        const instance = railDashboard();
        const missing = instance.slot<Rail>('nothing.registered.here');

        expect(missing).toEqual([]);
        expect(missing.length).toBe(0);
        expect(instance.slot<Rail>('nothing.registered.here')).toBe(missing);
    });

    it('scopes contribution ids to one slot, so the same id may appear in another', () => {
        const instance = dashboard({
            plugins: [pluginWith('dual', (api) => {
                api.slot<string>('rails', { id: 'shared', value: 'rail-entry' });
                api.slot<string>('panels', { id: 'shared', value: 'panel-entry' });
            })],
        });

        expect(instance.slot<string>('rails')).toEqual([{ slot: 'rails', id: 'shared', order: 0, value: 'rail-entry' }]);
        expect(instance.slot<string>('panels')).toEqual([{ slot: 'panels', id: 'shared', order: 0, value: 'panel-entry' }]);
    });

    it('rejects a duplicate contribution id inside one slot and names both owners', () => {
        const first = pluginWith('one', (api) => { api.slot<string>('rails', { id: 'dup', value: 'kept' }); });
        const second = pluginWith('two', (api) => { api.slot<string>('rails', { id: 'dup', value: 'rejected' }); });
        const error = failureOf(() => dashboard({ plugins: [first, second] }));

        expect(error.code).toBe('setup-failed');
        expect((error.cause as DashboardError).code).toBe('duplicate-contribution');
        expect((error.cause as DashboardError).message).toContain('rails');
        expect((error.cause as DashboardError).message).toContain('dup');
    });

    it('rejects malformed contribution records instead of sorting them unpredictably', () => {
        const cases: Array<[string, (api: DashboardPluginAPI) => void]> = [
            ['not-an-object', (api) => { api.slot('rails', null as never); }],
            ['missing-id', (api) => { api.slot('rails', { value: 'x' } as never); }],
            ['empty-id', (api) => { api.slot('rails', { id: '', value: 'x' }); }],
            ['nan-order', (api) => { api.slot('rails', { id: 'x', order: Number.NaN, value: 'x' }); }],
            ['infinite-order', (api) => { api.slot('rails', { id: 'x', order: Number.POSITIVE_INFINITY, value: 'x' }); }],
            ['string-order', (api) => { api.slot('rails', { id: 'x', order: '1' as never, value: 'x' }); }],
        ];

        const observed: Array<{ case: string; code: DashboardErrorCode }> = [];
        let index = 0;
        while (index < cases.length) {
            observed.push({ case: cases[index][0], code: registrationFailure(pluginWith('author', cases[index][1])).code });
            index += 1;
        }
        expect(observed).toEqual([
            { case: 'not-an-object', code: 'invalid-contribution' },
            { case: 'missing-id', code: 'invalid-contribution' },
            { case: 'empty-id', code: 'invalid-contribution' },
            { case: 'nan-order', code: 'invalid-contribution' },
            { case: 'infinite-order', code: 'invalid-contribution' },
            { case: 'string-order', code: 'invalid-contribution' },
        ]);
    });

    it('rejects an empty slot name', () => {
        expect(registrationFailure(pluginWith('author', (api) => { api.slot('', { id: 'x', value: 'v' }); })).code).toBe('invalid-identifier');
    });
});
