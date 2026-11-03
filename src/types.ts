// Public type surface for @underload/dashboard.
//
// The framework is headless: nothing here mentions DOM, React, CSS or any
// harness wire shape. A host (a React app, a vanilla UI, the future harness
// adapter, a test, a CLI) reads these primitives and renders whatever it likes.
//
// Cross-references:
//   - ./dashboard.ts — the only runtime factory (dashboard()) and the lifecycle it drives
//   - ./index.ts     — the single public barrel; this file is the source of the types it re-exports

// A reactive value cell. Structurally compatible with React's
// `useSyncExternalStore(subscribe, () => state.get())`: `subscribe` takes a
// callback with no arguments and returns an unsubscribe function, and `get`
// returns a stable snapshot as long as nobody writes.
//
// Updates are expected to be IMMUTABLE: write a new object/array/primitive,
// never mutate the previous one in place. Change detection is SameValueZero —
// the equality Set/Map use: identical reference, or two equal primitives, with
// NaN equal to itself and +0/-0 equal (unlike Object.is, which separates the
// zeros). A write that compares equal is not an update and notifies nobody, so
// an in-place mutation stays invisible to subscribers and breaks
// snapshot-identity consumers such as useSyncExternalStore.
//
// Because a function argument is read as an updater, a state whose own value
// type is a function must be written as `set(() => fn)`.
export interface DashboardState<T> {
    // Current value; throws once the owning dashboard has been disposed.
    get(): T;
    // Plain value, or an updater receiving the previous value. Equal writes are no-ops.
    set(value: T | ((previous: T) => T)): void;
    // Registers a change listener; returns an idempotent unsubscribe.
    // Listeners run synchronously, in subscription order, after the value lands.
    subscribe(listener: () => void): () => void;
}

// What a plugin hands to api.slot(). `order` sorts contributions inside a slot
// (lower first, defaults to 0); `value` is opaque to the framework.
export interface DashboardContributionInput<T> {
    readonly id: string;
    readonly order?: number;
    readonly value: T;
}

// What instance.slot() returns: the contribution as registered, with the slot
// name and the effective (always finite, always numeric) order filled in.
// Frozen; consumers may keep it but must not write to it.
export interface DashboardContribution<T> {
    readonly slot: string;
    readonly id: string;
    readonly order: number;
    readonly value: T;
}

// The capability set handed to one plugin's setup(). Registration methods
// (state/service/command/slot) are legal only while THIS plugin's setup() is on
// the stack; every other method (getService/execute/on/emit) is a runtime
// operation that stays legal for the whole lifetime of the dashboard.
export interface DashboardPluginAPI {
    // Declares a named state cell and returns it. Global id space: a duplicate
    // id anywhere in the dashboard is rejected, naming the owning plugin.
    state<T>(id: string, initial: T): DashboardState<T>;

    // Publishes a named value (usually an object: a client, a store, a config).
    service<T>(id: string, value: T): void;

    // Reads a service published by another plugin. Requires a declared
    // `requires` edge when called during setup, so the producer is guaranteed
    // to have run first.
    getService<T>(id: string): T;

    // Declares a named action. Return values (including promises) are handed to
    // the caller untouched. Duplicate ids are rejected.
    command<Input = void, Output = void>(id: string, handler: (input: Input) => Output): void;

    // Runs a command registered by any plugin.
    execute<Input = void, Output = void>(id: string, input?: Input): Output;

    // Subscribes to a named event. The subscription is owned by the dashboard
    // and is dropped when the dashboard is disposed. Returns an idempotent
    // unsubscribe.
    on<T = unknown>(event: string, handler: (payload: T) => void): () => void;

    // Publishes a named event to every current subscriber.
    emit<T = unknown>(event: string, payload?: T): void;

    // Contributes a value to a named, open slot channel. Slot names are never
    // declared up front: the first contribution creates the channel.
    slot<T>(name: string, contribution: DashboardContributionInput<T>): void;
}

// A unit of behaviour. `setup` runs synchronously exactly once, in dependency
// order. Returning a function registers that plugin's teardown; returning
// anything else (a promise included) is rejected with 'invalid-cleanup', which
// is how an accidental `async setup(api) {...}` is caught.
export interface DashboardPlugin {
    readonly id: string;
    // Ids of plugins that must be set up before this one. Missing and cyclic
    // edges are rejected before ANY setup() runs.
    readonly requires?: readonly string[];
    setup(api: DashboardPluginAPI): void | (() => void);
}

export interface DashboardOptions {
    // Plugins exactly as authored by the host; the framework reorders them into
    // dependency order. Unknown option keys are ignored so the shape can grow.
    readonly plugins?: readonly DashboardPlugin[];
}

// The assembled, headless dashboard. Read/execute/emit operations fail with a
// 'disposed' DashboardError after dispose(); dispose() itself is idempotent.
export interface Dashboard {
    // Plugin ids in the order their setup() actually ran (dependency order,
    // not necessarily the order they were declared). Stable across dispose.
    readonly plugins: readonly string[];

    // True once dispose() finished (or once a failed build discarded itself).
    readonly disposed: boolean;

    // Reads a state cell registered by any plugin.
    state<T>(id: string): DashboardState<T>;

    // Reads a service registered by any plugin.
    service<T>(id: string): T;

    // Runs a command registered by any plugin; the handler's return value
    // (promise included) is passed straight through.
    execute<Input = void, Output = void>(id: string, input?: Input): Output;

    // Host-owned event listener (same semantics as api.on, minus plugin
    // ownership). Also dropped by dispose().
    on<T = unknown>(event: string, handler: (payload: T) => void): () => void;

    emit<T = unknown>(event: string, payload?: T): void;

    // Snapshot of one slot channel: contributions sorted by `order` ascending,
    // ties broken by registration order. Unknown slot names return [].
    slot<T>(name: string): readonly DashboardContribution<T>[];

    // Runs every plugin cleanup in reverse setup order, then drops every
    // registry, listener and subscription. Idempotent and re-entrant safe.
    dispose(): void;
}
