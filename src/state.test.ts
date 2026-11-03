// State cell semantics.
//
// Contract pinned here (see ./types.ts DashboardState):
//   - api.state() registers a cell in a GLOBAL id space; dashboard.state() hands
//     back the very same object (identity, not a copy)
//   - set() accepts a value or an updater; change detection is reference
//     equality, so immutable updates are required and an equal write is a no-op
//   - subscribe() notifies synchronously in subscription order, the unsubscribe
//     handle is idempotent, and membership changes during a notification only
//     take effect from the next pass
//   - one throwing listener never blocks the others: all listeners run, then one
//     aggregated 'listener-failed' error is raised AFTER the value has landed
//   - the shape is what React's useSyncExternalStore expects (subscribe takes a
//     no-arg callback and returns an unsubscribe; get returns a stable snapshot)
//
// Cross-references: ./state.ts (createState/StateRegistry),
// ./listeners.ts (shared delivery rules), ./lifecycle.test.ts (post-dispose).

import { describe, expect, it } from 'vitest';

import { DashboardError, dashboard } from './index';
import type { DashboardPlugin, DashboardState } from './types';

function failureOf(operation: () => unknown): DashboardError {
    try {
        operation();
    } catch (error) {
        if (error instanceof DashboardError) return error;
        throw new Error(`Expected a DashboardError, received ${String(error)}`);
    }
    throw new Error('Expected the call to throw, but it completed normally.');
}

// Registers `id` with `initial` during setup and exposes the cell the plugin saw.
function statePlugin<T>(pluginId: string, id: string, initial: T): { plugin: DashboardPlugin; cell: () => DashboardState<T> } {
    let cell: DashboardState<T> | undefined;
    const plugin: DashboardPlugin = {
        id: pluginId,
        setup: (api) => {
            cell = api.state(id, initial);
        },
    };
    return { plugin, cell: () => cell as DashboardState<T> };
}

describe('state registration', () => {
    it('hands the identical cell to the plugin and to the dashboard', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', 0);
        const instance = dashboard({ plugins: [plugin] });

        // Identity, not a copy: the plugin and the host share one live cell.
        expect(instance.state<number>('counter')).toBe(cell());
        expect(cell().get()).toBe(0);

        cell().set(4);
        expect(cell().get()).toBe(4);
        expect(instance.state<number>('counter').get()).toBe(4);

        // Reads never invent a new snapshot: what an adapter caches is what it gets.
        const read = instance.state<number>('counter').get;
        expect(read()).toBe(read());
    });

    it('rejects a duplicate id across plugins and names both owners', () => {
        const log: string[] = [];
        const first: DashboardPlugin = { id: 'theme-a', setup: (api) => { void api.state('theme', 'light'); log.push('theme-a'); } };
        const second: DashboardPlugin = { id: 'theme-b', setup: (api) => { void api.state('theme', 'dark'); log.push('theme-b'); } };

        // The duplicate is raised inside the second setup(), so dashboard()
        // reports the discarded build as 'setup-failed' and keeps the registry
        // failure as the cause.
        const error = failureOf(() => dashboard({ plugins: [first, second] }));
        expect(error.code).toBe('setup-failed');
        expect((error.cause as DashboardError).code).toBe('duplicate-state');
        expect((error.cause as DashboardError).message).toContain('plugin "theme-a"');
        expect((error.cause as DashboardError).message).toContain('plugin "theme-b"');
        expect(log).toEqual(['theme-a']);
    });

    it('rejects an unknown state id and an empty id', () => {
        const { plugin } = statePlugin('counter-plugin', 'counter', 0);
        const instance = dashboard({ plugins: [plugin] });

        const unknown = failureOf(() => instance.state('nope'));
        expect(unknown.code).toBe('unknown-state');
        expect(unknown.message).toContain('nope');

        expect(failureOf(() => instance.state('')).code).toBe('invalid-identifier');
    });

    it('keeps state ids global so a plugin can read another plugin cell after setup', () => {
        const owner = statePlugin<number>('owner', 'count', 1);
        const reader: DashboardPlugin = { id: 'reader', requires: ['owner'], setup: () => undefined };
        const instance = dashboard({ plugins: [owner.plugin, reader] });

        // Cells are captured by the host (or handed out as a service); the id
        // space is shared, which is what makes `dashboard.state(id)` work.
        expect(instance.state<number>('count').get()).toBe(1);
    });
});

describe('state writes', () => {
    it('accepts a plain value and an updater, in order', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', 0);
        const seen: number[] = [];
        dashboard({ plugins: [plugin] });

        cell().subscribe(() => seen.push(cell().get()));
        cell().set(7);
        cell().set((previous) => previous + 1);
        cell().set(7);

        expect(cell().get()).toBe(7);
        expect(seen).toEqual([7, 8, 7]);
    });

    it('treats an equal write as no update at all', () => {
        const { plugin, cell } = statePlugin('filter-plugin', 'filter', { query: '', page: 1 });
        let notifications = 0;
        dashboard({ plugins: [plugin] });

        const before = cell().get();
        cell().subscribe(() => { notifications += 1; });

        cell().set(before);
        // In-place mutation plus an equal-reference write stays invisible: the
        // documented consequence of the immutable-update contract.
        const mutated = cell().get();
        mutated.query = 'nope';
        cell().set(mutated);

        expect(notifications).toBe(0);
        expect(cell().get()).toEqual({ query: 'nope', page: 1 });

        cell().set({ query: 'nope', page: 2 });
        expect(notifications).toBe(1);
    });

    it('does not wake listeners when NaN replaces NaN', () => {
        const { plugin, cell } = statePlugin('number-plugin', 'value', Number.NaN);
        const seen: unknown[] = [];
        dashboard({ plugins: [plugin] });

        cell().subscribe(() => seen.push(cell().get()));
        cell().set(Number.NaN);
        cell().set(1);
        cell().set(Number.NaN);

        expect(seen).toEqual([1, Number.NaN]);
    });

    it('treats +0 and -0 as the same value (the documented SameValueZero case)', () => {
        // Object.is would call this a change; SameValueZero (what Set/Map use, and
        // what this contract documents) does not, so no listener is woken.
        const { plugin, cell } = statePlugin('sign-plugin', 'offset', 0);
        let notifications = 0;
        dashboard({ plugins: [plugin] });

        cell().subscribe(() => { notifications += 1; });
        cell().set(-0);

        expect(notifications).toBe(0);
        expect(Object.is(cell().get(), -0)).toBe(false);
        expect(cell().get()).toBe(0);
    });

    it('stores function values through the documented updater form', () => {
        // `set(fn)` is an updater, so a state whose value IS a function is
        // written as `set(() => fn)`.
        const { plugin, cell } = statePlugin<() => string>('fn-plugin', 'greeter', () => 'hello');
        dashboard({ plugins: [plugin] });

        const next = () => 'bye';
        cell().set(() => next);
        expect(cell().get()).toBe(next);
        expect(cell().get()()).toBe('bye');
    });

    it('commits the value before notifying, even when a listener throws', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', 0);
        const seen: number[] = [];
        dashboard({ plugins: [plugin] });

        cell().subscribe(() => { seen.push(cell().get()); });
        cell().subscribe(() => { throw new Error('listener boom'); });
        cell().subscribe(() => { seen.push(cell().get()); });

        const error = failureOf(() => cell().set(5));
        expect(error.code).toBe('listener-failed');
        expect(error.errors.length).toBe(1);
        expect((error.errors[0] as Error).message).toBe('listener boom');
        expect(seen).toEqual([5, 5]);
        expect(cell().get()).toBe(5);
    });
});

describe('state subscriptions', () => {
    it('notifies every listener synchronously in subscription order', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', 0);
        const order: string[] = [];
        dashboard({ plugins: [plugin] });

        cell().subscribe(() => order.push(`one:${cell().get()}`));
        cell().subscribe(() => order.push(`two:${cell().get()}`));
        cell().set(1);
        cell().set(2);

        expect(order).toEqual(['one:1', 'two:1', 'one:2', 'two:2']);
    });

    it('unsubscribes exactly once and stays harmless when replayed', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', 0);
        const order: string[] = [];
        dashboard({ plugins: [plugin] });

        const unsubscribe = cell().subscribe(() => order.push('hit'));
        cell().set(1);
        expect(unsubscribe()).toBeUndefined();
        expect(unsubscribe()).toBeUndefined();
        cell().set(2);

        expect(order).toEqual(['hit']);
    });

    it('does not deliver to a listener subscribed during the current pass', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', 0);
        const order: string[] = [];
        dashboard({ plugins: [plugin] });

        let armed = true;
        cell().subscribe(() => {
            order.push(`outer:${cell().get()}`);
            if (armed) {
                armed = false;
                cell().subscribe(() => order.push(`inner:${cell().get()}`));
            }
        });

        cell().set(1);
        expect(order).toEqual(['outer:1']);
        cell().set(2);
        expect(order).toEqual(['outer:1', 'outer:2', 'inner:2']);
    });

    it('skips a listener unsubscribed by an earlier listener in the same pass', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', 0);
        const order: string[] = [];
        dashboard({ plugins: [plugin] });

        cell().subscribe(() => {
            order.push('one');
            removeTwo();
        });
        const removeTwo = cell().subscribe(() => order.push('two'));
        cell().subscribe(() => order.push('three'));

        cell().set(1);
        expect(order).toEqual(['one', 'three']);
    });

    it('finishes a nested write before the outer pass resumes (depth-first, no guard)', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', 0);
        const order: string[] = [];
        dashboard({ plugins: [plugin] });

        cell().subscribe(() => {
            const value = cell().get();
            order.push(`one:${value}`);
            if (value === 1) cell().set(2); // re-entered from inside the notification
        });
        cell().subscribe(() => order.push(`two:${cell().get()}`));

        cell().set(1);

        // The inner pass (one:2, two:2) completes inside the first listener, before the
        // outer pass reaches `two`. A queued/batched implementation would instead have
        // produced ['one:1', 'two:1', 'one:2', 'two:2'].
        expect(order).toEqual(['one:1', 'one:2', 'two:2', 'two:2']);
        expect(cell().get()).toBe(2);
    });

    it('exposes the useSyncExternalStore shape', () => {
        const { plugin, cell } = statePlugin('counter-plugin', 'counter', { count: 0 });
        dashboard({ plugins: [plugin] });

        const subscribe: (listener: () => void) => () => void = cell().subscribe;
        const getSnapshot: () => { count: number } = cell().get;

        expect(typeof subscribe).toBe('function');
        expect(subscribe.length).toBe(1);
        expect(getSnapshot.length).toBe(0);

        const release = subscribe(() => undefined);
        expect(typeof release).toBe('function');
        // Snapshot identity is stable between writes, which is the requirement
        // the React adapter relies on.
        expect(getSnapshot()).toBe(getSnapshot());
        release();
    });
});
