# @underload/dashboard

A **headless dashboard framework**: everything is a plugin, and one call assembles the
dashboard.

```ts
import { dashboard } from '@underload/dashboard';

const instance = dashboard({ plugins: [providerPlugin, sessionPlugin, layoutPlugin] });
```

`dashboard()` returns a plain object with five kinds of capability — **state**, **services**,
**commands**, **events** and **slots** — and a `dispose()`. It owns no DOM, no React, no CSS,
no router and no wire format. A host reads those primitives and renders whatever it wants:
a React app, a vanilla DOM harness UI, a terminal, a test.

This package is a framework for building dashboard front-ends, not a component library and not
a rewrite of any existing UI. Nothing in it has to be migrated into a running product, and
nothing in it forces a product to change.

## Install

```bash
yarn add @underload/dashboard
```

No runtime dependencies. One public entry point, ESM, browser- and Node-safe.

```ts
import { dashboard, DashboardError } from '@underload/dashboard';
import type {
    Dashboard,
    DashboardContribution,
    DashboardContributionInput,
    DashboardErrorCode,
    DashboardErrorDetails,
    DashboardOptions,
    DashboardPlugin,
    DashboardPluginAPI,
    DashboardState,
} from '@underload/dashboard';
```

Those are all of it: `dashboard` and `DashboardError` are the only runtime exports, and the rest are
type-only (erased at build time). `DashboardErrorDetails` is the constructor's third argument,
`DashboardErrorCode` is the code union below.

## Quickstart

A three-plugin dashboard: a transport provider, a session/domain plugin, and a layout plugin
that contributes chrome. No rendering happens here — the last block is one possible host.

```ts
import { dashboard } from '@underload/dashboard';
import type { DashboardPlugin } from '@underload/dashboard';

// 1. A provider plugin publishes a value anyone may read by id.
const transportPlugin: DashboardPlugin = {
    id: 'transport',
    setup(api) {
        api.service('transport', {
            baseUrl: 'http://localhost:5500',
            send: async (prompt: string) => `${prompt.trim()} [sent]`,
        });
    },
};

// 2. A domain plugin owns state, a command and events. `requires` guarantees the
//    transport service already exists when its setup() runs.
type TranscriptLine = { role: 'user' | 'assistant'; text: string };

const sessionPlugin: DashboardPlugin = {
    id: 'session',
    requires: ['transport'],
    setup(api) {
        const transport = api.getService<{ send: (prompt: string) => Promise<string> }>('transport');

        const transcript = api.state<TranscriptLine[]>('session.transcript', []);
        const busy = api.state<boolean>('session.busy', false);

        api.on<string>('session.reset', () => {
            transcript.set([]);
        });

        // Commands may be async: the promise is handed back to whoever executes it.
        api.command<string, Promise<TranscriptLine[]>>('session.send', async (prompt) => {
            busy.set(true);
            try {
                const reply = await transport.send(prompt);
                transcript.set((lines) => [...lines, { role: 'user', text: prompt }, { role: 'assistant', text: reply }]);
                api.emit('session.updated', transcript.get().length);
                return transcript.get();
            } finally {
                busy.set(false);
            }
        });

        // Anything returned from setup() is that plugin's teardown.
        return () => {
            busy.set(false);
        };
    },
};

// 3. A layout plugin only contributes; it never learns who rendered it.
const layoutPlugin: DashboardPlugin = {
    id: 'layout',
    requires: ['session'],
    setup(api) {
        api.slot<'left' | 'right'>('rails', { id: 'sessions', order: -10, value: 'left' });
        api.slot<'left' | 'right'>('rails', { id: 'tools', order: 10, value: 'right' });
        api.slot<{ placeholder: string }>('composer', { id: 'prompt', value: { placeholder: 'Ask the model' } });
    },
};

const instance = dashboard({ plugins: [transportPlugin, sessionPlugin, layoutPlugin] });
```

Reading it from a host:

```ts
// Slots: sorted, frozen snapshots of everything plugins contributed.
instance.slot<'left' | 'right'>('rails').map((contribution) => contribution.id);
// ['sessions', 'tools'] — ordered by `order`, ties by registration order.

// State: a live cell the host can read and subscribe to.
const transcript = instance.state<TranscriptLine[]>('session.transcript');
const release = transcript.subscribe(() => render(transcript.get()));

// Commands: sync or async, the return value is the handler's own.
const lines = await instance.execute<string, Promise<TranscriptLine[]>>('session.send', 'hello');

// Events: host listeners subscribe on the same channel the plugins use.
instance.on<number>('session.updated', (count) => console.log(`${count} lines`));

// Teardown: reverse setup order, then every registry and listener is dropped.
release();
instance.dispose();
```

## The API

`dashboard(options?)` — validates, schedules and sets up every plugin synchronously, then
returns the instance. `options.plugins` may be omitted, empty, or unordered.

| Plugin (`api.*`, during setup only) | Instance (`dashboard.*`, at runtime) |
| --- | --- |
| `api.state(id, initial)` → `DashboardState<T>` | `dashboard.state(id)` → the same cell |
| `api.service(id, value)` | `dashboard.service(id)` → the value |
| `api.getService(id)` | — (same lookup) |
| `api.command(id, handler)` | `dashboard.execute(id, input?)` → handler's return value |
| `api.on(event, handler)` → unsubscribe | `dashboard.on(event, handler)` → unsubscribe |
| `api.emit(event, payload?)` | `dashboard.emit(event, payload?)` |
| `api.slot(name, { id, order?, value })` | `dashboard.slot(name)` → sorted, frozen snapshot |
| — | `dashboard.plugins` → ids in setup order |
| — | `dashboard.dispose()`, `dashboard.disposed` |

### State

```ts
const cell = api.state<{ query: string }>('search.filters', { query: '' });

cell.get();                                  // current value, referentially stable
cell.set({ query: 'nope' });                 // new value, listeners notified
cell.set((previous) => ({ ...previous, query: 'x' }));  // updater form
cell.subscribe(() => rerender());            // → unsubscribe handle
```

Updates are **immutable**: change detection is **SameValueZero** — the equality `Set` and `Map`
use: same reference or equal primitives, `NaN` equal to itself, `+0` and `-0` equal (unlike
`Object.is`, which separates the zeros). So mutating the previous object and writing it back is
invisible to subscribers (and breaks `useSyncExternalStore`). A write that compares equal is not an
update — nobody is woken. `get()` returns the identical reference between writes, and a listener may
write the same cell from inside a notification: the nested pass finishes first (depth-first, no
guard, no batching), then the interrupted pass continues.

React needs no adapter package at all:

```tsx
import { useSyncExternalStore } from 'react';

function useFilters() {
    const cell = instance.state<{ query: string }>('search.filters');
    return useSyncExternalStore(cell.subscribe, cell.get);
}
```

`subscribe` takes a no-argument listener and returns an unsubscribe; `get` is a stable
snapshot getter — that is exactly the required shape. The cells are plain closures, so they are
safe to destructure and pass around.

### Services

```ts
api.service('client', client);              // publish once
api.getService<Client>('client');           // during setup: ordering is what makes it safe
dashboard.service<Client>('client');        // from the host, any time before dispose
```

Values are stored and returned by reference, never cloned. A duplicate provider is rejected,
and an `undefined` value is still a published service.

`requires` **orders plugins; it does not validate providers.** The core never records which plugin
owns which service id, so a setup-time lookup without an edge still succeeds whenever the provider
happened to be scheduled first — it simply is not guaranteed, and the undeclared case fails with
`DashboardError('unknown-service')` inside that plugin's `setup()`. Declare the edge for anything you
read during setup; ids are a shared vocabulary between plugins, checked only for uniqueness.

### Commands

```ts
api.command<number, number>('search.page', (page) => page + 1);
dashboard.execute<number, number>('search.page', 2);      // 3

api.command<void, Promise<Line[]>>('session.send', async (prompt) => fetchLines(prompt));
const pending = dashboard.execute('session.send');        // the handler's own promise
```

`execute` returns whatever the handler returned: no `await`, no re-wrapping, so async commands
stay async and cancelable. Handler exceptions (thrown or rejected) propagate unchanged — the
framework never rewrites a plugin's errors.

### Events

```ts
const stop = api.on<{ id: string }>('session.open', (payload) => paint(payload));
dashboard.emit('session.open', { id: 's-1' });
stop();                                     // idempotent, harmless after dispose
```

Event names are never declared: emitting into a channel nobody listens to is a no-op. Events are
**live signals only** — nothing is queued, debounced or replayed, so a listener that was not attached
at the moment of the emit never sees that payload and a view that mounts later must read
`state(id).get()` for the truth. Payloads are passed by reference. Listeners run synchronously in
subscription order; **one throwing listener cannot starve the others** — every listener runs, and
then a single `DashboardError('listener-failed')` reports all of the failures (`cause` is the first,
`errors` is every one).

A listener may `emit` from inside a delivery, and there is **no recursion guard**: the nested emit
runs to completion before the interrupted pass continues with its remaining listeners, so delivery is
depth-first (`emit('tick', 2)` → a listener emits `1` → which emits `0` → that whole inner pass
finishes → then the outer pass resumes). Every listener of the channel observes the nested
emissions; bounding the recursion is the emitter's responsibility.

### Slots

```ts
api.slot<Panel>('panels', { id: 'transcript', order: 0, value: transcriptPanel });
api.slot<Panel>('panels', { id: 'composer', order: 10, value: composerPanel });

dashboard.slot<Panel>('panels');   // [transcriptPanel, composerPanel] as frozen records
dashboard.slot<Panel>('sidebar');  // [] — an unmentioned slot is simply empty
```

Slots are **open named channels**: no layout is predefined, nothing needs to declare a slot
before it can be contributed to, and unknown slot names are never dropped. The snapshot is
sorted by `order` (default `0`) ascending, ties broken by registration order, then frozen — so
a host can cache it by reference. A contribution's `value` is opaque: a descriptor object, a
string, a function, anything.

## Composing behaviour

- **Ordering.** `requires` is the only ordering mechanism, and it is declarative. Setup runs in
  a depth-first, dependency-first, declaration-stable order; `instance.plugins` reports the
  order that actually ran. The same input always produces the same schedule.
- **Whole-graph validation first.** Duplicate ids, unknown dependencies and cycles are rejected
  **before any `setup()` call**, so a plugin can assume that if it ran, the graph was valid.
- **Registration is scoped.** `state`, `service`, `command` and `slot` are legal only while that
  plugin's own `setup()` is on the stack. Late registration throws
  `DashboardError('registration-out-of-scope')` rather than creating something no teardown owns —
  and that includes a handle retained by the plugin whose `setup()` just failed, whose authorization
  is cleared before the rollback starts.
- **Runtime is not scoped.** `getService`, `execute`, `on` and `emit` stay legal for the whole
  lifetime, so a retained `api` inside a command handler or event listener keeps working.
- **Rollback.** If any `setup()` throws (or returns an invalid value), the phase moves to
  `disposing` first, then the plugins that already ran are cleaned up in reverse order and the build
  is discarded. A throw reports `DashboardError('setup-failed')` with the original error as `cause`
  and any rollback cleanup failures in `errors`; an invalid return value reports
  `'invalid-cleanup'` with **no** `cause` (plugin code threw nothing) and the same `errors` channel.
  During that rollback, cleanups keep full runtime access but no registration is accepted anywhere.

```ts
// The plugin factory pattern is how a plugin receives a value it cannot reach through a
// service, e.g. a state cell owned by the composing application:
const withSelection = (selection: DashboardState<string[]>, id = 'selection'): DashboardPlugin => ({
    id,
    setup: (api) => {
        api.command<string, string[]>('selection.set', (value) => {
            selection.set([value]);
            return selection.get();
        });
    },
});
```

## Disposal

```ts
instance.dispose();     // reverse setup order, then drop everything
instance.dispose();     // idempotent no-op
instance.disposed;      // true
```

Dispose runs each plugin's cleanup in **reverse setup order** (a consumer is torn down before
the provider it depends on). Cleanup errors never stop the rest of the teardown; they are
collected and reported as `DashboardError('cleanup-failed')` — `cause` is the first failure,
`errors` is every one — after the dashboard is already disposed. While cleanups run, the dashboard
is in a `disposing` phase: reads, state writes, commands and emits stay legal (that is how a plugin
persists what it collected) while no registration is accepted anywhere. Afterwards every operation
throws `DashboardError('disposed')`; outstanding unsubscribe handles stay harmless. A cleanup may
call `dispose()` itself and that re-entrant call is ignored, and a second `dispose()` after a
`cleanup-failed` is a no-op rather than a replay.

`dispose()` is not reachable during `setup()` at all: the instance exists only once `dashboard()`
has returned.

A `setup()` that returns something which is neither `void` nor a function — most often an
accidental `async setup()` — is rejected with `DashboardError('invalid-cleanup')`, because an
unawaited promise would silently drop the plugin's teardown. It has no `cause` (plugin code threw
nothing); rollback cleanup failures ride in `errors`.

## Errors

Every failure is a `DashboardError` with a stable machine-readable `code`; message text is
diagnostic only.

```ts
try {
    dashboard({ plugins });
} catch (error) {
    if (error instanceof DashboardError && error.code === 'cyclic-dependency') {
        console.error(error.message);      // 'Plugin dependencies form a cycle: a -> b -> a.'
    }
}
```

`cause` and `errors` follow one rule per code, and no plugin error is ever rewritten on the way out:

| `code` | `cause` | `errors` |
| --- | --- | --- |
| `setup-failed` | whatever that `setup()` threw, unmodified | the rollback cleanup failures |
| `invalid-cleanup` | `undefined` (plugin code threw nothing) | the rollback cleanup failures |
| `cleanup-failed` | the first collected cleanup failure | every cleanup failure |
| `listener-failed` | the first throwing listener's error | every listener failure |
| any other code | `undefined` | `[]` |

The full code table, the phase semantics, the slot/sort rules and the harness-adapter contract are
in [docs/specification.md](https://github.com/underloadjs/dashboard/blob/main/docs/specification.md)
— linked absolutely because `docs/` is not part of the npm tarball, so the published README must
stay readable on npmjs.com.

## Example app, Pages, and repo scripts

- **[example/README.md](https://github.com/underloadjs/dashboard/blob/main/example/README.md)** — a
  separately styled React host that consumes this API through
  `DashboardPlugin`s only (the shell holds no feature list: register a plugin, a panel appears). It is **never
  published** — `files: ["dist"]` keeps the tarball to the library plus npm's default includes — and its
  transport is a **static simulation**: it reads fixtures in `example/src/data/fixtures.ts`, with no backend, no
  network and no `@underload/harness` import. `npm run example:dev`, `example:build`, `example:preview` and
  `test:example` drive it locally.
- **GitHub Pages** — `.github/workflows/deploy-pages.yml` typechecks, tests, builds the library and the example,
  then publishes `example/dist` on pushes to `main` (and on `workflow_dispatch`). Enable it once: repo
  **Settings → Pages → Build and deployment → Source: `GitHub Actions`**, then push or run the workflow manually.
- **`scripts/`** — build-layer tooling, also not published.
  `scripts/fix-declaration-specifiers.mjs` runs as the last step of `npm run build` and rewrites the emitted
  declarations to explicit `.js` relative specifiers, which is what makes them readable by a
  `module`/`moduleResolution: NodeNext` consumer (`--check` asserts the built tree is in that state);
  `scripts/fix-declaration-specifiers.test.mjs` (`npm run test:package:scripts`) covers that rewrite.
  `scripts/check-package.mjs` (`npm run test:package`) packs the library shape, compiles real NodeNext and
  bundler consumers against the packed install and runs the built bundle in Node — the gate `prepublishOnly`
  enforces before a release.

## What this framework does not do

- **No rendering.** No DOM, React, CSS or framework import anywhere in `src/`. A host turns
  `slot()` snapshots and `state()` cells into views.
- **No wire types.** No session, transcript, message, tool or provider DTO. A product with an
  existing wire format keeps it; a plugin adapts it into services, state and commands.
- **No migration.** Adopting a plugin means adding a plugin. Existing UIs can read a dashboard,
  write to one, or both, without being rewritten.
- **Not a sandbox.** Plugins are trusted code that runs in the host's own realm: the framework
  evaluates nothing, injects no HTML, and does no `eval`/`dangerouslySetInnerHTML` of its own.
  It isolates *state*, not *code* — a plugin is expected to treat other plugins' values as
  read-only and to keep contributions immutable.

## License

ISC
