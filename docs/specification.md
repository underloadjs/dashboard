# @underload/dashboard — Framework Specification

The normative description of the headless plugin core: what `dashboard()` guarantees, what a
plugin may rely on, what a host may read, and where the framework deliberately stops.

- Companion: [../README.md](../README.md) (quickstart and worked examples).
- Source of truth for behaviour: `src/**`; the conformance map at the end links every guarantee
  to the test that pins it.

## 1. Purpose and scope

`dashboard({ plugins })` composes independent plugins into one long-lived **dashboard instance**:
a registry of named state, services, commands, events and slots, plus a deterministic lifecycle.
The core is:

- **headless** — no DOM, React, CSS, router, storage or network import anywhere in `src/`;
- **synchronous to build** — validation, scheduling and `setup()` all complete inside the
  `dashboard()` call; asynchronous work belongs to command handlers;
- **generic** — no product or wire types: state values, contribution values and event payloads
  are opaque to the framework;
- **final** — no migration story is required, because nothing is imposed on a host: a product may
  drive a dashboard, render from one, both, or neither.

Vocabulary:

| Term | Meaning |
| --- | --- |
| plugin | `{ id, requires?, setup(api) }` — one unit of behaviour |
| registration | a state / service / command / slot entry made during `setup()` |
| cell | the `DashboardState<T>` object returned by `api.state()` |
| contribution | one `{ id, order?, value }` entry added to a slot channel |
| phase | `configuring` → `ready` → `disposing` → `disposed` (internal, observable via `disposed`) |

## 2. Public surface

The single entry exports exactly two runtime values (`dashboard`, `DashboardError`) plus types.
Nothing internal (`ListenerSet`, registries, the scheduler) is reachable.

```ts
function dashboard(options?: DashboardOptions): Dashboard;

interface DashboardOptions {
    readonly plugins?: readonly DashboardPlugin[];
}

interface DashboardPlugin {
    readonly id: string;
    readonly requires?: readonly string[];
    setup(api: DashboardPluginAPI): void | (() => void);
}

interface DashboardPluginAPI {
    state<T>(id: string, initial: T): DashboardState<T>;
    service<T>(id: string, value: T): void;
    getService<T>(id: string): T;
    command<Input = void, Output = void>(id: string, handler: (input: Input) => Output): void;
    execute<Input = void, Output = void>(id: string, input?: Input): Output;
    on<T = unknown>(event: string, handler: (payload: T) => void): () => void;
    emit<T = unknown>(event: string, payload?: T): void;
    slot<T>(name: string, contribution: DashboardContributionInput<T>): void;
}

interface DashboardState<T> {
    get(): T;
    set(value: T | ((previous: T) => T)): void;
    subscribe(listener: () => void): () => void;
}

interface DashboardContributionInput<T> {
    readonly id: string;
    readonly order?: number;
    readonly value: T;
}

interface DashboardContribution<T> {
    readonly slot: string;      // the channel this record belongs to
    readonly id: string;        // as registered
    readonly order: number;     // normalised: always finite, default 0
    readonly value: T;          // as registered, never cloned
}

interface Dashboard {
    readonly plugins: readonly string[];   // ids in the order setup() ran; frozen; stable
    readonly disposed: boolean;            // live view of the phase, not a snapshot
    state<T>(id: string): DashboardState<T>;
    service<T>(id: string): T;
    execute<Input = void, Output = void>(id: string, input?: Input): Output;
    on<T = unknown>(event: string, handler: (payload: T) => void): () => void;
    emit<T = unknown>(event: string, payload?: T): void;
    slot<T>(name: string): readonly DashboardContribution<T>[];
    dispose(): void;
}

class DashboardError extends Error {
    readonly code: DashboardErrorCode;
    readonly cause?: unknown;              // set when a plugin's own throw is being carried (§10.2)
    readonly errors: readonly unknown[];   // every collected failure (§10.2); [] when nothing aggregated
}

// Type-only exports (erased at build time, so the runtime entry keeps exactly two names):
type DashboardErrorCode = 'invalid-options' | … ;                      // the full table in §10.1
type DashboardErrorDetails = { cause?: unknown; errors?: readonly unknown[] };  // DashboardError's third argument
```

Notes on the two optional-parameter conveniences: `execute(id, input?)` and `emit(event, payload?)`
let a void-input command or a signal-style event be called without a second argument, in which
case the handler/listener receives `undefined`.

`DashboardErrorDetails` is exported because it appears in the public `DashboardError` constructor
signature; everything else internal (`ListenerSet`, the registries, the scheduler) stays unreachable.

## 3. Build and lifecycle

### 3.1 Phases

| Phase | When | Registrations | Reads / `execute` / `on` / `emit` | `dispose()` |
| --- | --- | --- | --- | --- |
| `configuring` | a plugin's `setup()` is on the stack | only the active plugin's | legal | **not reachable** — the instance is returned after the last `setup()`, so the host has nothing to call yet |
| `ready` | after the last `setup()` returned | rejected | legal | runs teardown |
| `disposing` | cleanups are running — after `dispose()` **and** during a build rollback (§3.5) | rejected | **legal** (teardown may still read/flush) | returns immediately (re-entrant guard) |
| `disposed` | final | rejected | rejected (`'disposed'`) | returns immediately (idempotent) |

`dashboard.disposed` is `true` only in `disposed`. Unsubscribe handles returned before disposal
stay callable and harmless in every phase.

### 3.2 Two-phase build

```
dashboard(options)
  ├─ 1. read + validate options            (invalid-options)
  ├─ 2. validate every plugin shape/id/requires  (invalid-plugin | invalid-plugin-id | invalid-plugin-requires)
  ├─ 3. reject duplicate plugin ids        (duplicate-plugin-id)
  ├─ 4. resolve every requires edge        (missing-dependency)
  ├─ 5. detect cycles                      (cyclic-dependency)
  ├─ 6. schedule                           (deterministic, §3.3)
  └─ 7. setup loop, in schedule order
        ├─ activePlugin = plugin.id → plugin.setup(api) → activePlugin = null   (every path)
        ├─ accepted return: undefined | null (no cleanup) | function (cleanup)
        ├─ anything else → phase='disposing' → rollback → phase='disposed' → invalid-cleanup (§3.5)
        └─ a throw       → phase='disposing' → rollback → phase='disposed' → setup-failed   (§3.5)
```

Steps 1–6 are total: **no plugin is constructed and no `setup()` is called unless the whole graph
is valid.** A plugin may therefore assume, inside `setup()`, that its `requires` targets exist and
have already been set up. Step 7 is the first point at which plugin code can fail, and every such
failure discards the build (§3.5).

### 3.3 Scheduling

Depth-first over the declared list, emitting a plugin only after everything it requires:

- dependencies always run before dependents;
- among plugins that do not depend on each other, the **declared** relative order is preserved;
- a required plugin is pulled forward as soon as the first plugin that needs it is visited, so a
  dependent plugin's whole subtree completes before the next unrelated declared plugin runs;
- the result is a function of the input only: same plugins, same order, every build.

`instance.plugins` reports this schedule, not the declaration order.

```ts
plugins: [app→(util), log, util]     schedule: ['util', 'app', 'log']
plugins: [top→(left,right), left→(base), right→(base), base]
                                     schedule: ['base', 'left', 'right', 'top']
```

### 3.4 Registration scope

`api.state`, `api.service`, `api.command` and `api.slot` are legal **only while the setup() of the
plugin that owns that `api` handle is running**. Both of these throw
`DashboardError('registration-out-of-scope')`:

```ts
let api!: DashboardPluginAPI;
const keeper: DashboardPlugin = { id: 'keeper', setup: (a) => { api = a; } };
const instance = dashboard({ plugins: [keeper] });

api.state('late', 1);            // ✗ registration-out-of-scope
instance.state('late');          // ✗ unknown-state (nothing partial was written)
```

The rule exists because registrations are the unit of teardown and duplicate detection: a
registration made after its plugin was built would have no owner and no lifetime. `api` handles
are still useful after setup — the runtime operations are not scoped:

```ts
api.getService('transport');     // ✓ legal any time before dispose
api.execute('session.send');     // ✓
api.on('tick', handler);         // ✓ (the subscription is still dropped by dispose())
api.emit('tick');                // ✓
```

Registration failures made *inside* `setup()` are reported as `setup-failed` with the registry
error as `cause` (§10.2) and roll the build back.

**A rollback is not a configuration window.** When a build is discarded, the failing plugin's
registration authorization is cleared and the phase moves to `disposing` **before** the first
cleanup runs. So while an earlier plugin's cleanup is still executing, no plugin can register
anything — including the plugin whose `setup()` failed, through the handle it retained — while its
runtime operations (`getService`, `execute`, `on`, `emit`) and every state cell stay legal. That is
what lets a cleanup flush during rollback without growing a half-built registry.

### 3.5 Rollback and disposal

Both use the same teardown, in **reverse setup order**, so a consumer is always torn down before
the provider it depends on:

```
teardown(fromIndex)      # shared by dispose() and by discarding a failed build
  phase = 'disposing'                                       # set BEFORE the first cleanup
  for each plugin whose setup completed, last set up first:
      try cleanup() catch → collect failure and continue    # never blocks the others
  detach every state cell; drop every listener; clear services, commands, slots
  phase = 'disposed'
```

- **Setup failure.** Plugin *n* throws, or returns a value that is not `void`/`null`/a function: the
  phase moves to `disposing` first, then the cleanups of plugins `0 … n-1` run in reverse order
  (the failing plugin never registered one, so it has none), the registries are dropped, the phase
  becomes `disposed`, and `dashboard()` throws. A throw is reported as
  `DashboardError('setup-failed')` with `cause` = the original error and `errors` = the rollback
  cleanup failures; an invalid return value is reported as `'invalid-cleanup'` with **no** `cause`
  (plugin code threw nothing) and the same `errors` channel. The failing plugin's own cleanup never
  runs, and anything a plugin captured (a state cell, an `api` handle) is dead afterwards: reads and
  writes throw `'disposed'`, so nothing escapes a discarded build.
- **Disposal.** `dispose()` runs the identical teardown over every plugin that completed setup and,
  if cleanups failed, throws `DashboardError('cleanup-failed')` with `cause` = the first collected
  failure and `errors` = all of them — after the dashboard is already `disposed`.
- **Rollback failures never mask the original error** — they ride along in `errors`.
- **Cleanup failures never stop teardown** — every cleanup runs, then `dispose()` throws once.
- **Idempotent and re-entrant.** A `dispose()` called from inside a cleanup returns immediately
  and does not replay the teardown. A `dispose()` that threw `cleanup-failed` has already marked
  the dashboard disposed, so calling it again is a no-op that does not re-run any cleanup.
- **Teardown can still work.** During `disposing` the registries are alive: a cleanup may read or
  write a state cell, run a command, or `emit` an event, and host listeners still receive it.
  Clearing happens only after the last cleanup returns.

## 4. State semantics

```ts
const cell = api.state<{ query: string }>('search.filters', { query: '' });
```

- **Identity.** The registration and every `dashboard.state(id)` lookup return *the same* object;
  cells are plain closures, so they survive destructuring (`const { get, set } = cell`).
- **Global ids.** State ids are addressable from the dashboard, not per plugin. A duplicate id
  anywhere in the dashboard is rejected (`duplicate-state`), naming the owning plugin in both
  directions. Recommended convention: `'<pluginId>.<name>'`.
- **Immutable updates.** Change detection is **SameValueZero** — the equality `Set` and `Map` use:
  identical reference, or two equal primitives, with `NaN` equal to itself and `+0`/`-0` equal
  (unlike `Object.is`, which separates the zeros). A write that compares equal — including writing
  back the object you just mutated in place — is **not** an update and notifies nobody. Always
  produce a new value.
- **Updater form.** `set(value)` or `set(previous => next)`. Because a function argument is read as
  an updater, a state whose own value type is a function must be written as `set(() => fn)`.
- **Commit before notify.** The new value is visible to every listener, and stays committed even if
  a listener throws.
- **Delivery.** Listeners run synchronously in subscription order. A snapshot is taken per pass: a
  listener subscribed during a pass is not called by that pass; a listener unsubscribed during a pass
  is skipped even if it was already in the snapshot.
- **Re-entrancy is depth-first and unguarded.** A listener may write the same cell — and an event
  listener may emit the same channel — from inside a notification. There is no queue, batch, debounce,
  replay or recursion guard: the nested pass runs to completion **before** the outer pass resumes with
  its remaining listeners, so an inner value reaches every subscriber of that cell first and the
  interrupted pass finishes afterwards. The last write is what `get()` returns. A listener that cannot
  tolerate being entered this way should do the work in a command or guard itself.
- **Listener failures.** All listeners run, then one `DashboardError('listener-failed')` is thrown
  with `cause` = first failure and `errors` = all failures. One plugin's broken subscriber can
  never starve another's.
- **Disposal.** Detaching a cell (dispose, or a discarded build) makes `get`/`set`/`subscribe`
  throw `'disposed'` while outstanding unsubscribe handles stay harmless — a still-mounted view
  reads an error instead of rendering a stale snapshot.
- **React mapping.** `subscribe` (no-argument listener → unsubscribe) and `get` (referentially
  stable snapshot) are exactly `useSyncExternalStore`'s two arguments; no adapter package is
  required, and the core never imports React.

## 5. Services

```ts
api.service('transport', transport);          // exactly one provider per id
api.getService<Transport>('transport');       // during setup: ordering is what makes this safe
dashboard.service<Transport>('transport');    // from the host, until dispose
```

Stored and returned **by reference** (never cloned) — identity is what makes a service useful as a
client, a store, or an adapter. A value may be `undefined` and is still a published service
(presence is tracked separately from content). Duplicates are rejected (`duplicate-service`);
unknown ids are rejected rather than returning `undefined` (`unknown-service`), with a message that
points at the missing provider.

**`requires` orders plugins; it does not validate providers.** The edge is the only ordering
guarantee the core makes, and a setup-time `getService` is safe *because* of that ordering. The
framework never records which plugin owns which service id, so an undeclared lookup also succeeds
whenever the provider happened to be scheduled first — it is simply not guaranteed, and the failure
of the undeclared case is a runtime `unknown-service` in the dependant's `setup()`, not a
validation error at build time. Declare the edge for anything read during setup; service ids are a
shared vocabulary between plugins, checked only for uniqueness.

Services are the recommended way to expose a capability that other plugins (and the host) should
reach by name: a state cell can be published as a service so a later plugin can read it without a
closure.

## 6. Commands

```ts
api.command<number, string[]>('search.page', (page) => pages(page));
dashboard.execute<number, string[]>('search.page', 2);

api.command<string, Promise<Line[]>>('session.send', async (prompt) => stream(prompt));
const pending = dashboard.execute<string, Promise<Line[]>>('session.send', 'hello');
```

- The **return value is passed through untouched**: no `await`, no wrapping, so a promise-returning
  handler gives the caller its own promise (chainable, identifiable, still cancelable by the host).
- A synchronous throw propagates **unchanged** — a plugin's `Error` is not rewritten into a
  `DashboardError`, because the handler owns its failures. A rejected promise stays a rejected
  promise with the same reason.
- `execute(id)` with no argument passes `undefined` to the handler.
- Unknown id → `unknown-command`; duplicate registration → `duplicate-command`.
- A command may be executed from inside another plugin's `setup()`; the `requires` edge is what makes
  that safe, and — exactly as with services (§5) — the edge guarantees **ordering only**. The core
  does not record which plugin registered which command id, so an undeclared lookup succeeds whenever
  the registrar happened to be scheduled first and fails with `unknown-command` otherwise.

This split is the whole async story: **building is synchronous, running is not.** A plugin that
needs asynchronous work at start-up declares a command and lets the host (or an event listener in
another plugin) execute it; the framework never observes, awaits or cancels a promise.

## 7. Events

```ts
const stop = api.on<{ id: string }>('session.open', (payload) => open(payload));
dashboard.emit('session.open', { id: 's-1' });
```

- **Open channels, live delivery only.** Event names are never declared; emitting into a channel with
  no subscribers is a no-op. Nothing is queued, buffered, debounced or replayed: a listener that is
  not attached at the moment of the emit never sees that payload, and a listener attached later never
  receives a past event. State is the durable record; events are notifications.
- `api.on` and `dashboard.on` behave identically except for authorship: a plugin subscription is
  recorded like any other and **every** subscription, host or plugin, is dropped by `dispose()`.
- Delivery is synchronous, in subscription order, across all subscribers of that one event, with the
  payload **by reference** (the framework never clones or freezes it — emitters own the value and
  should treat it as read-only after emitting).
- **A listener may emit from inside a delivery, and there is no recursion guard.** The nested emit
  runs to completion before the interrupted pass continues with its remaining listeners, so delivery
  is depth-first, not breadth-first: emitting `tick` with payload `2` from a listener that re-emits
  `tick` with `1`, which re-emits `0`, delivers `2`, then the whole inner pass `1 → 0`, and only then
  the outer pass's remaining listeners. Every listener of a channel therefore observes another
  listener's nested emissions, and bounding the recursion is the emitter's responsibility.
- The same snapshot and failure-isolation rules as state (§4): subscribing during a pass defers to
  the next pass, unsubscribing during a pass takes effect at once, and throwing listeners are
  aggregated into one `listener-failed` after everyone else was served.
- Unsubscribe handles are idempotent, harmless after `clear()`/`dispose()`, and never affect another
  subscriber.

## 8. Slots

```ts
api.slot<Panel>('panels', { id: 'transcript', order: 0, value: transcriptPanel });
dashboard.slot<Panel>('panels');
// [{ slot: 'panels', id: 'transcript', order: 0, value: transcriptPanel }]
```

- **Open named channels with no predefined layout.** The first contribution creates the channel;
  nothing declares slot names, so a plugin can invent a channel the host has never heard of, and a
  host can render only the channels it knows about. Unknown names read as `[]` — never an error,
  never a dropped contribution.
- **Sorting.** `order` ascending, default `0`; equal orders keep registration order (global to the
  channel, across plugins). `order` may be negative or fractional. It must be a finite number:
  `NaN`, `±Infinity` and non-numbers are rejected (`invalid-contribution`) rather than producing an
  unstable UI order.
- **Snapshots.** `dashboard.slot(name)` returns a frozen array of frozen records. The snapshot is
  cached, so repeated reads return the identical reference until a new contribution arrives — since
  registrations only happen during setup, a ready dashboard's snapshots are stable forever, which is
  what lets an adapter memoize rendering on the array itself. The `value` inside a record is *not*
  frozen or cloned: contributions are opaque payloads.
- **Contribution ids are unique per slot**, not globally: the same id may appear in two channels
  (`'rails'` and `'panels'`), but reusing it inside one channel is rejected
  (`duplicate-contribution`), naming both authors. Contribution records are global across plugins,
  so the check is what keeps a host's keys stable when rendering a channel.

Because slots are read-only from the host side and write-only from the plugin side, they are the
composition seam: a shell declares which channels it renders, and plugins fill them.

## 9. Identifier and validation rules

Every key is a **non-empty string**; anything else is `invalid-identifier` (slot contribution
records use `invalid-contribution` for the same reason, since the record is what is malformed):

| Key | Source |
| --- | --- |
| plugin id | `DashboardPlugin.id` |
| state id | `api.state` / `dashboard.state` |
| service id | `api.service` / `api.getService` / `dashboard.service` |
| command id | `api.command` / `api.execute` / `dashboard.execute` |
| event name | `api.on` / `api.emit` / `dashboard.on` / `dashboard.emit` |
| slot name | `api.slot` / `dashboard.slot` |
| contribution id | `api.slot` contribution |

Handlers must be functions (`invalid-handler`): `api.command`'s handler, `api.on`/`dashboard.on`'s
listener. These guards exist for plain-JavaScript consumers; a typed consumer cannot reach them.

`dashboard()` input: `undefined`, `{}`, `{ plugins: [] }` and `{ plugins: undefined }` are all an
empty dashboard. A non-object options value or a non-array `plugins` is `invalid-options`; unknown
option keys are ignored, so the options shape can grow without breaking a host.

## 10. Errors

### 10.1 Code table

Every failure is a `DashboardError`. Branch on `code`; message text is diagnostic only and is not
part of the contract.

| `code` | Raised when |
| --- | --- |
| `invalid-options` | options is not an object, or `plugins` is not an array |
| `invalid-plugin` | a plugin entry is not an object, or has no callable `setup` |
| `invalid-plugin-id` | `id` is missing, empty, or not a string |
| `invalid-plugin-requires` | `requires` is not an array of non-empty plugin ids |
| `invalid-cleanup` | `setup()` returned neither `void`/`null` nor a function (e.g. an accidental `async setup()`) |
| `invalid-identifier` | a state/service/command id or event/slot name is not a non-empty string |
| `invalid-handler` | a command handler or event listener is not a function |
| `invalid-contribution` | contribution record is not an object, has a bad `id`, or a non-finite `order` |
| `duplicate-plugin-id` | the same plugin id is declared twice |
| `missing-dependency` | a `requires` entry names a plugin that was not passed |
| `cyclic-dependency` | `requires` forms a cycle (a self-edge counts); the message prints the path |
| `registration-out-of-scope` | `state`/`service`/`command`/`slot` called outside the owning plugin's `setup()` |
| `disposed` | any operation on a disposed (or discarded) dashboard |
| `setup-failed` | a plugin's `setup()` threw; the build is rolled back (§3.5) |
| `cleanup-failed` | one or more cleanups threw during `dispose()`; the dashboard is still disposed |
| `duplicate-state` | two plugins register the same state id |
| `duplicate-service` | two plugins provide the same service id |
| `duplicate-command` | two plugins register the same command id |
| `duplicate-contribution` | the same contribution id is used twice in one slot |
| `unknown-state` | `dashboard.state(id)` for an unregistered id |
| `unknown-service` | `getService`/`dashboard.service` for an unprovided id |
| `unknown-command` | `execute` for an unregistered id |
| `listener-failed` | one or more state/event listeners threw (§4, §7) |

### 10.2 Conventions

- **Wrapping.** A registry error raised inside `setup()` is re-thrown by the build as
  `setup-failed`; the registry error is `cause`. Hosts that want the precise reason read
  `error.cause`. Registrations that fail *after* `setup()` are not wrapped — they surface directly as
  `registration-out-of-scope` at the offending call site, including when a cleanup tries to register
  during a rollback (the rejected cleanup then shows up as a rollback failure).
- **`cause` and `errors`, per code.** Values are carried exactly as the plugin threw them (they do
  not have to be `Error` objects, and nothing is rewritten):

  | `code` | `cause` | `errors` |
  | --- | --- | --- |
  | `setup-failed` | whatever the plugin's `setup()` threw, unmodified | the rollback cleanup failures, in reverse setup order |
  | `invalid-cleanup` | `undefined` — plugin code threw nothing | the rollback cleanup failures |
  | `cleanup-failed` | the first collected cleanup failure | every cleanup failure, in reverse setup order |
  | `listener-failed` | the first throwing listener's error | every listener error, in delivery order |
  | any other code | `undefined` | `[]` |
- **Precedence.** Disposal beats scope: after `dispose()`, a late `api.state()` reports `'disposed'`
  (the honest answer), not `'registration-out-of-scope'`.
- **Not wrapped.** A command handler's own throw/rejection and an event listener's individual
  error identity are preserved: the framework only ever aggregates, it never rewrites.

## 11. Extension patterns

All eight patterns below use the same primitives — none of them is privileged by the core.

**Provider / transport plugin** — publishes the thing that talks to the outside world, and is the
only plugin that knows where the server is.

```ts
const transportPlugin: DashboardPlugin = {
    id: 'transport',
    setup(api) {
        api.service('transport', { baseUrl, send: (prompt) => fetch(...).then(...) });
    },
};
```

**Domain plugin** — owns the truth: state first, then the commands that change it, then the events
that announce it.

```ts
const sessionsPlugin: DashboardPlugin = {
    id: 'sessions',
    requires: ['transport'],
    setup(api) {
        const sessions = api.state<Session[]>('sessions.list', []);
        const selected = api.state<string | null>('sessions.selected', null);
        api.command<void, Promise<Session[]>>('sessions.load', async () => { /* ... */ });
        api.command<Session, string[]>('sessions.select', (session) => {
            selected.set(session.id);
            api.emit('sessions.selected', session.id);
            return sessions.get().map((item) => item.id);
        });
        return () => selected.set(null);
    },
};
```

A transcript or composer plugin looks identical: state + commands + events, `requires` on whatever
it consumes. That is why they compose: a plugin that needs sessions adds
`requires: ['sessions']` and reads `dashboard.state('sessions.selected')` at runtime, or asks
sessions to publish the cell as a service.

**Layout / shell plugin** — contributes to channels the shell renders, and knows nothing about what
else fills them.

```ts
api.slot<Side>('rails', { id: 'sessions', order: -10, value: 'left' });
api.slot<Panel>('panels', { id: 'transcript', order: 0, value: { title: 'Transcript', body: 'transcript' } });
```

Use **order bands** so independently authored plugins interleave predictably: `-20` for primary
navigation, `0` for main content, `20` for secondary/inspector surfaces, `40` for add-ons. Ties
inside a band resolve by registration order, which is itself deterministic (§3.3).

**Theme plugin** — a state cell for the active token set, a command to switch it, and an event for
hosts that must repaint:

```ts
const themePlugin: DashboardPlugin = {
    id: 'theme',
    setup(api) {
        const mode = api.state<'light' | 'dark'>('theme.mode', 'light');
        api.command<'light' | 'dark', 'light' | 'dark'>('theme.set', (next) => {
            mode.set(next);
            api.emit('theme.changed', next);
            return mode.get();
        });
        api.service('theme.state', mode);      // publish the cell so any plugin can subscribe
    },
};
```

**Capability / instrument plugin** — a plugin that adds a slot contribution plus its own command and
state, and nothing else, is how a product grows the dashboard without touching the shell (the
example app proves this by appending an add-on plugin the shell has never heard of).

**Factory plugins** — dependency injection by closure, for values a plugin cannot reach through a
service (a host-owned store, a clock, a fixture set):

```ts
const createSourcePlugin = (options: { clock?: Clock } = {}): DashboardPlugin => ({
    id: 'source',
    requires: ['transport'],
    setup(api) { /* uses options.clock */ },
});
```

**Bridge plugin** — the seam for an existing product. A bridge keeps the product's own wire format
outside the core, translating DTO → state/commands/events:

```ts
const harnessBridgePlugin = (client: HarnessClient): DashboardPlugin => ({
    id: 'harness-bridge',
    setup(api) {
        const transcript = api.state<Entry[]>('transcript.entries', []);
        const stop = client.subscribe((frame) => {
            transcript.set((entries) => [...entries, toEntry(frame)]);   // DTO → framework value
            api.emit('transcript.appended', 1);
        });
        return () => stop();                                             // teardown owns the socket
    },
});
```

**Testing plugin** — a fake is just a plugin with a different service:
`{ id: 'transport', setup: (api) => api.service('transport', fakeTransport) }` replaces the real one
in a `dashboard({ plugins: [fakeTransportPlugin, ...underTest] })`; assertions are made against
`dashboard.state(...)`, `dashboard.execute(...)` and recorded `on(...)` calls. No rendering, no
timers, no DOM required.

Conventions the core does not enforce but hosts benefit from: `'<plugin>.<thing>'` ids,
`'<plugin>.<verb>'` commands, `'<plugin>.<past-tense>'` events, and never mutating a value you did
not create.

## 12. API bounds

The core deliberately owns nothing but the registry and the lifecycle:

| Not in the core | Who owns it |
| --- | --- |
| Rendering, components, CSS, accessibility | the host (React, vanilla DOM, canvas, terminal) |
| Routing and history | the host, or a host-level plugin using state + commands |
| Persistence (storage, IndexedDB, server) | a provider/bridge plugin; the core never touches I/O |
| Wire formats and DTOs | the host; a bridge plugin translates |
| Async scheduling, retries, cancellation | command handlers; the core never awaits or times anything out |
| React bindings | `useSyncExternalStore` directly (§4) |
| Plugin isolation / sandboxing | nobody — see the trust model below |
| Slot layout and rendering rules | the shell |

**Trust model.** Plugins are trusted first-party code running in the host's realm: `setup()` is
called synchronously with the same privileges as the host, and a plugin can read or write any
registry. The framework performs no `eval`, no dynamic code import, and produces no markup, so
there is no injection surface of its own; contribution and payload values are only as safe as the
host renders them (a host that puts an opaque `value` into `innerHTML` is making its own decision).
Values are expected to be treated as read-only by everyone after publication.

**Failure model.** The framework's only I/O is the plugin's own code: a build fails loudly before
or during `setup()`, a running failure is the plugin's error surfaced unchanged, and the one place
the framework aggregates (`listener-failed`) never suppresses a delivery.

## 13. Future harness adapter

A harness (or any product UI) integrates by **adding an adapter module outside this package**, not
by changing it:

```
harness UI (existing sessions / transcript / composer / tools / rails)
        │  renders from, and dispatches into, the dashboard
        ▼
adapter  ──  wire DTO  ⇄  dashboard state / services / commands / events
        │
        ▼
@underload/dashboard  (no DOM, no wire types, no knowledge of the harness)
```

What an adapter is expected to do:

1. choose the slot channels its shell renders (`'rails'`, `'panels'`, `'composer'`, `'status'`, …)
   and read `dashboard.slot<T>(name)` once, memoizing on the frozen snapshot;
2. map each contribution `value` (an adapter-defined descriptor type) to a view, and dispatch user
   intent through `dashboard.execute(...)`;
3. subscribe with `state(id).subscribe` / `useSyncExternalStore`, never by polling;
4. own the wire types and convert them into framework values inside a bridge plugin (§11);
5. call `dispose()` when the surface goes away, which tears every plugin down in reverse order and
   invalidates any cell the adapter still holds (a useful loud failure);
6. treat **state as the truth and events as live-only signals** (§4, §7): when a view mounts, read
   `state(id).get()` rather than waiting for the next emit, because nothing is queued or replayed.

What an adapter must not expect: a rendering API, a component contract, a schema registry, an
observable graph, or a plugin protocol beyond `DashboardPlugin`. Inversely, nothing in this package
needs to change to host a new surface — a second harness is a second composition of plugins plus a
second adapter, sharing only the id and event-name vocabulary.

**No migration.** Adopting the framework is additive: existing UIs keep their state management, and
a product can introduce one plugin at a time (a bridge that publishes an existing store as a
service, then a command, then a slot contribution) without moving anything.

## 14. Conformance map

| Guarantee | Test file (`src/tests/**`; every one drives the entry, `src/dashboard.ts`) |
| --- | --- |
| Single public entry shape (two runtime exports, type-only error exports nameable); empty dashboard | `dashboard.test.ts` |
| Options input, plugin shape, duplicate/missing/cycle rejection **before any setup**, deterministic schedule | `plugins.test.ts` |
| State identity, SameValueZero equality (incl. `NaN` and `±0`), subscription ordering and membership, nested-write depth-first interleaving, listener isolation, `useSyncExternalStore` shape | `state.test.ts` |
| Event channels, payload by reference, nested-emit interleaving and no replay, isolation, plugin/host ownership across disposal, runtime subscription | `events.test.ts` |
| Service identity and ordering rules; command pass-through incl. promise identity; slot sorting, freezing, open names, per-slot uniqueness | `registries.test.ts` |
| Setup/cleanup order, teardown work during `disposing`, rollback as a disposal (runtime legal, registrations rejected incl. the failed plugin's own handle), `setup-failed`/`invalid-cleanup` cause and error aggregation, cleanup aggregation, idempotent and re-entrant dispose, post-dispose `'disposed'` on every operation, registration scope | `lifecycle.test.ts` |
