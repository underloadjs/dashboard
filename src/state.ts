// State cells and the state registry.
//
// A cell is a closure (not a class instance) so the public object is exactly
// `{ get, set, subscribe }` and stays safe when destructured by an adapter.
// `detach` is the framework-internal teardown hook that turns a retained cell
// into a hard 'disposed' failure, which is what makes "capture the cell, keep
// it after dispose" a loud error instead of a silently stale snapshot.
//
// Cross-references:
//   - ./types.ts     — DashboardState contract (immutable updates, useSyncExternalStore shape)
//   - ./listeners.ts — delivery guarantees shared with events
//   - ./dashboard.ts — registration guard + detachAll() during teardown

import { fail } from './errors';
import { ListenerSet } from './listeners';
import { ownerLabel, requireIdentifier } from './validate';
import type { DashboardState } from './types';

// SameValueZero equality (what Set/Map use) implemented without depending on the
// es2015.core lib entry: `a === b` covers identical references and equal
// primitives, and the paired self-comparison covers NaN (which is not `===` to
// itself). Deliberately NOT Object.is: the two `===` comparisons treat +0 and -0
// as equal, which is the intended semantics here.
function isSameValueZero(a: unknown, b: unknown): boolean {
    return a === b || (a !== a && b !== b);
}

export type ManagedState<T> = {
    // The object handed to plugins and to dashboard.state().
    readonly view: DashboardState<T>;
    // Framework-only: marks the cell dead and drops its listeners.
    detach(): void;
};

export function createState<T>(id: string, initial: T): ManagedState<T> {
    let value: T = initial;
    let live = true;
    const listeners = new ListenerSet();

    // Reads and writes on a detached cell must fail loudly: a stale snapshot
    // inside a still-mounted view is the classic double-dashboard bug.
    const guard = (operation: string): void => {
        if (!live) {
            fail('disposed', `${operation} state "${id}" failed because the dashboard has been disposed.`);
        }
    };

    const view: DashboardState<T> = {
        get: () => {
            guard('Reading');
            return value;
        },

        set: (next: T | ((previous: T) => T)) => {
            guard('Writing');

            // A function argument is an updater (see ./types.ts). The cast is the
            // documented ambiguity of `set` when T is itself a function type.
            const resolved: T = typeof next === 'function'
                ? (next as (previous: T) => T)(value)
                : next;

            // Immutable-update contract: a write that is SameValueZero-equal to
            // the current value (same reference, or an equal primitive) is not an
            // update, so nobody is woken up. In-place mutation therefore goes
            // unnoticed and is the caller's bug, not the framework's.
            if (isSameValueZero(resolved, value)) return;

            value = resolved;
            listeners.emit(undefined, `state "${id}"`);
        },

        subscribe: (listener: () => void) => {
            guard('Subscribing to');
            return listeners.subscribe(listener);
        },
    };

    return {
        view,
        detach: () => {
            live = false;
            listeners.clear();
        },
    };
}

type StateEntry = { owner: string; managed: ManagedState<unknown> };

// Global id space (states are addressable from the dashboard, not per plugin);
// `owner` only exists to make duplicate errors name the two colliding plugins.
export class StateRegistry {
    private readonly cells = new Map<string, StateEntry>();

    register<T>(ownerId: string, id: string, initial: T): DashboardState<T> {
        const key = requireIdentifier('State id', id);
        const existing = this.cells.get(key);
        if (existing !== undefined) {
            fail('duplicate-state',
                `State "${key}" is already registered by ${ownerLabel(existing.owner)}; ` +
                `${ownerLabel(ownerId)} cannot claim the same id. Use dashboard.state("${key}") to read it.`);
        }

        const managed = createState<T>(key, initial);
        // The registry is deliberately type-erased (cells are addressed by id, and
        // the value type is re-supplied by whoever reads them back with get<T>);
        // this cast is the write half of that erasure, mirrored by the cast in get.
        this.cells.set(key, { owner: ownerId, managed: managed as unknown as ManagedState<unknown> });
        return managed.view;
    }

    get<T>(id: string): DashboardState<T> {
        const key = requireIdentifier('State id', id);
        const entry = this.cells.get(key);
        if (entry === undefined) {
            fail('unknown-state', `No state is registered under "${key}".`);
        }
        return entry.managed.view as DashboardState<T>;
    }

    // Order-independent: cells are independent of each other, so a detached
    // cell never depends on another having been detached first.
    detachAll(): void {
        this.cells.forEach((entry) => entry.managed.detach());
        this.cells.clear();
    }
}
