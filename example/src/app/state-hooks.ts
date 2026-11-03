// useSyncExternalStore bridge from React to the core's observable state.
//
// The core exposes `DashboardState<T>` as exactly the three primitives React
// needs — `subscribe(listener) => unsubscribe`, `get() => snapshot` — so the
// public core stays React-free and this file (example-only) is where the React
// binding lives. If a second target (Preact, vanilla DOM) is added later, it
// gets its own bridge and these plugins are untouched.
//
// Two non-obvious details worth keeping:
//
//   1. `state.get`/`state.subscribe` are wrapped in arrows rather than passed
//      through directly, so a future implementation that keeps `this` (class or
//      prototype based) cannot break under React's detached-call convention.
//
//   2. `useDashboardPair` memoises its derived value. Two panels need values
//      computed from more than one state (the transcript reads the log AND the
//      active session). A fresh array/object from every getSnapshot() would make
//      useSyncExternalStore loop forever, so the snapshot is cached against
//      reference equality of the inputs — identical inputs return the identical
//      object, exactly what the store contract requires.
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { DashboardState } from '@underload/dashboard';
import { useWorkbench } from './workbench';
import type { Contribution } from './contract';

/** Subscribe to one registered state object. */
export function useDashboardState<T>(state: DashboardState<T>): T {
    const subscribe = useCallback((listener: () => void) => state.subscribe(listener), [state]);
    const getSnapshot = useCallback(() => state.get(), [state]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Read a registered state by id straight from the composed instance. */
export function useDashboardValue<T>(stateId: string): T {
    const instance = useWorkbench();
    const state = useMemo(() => instance.state<T>(stateId), [instance, stateId]);
    return useDashboardState(state);
}

/**
 * Derived snapshot over two states (see the caching note above). `compute` may
 * be an inline arrow every render: it is read through a ref, so it never causes
 * a resubscribe or a new snapshot identity on its own.
 */
export function useDashboardPair<A, B, T>(
    firstId: string,
    secondId: string,
    compute: (first: A, second: B) => T
): T {
    const instance = useWorkbench();
    const first = useMemo(() => instance.state<A>(firstId), [instance, firstId]);
    const second = useMemo(() => instance.state<B>(secondId), [instance, secondId]);

    const computeRef = useRef(compute);
    computeRef.current = compute;

    const cacheRef = useRef<{ first: A; second: B; value: T } | null>(null);

    const subscribe = useCallback(
        (listener: () => void) => {
            const offFirst = first.subscribe(listener);
            const offSecond = second.subscribe(listener);
            return () => {
                offFirst();
                offSecond();
            };
        },
        [first, second]
    );

    const getSnapshot = useCallback((): T => {
        const nextFirst = first.get();
        const nextSecond = second.get();
        const cached = cacheRef.current;
        if (cached !== null && cached.first === nextFirst && cached.second === nextSecond) {
            return cached.value;
        }
        const value = computeRef.current(nextFirst, nextSecond);
        cacheRef.current = { first: nextFirst, second: nextSecond, value };
        return value;
    }, [first, second]);

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Read a registered service facade by id. Services are registered during setup
 * and never replaced, so a plain memo is enough (no subscription).
 */
export function useDashboardService<S>(serviceId: string): S {
    const instance = useWorkbench();
    return useMemo(() => instance.service<S>(serviceId), [instance, serviceId]);
}

/**
 * Read one slot. Also setup-time only, so it is computed once: slot contents
 * are frozen when composition finishes, which is what lets the shell render the
 * arrays directly instead of subscribing to a slot-change event.
 */
export function useDashboardSlot<T>(slotName: string): readonly Contribution<T>[] {
    const instance = useWorkbench();
    // No cast: the declared return type is the structural check. If the core
    // ever renames a contribution field, this line stops compiling instead of
    // silently passing a shaped-away object to the shell.
    return useMemo(() => instance.slot<T>(slotName), [instance, slotName]);
}
