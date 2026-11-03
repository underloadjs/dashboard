// The dashboard factory: validate -> schedule -> set up -> run -> dispose.
//
// This module owns the lifecycle contract; the registries it wires together
// (./state.ts, ./bus.ts, ./registries.ts) are deliberately lifecycle-blind and
// only know about ids. Everything that can fail after this point is either a
// registry lookup or the plugin's own code.
//
// Cross-references:
//   - ./order.ts     — everything that is rejected before the first setup() call
//   - ./errors.ts    — the code each guard below throws
//   - ./index.ts     — public barrel (dashboard + DashboardError + types)

import { describeValue, fail } from './errors';
import { orderPlugins, readPlugins } from './order';
import { StateRegistry } from './state';
import { EventBus } from './bus';
import { CommandRegistry, ServiceRegistry, SlotRegistry } from './registries';
import type { CommandHandler } from './registries';
import type {
    Dashboard,
    DashboardContribution,
    DashboardContributionInput,
    DashboardOptions,
    DashboardPluginAPI,
    DashboardState,
} from './types';

// 'configuring' — some plugin's setup() is on the stack. dashboard() has not
//                 returned yet, so the host cannot reach the instance (and its
//                 dispose()) at all during this phase.
// 'ready'       — every plugin set up, dashboard fully live
// 'disposing'   — cleanups are running: both dispose() and the rollback of a
//                 failed build enter this phase first. Reads/commands/emits stay
//                 legal so a teardown can flush state or persist a value, but no
//                 setup registration is accepted anywhere (the failing plugin's
//                 retained api included).
// 'disposed'    — final; every operation except unsubscribe/idempotent dispose fails
type Phase = 'configuring' | 'ready' | 'disposing' | 'disposed';

export function dashboard(options?: DashboardOptions): Dashboard {
    const declared = readPlugins(options);
    // Full graph validation happens here: an invalid plugin list throws before a
    // single setup() runs, so no plugin ever observes a half-built dashboard.
    const ordered = orderPlugins(declared);

    const states = new StateRegistry();
    const services = new ServiceRegistry();
    const commands = new CommandRegistry();
    const slots = new SlotRegistry();
    const bus = new EventBus();

    let phase: Phase = 'configuring';
    // The only plugin currently allowed to register; null between setups. This
    // is what turns a late api.state()/api.command() into a loud error instead
    // of a registration whose owner can never tear it down.
    let activePlugin: string | null = null;

    const cleanups: Array<(() => void) | null> = [];
    const started: string[] = [];

    const guardDisposed = (): void => {
        if (phase === 'disposed') {
            fail('disposed',
                'This dashboard has been disposed: its state, services, commands, slots and listeners are gone. ' +
                'Build a new one with dashboard().');
        }
    };

    // Disposal failures win over scope failures: after dispose() the honest
    // message is "gone", not "wrong place".
    const guardRegistration = (operation: string, pluginId: string): void => {
        guardDisposed();
        if (phase !== 'configuring' || activePlugin !== pluginId) {
            fail('registration-out-of-scope',
                `${operation} was called outside the setup() of plugin "${pluginId}". Registrations are only legal while ` +
                'the plugin making them is being set up: keep the returned state cell or unsubscribe handle and use those at runtime.');
        }
    };

    // One api object per plugin, created immediately before that plugin's
    // setup(), so ownership (events) and scope (registrations) are exact.
    const createPluginAPI = (pluginId: string): DashboardPluginAPI => ({
        state: <T>(id: string, initial: T): DashboardState<T> => {
            guardRegistration('api.state()', pluginId);
            return states.register(pluginId, id, initial);
        },

        service: <T>(id: string, value: T): void => {
            guardRegistration('api.service()', pluginId);
            services.register(pluginId, id, value);
        },

        // Reads stay legal for the whole lifetime: a command handler or event
        // listener uses getService long after setup finished.
        getService: <T>(id: string): T => {
            guardDisposed();
            return services.get<T>(id);
        },

        command: <Input, Output>(id: string, handler: (input: Input) => Output): void => {
            guardRegistration('api.command()', pluginId);
            commands.register(pluginId, id, handler as CommandHandler);
        },

        execute: <Input, Output>(id: string, input?: Input): Output => {
            guardDisposed();
            // Result handed back untouched (no await, no wrap): a promise-returning
            // handler stays a promise the caller can chain on.
            return commands.get(id)(input) as Output;
        },

        on: <T>(event: string, handler: (payload: T) => void): (() => void) => {
            guardDisposed();
            return bus.subscribe(event, handler as (payload: unknown) => void);
        },

        emit: <T>(event: string, payload?: T): void => {
            guardDisposed();
            bus.emit(event, payload);
        },

        slot: <T>(name: string, contribution: DashboardContributionInput<T>): void => {
            guardRegistration('api.slot()', pluginId);
            slots.register(pluginId, name, contribution as DashboardContributionInput<unknown>);
        },
    });

    // Runs the cleanups of every plugin that finished setup, highest index
    // first (so a consumer is torn down before the provider it depends on),
    // then drops every registry. Cleanup failures are collected, never
    // allowed to stop the remaining teardown.
    const teardown = (upToExclusive: number): unknown[] => {
        const failures: unknown[] = [];

        let index = upToExclusive - 1;
        while (index >= 0) {
            const cleanup = cleanups[index];
            if (cleanup !== null) {
                try {
                    cleanup();
                } catch (error) {
                    failures.push(error);
                }
            }
            index -= 1;
        }

        // Registry teardown happens AFTER the last cleanup: a plugin's teardown
        // is allowed to read state, emit an event, or run a flush command.
        states.detachAll();
        bus.clear();
        services.clear();
        commands.clear();
        slots.clear();

        return failures;
    };

    // ---- setup phase (synchronous, exactly once per plugin) ----
    let index = 0;
    while (index < ordered.length) {
        const plugin = ordered[index];
        const pluginId = plugin.id;
        let returned: unknown;
        let thrown: unknown;
        let failed = false;

        activePlugin = pluginId;
        try {
            returned = plugin.setup(createPluginAPI(pluginId));
        } catch (error) {
            failed = true;
            thrown = error;
        } finally {
            // Registration authorization ends the moment this plugin's setup()
            // leaves the stack, on every path. A handle retained by a plugin (the
            // failing one included) can therefore never register during rollback.
            activePlugin = null;
        }

        // A failed setup() discards the build. The phase transition happens BEFORE
        // the rollback so teardown runs as a disposal rather than as nested
        // configuration: a previously successful plugin's cleanup keeps every
        // runtime operation (state, services, commands, events) while NO setup
        // registration is accepted anywhere, including through the failed plugin's
        // own api handle ('registration-out-of-scope').
        if (failed) {
            phase = 'disposing';
            // Only the plugins that completed setup are rolled back (this one
            // threw, so it never registered a cleanup).
            const rollbackFailures = teardown(index);
            phase = 'disposed';
            fail('setup-failed',
                `Plugin "${pluginId}" threw during setup, so the dashboard was discarded and the ` +
                `${index} plugin(s) already set up were cleaned in reverse order.`,
            { cause: thrown, errors: rollbackFailures });
        }

        if (returned === undefined || returned === null) {
            cleanups[index] = null;
        } else if (typeof returned === 'function') {
            cleanups[index] = returned as () => void;
        } else {
            // A setup() that returns e.g. a Promise is an accidental
            // `async setup()`: the framework is synchronous by contract, so this
            // is reported instead of being silently ignored. Nothing was thrown by
            // plugin code here, so `cause` stays undefined and `errors` carries the
            // rollback cleanup failures (same disposing-first transition as above).
            phase = 'disposing';
            const rollbackFailures = teardown(index);
            phase = 'disposed';
            fail('invalid-cleanup',
                `Plugin "${pluginId}" returned ${describeValue(returned)} from setup(); setup must return void or a ` +
                'cleanup function (async setup() is not supported - run the asynchronous work through a command instead).',
            { errors: rollbackFailures });
        }

        started.push(pluginId);
        index += 1;
    }

    const pluginIds: readonly string[] = Object.freeze(started.slice());
    phase = 'ready';

    // ---- disposal ----
    const dispose = (): void => {
        // Idempotent and re-entrant safe: a cleanup that calls dispose() (or a
        // host that disposes twice) must not replay the teardown.
        if (phase === 'disposing' || phase === 'disposed') return;

        phase = 'disposing';
        const failures = teardown(started.length);
        // Marked disposed BEFORE any throw so the dashboard is observably dead
        // even when the caller reacts to cleanup-failed.
        phase = 'disposed';

        if (failures.length > 0) {
            fail('cleanup-failed',
                `${failures.length} plugin cleanup(s) threw during dispose(); the dashboard is disposed regardless.`,
            { cause: failures[0], errors: failures });
        }
    };

    // ---- public instance ----
    return {
        plugins: pluginIds,

        // Getter, not a captured boolean, so it reflects the live phase.
        get disposed() {
            return phase === 'disposed';
        },

        state: <T>(id: string): DashboardState<T> => {
            guardDisposed();
            return states.get<T>(id);
        },

        service: <T>(id: string): T => {
            guardDisposed();
            return services.get<T>(id);
        },

        execute: <Input, Output>(id: string, input?: Input): Output => {
            guardDisposed();
            return commands.get(id)(input) as Output;
        },

        on: <T>(event: string, handler: (payload: T) => void): (() => void) => {
            guardDisposed();
            return bus.subscribe(event, handler as (payload: unknown) => void);
        },

        emit: <T>(event: string, payload?: T): void => {
            guardDisposed();
            bus.emit(event, payload);
        },

        slot: <T>(name: string): readonly DashboardContribution<T>[] => {
            guardDisposed();
            return slots.read<T>(name);
        },

        dispose,
    };
}
