# Underload Workstation — example

A separately styled, harness-**inspired** demo of `@underload/dashboard`. It is
not a shipped part of the package: `package.json` publishes `files: ["dist"]`, the
entry maps to `dist/`, and this directory is only ever built as a static site.

The point of the example is to prove the framework is versatile rather than to
reproduce the harness: **every** visible capability (layout, theme, transport,
sessions, transcript, composer, instruments, scratch) arrives through the same
`DashboardPlugin` contract, and the shell holds no feature list — register a
plugin and a panel appears.

## Run it

```bash
yarn install           # standalone install — yarn1, no lockfile is committed
npm run example:dev      # http://localhost:8300
npm run example:build    # static site -> example/dist
npm run example:preview  # serve example/dist
npm run test:example     # jsdom suite for this directory only
```

**Why `yarn install` and not `npm install`:** npm 11.5.1 (the one bundled with Node 24)
crashes in `@npmcli/arborist` — `Cannot read properties of undefined (reading 'edgesOut')`
in `#loadPeerSet` — while resolving the `vitest` peer graph on a clean standalone install,
so a fresh `npm install` is currently unusable here (nothing in these scripts is involved).
Yarn 1 (classic, the toolchain this repo is developed with) resolves the same tree fine.
No lockfile is committed either way, so both resolve fresh on every run; `npm run …` above is
just the script runner and works against a yarn-installed `node_modules`. CI does exactly
this: `.github/workflows/deploy-pages.yml` pins `yarn@1.22.22` globally, then `yarn install`.
If `npm install` is required, use an older npm (e.g. 10.x) until the upstream resolver bug is
fixed.

`npm run typecheck` from the package root also covers this program
(`tsc --noEmit -p example/tsconfig.json`), and it resolves
`@underload/dashboard` through `paths` to `../src/index.ts` — the same module the
Vite alias in `vite-shared.ts` selects.

**`DASHBOARD_ENTRY` scope:** it overrides the **Vite** alias only — i.e. what
`example:dev`, `example:build` and `test:example` actually bundle and run. The
TypeScript side (`example/tsconfig.json` → `paths`) always typechecks against
`../src/index.ts` and is **not** redirected, so pointing `DASHBOARD_ENTRY` at a
published `dist/` bundle exercises that build at runtime while the types still
come from source. Set it to an absolute path (or one relative to `example/`);
`path.resolve` keeps absolutes as-is.

## What is on screen

| Region | Panels (slot order) | Registered by |
| --- | --- | --- |
| Session rail | Sessions | `plugins/sessions.ts` |
| Work stage | Transcript, Composer | `plugins/transcript.ts`, `plugins/composer.ts` |
| Instrument aside | Instruments, Scratch, Settings | `plugins/tools.ts`, `plugins/scratch.ts`, `plugins/theme.ts` |

The status strip is likewise slot-driven: brand chip (layout), active job chip
(sessions), instrument tally (tools), transport phase (source).

Interactions that actually do something: switch/create a session, type a prompt
and **Send** (the reply streams word-by-word and can be **Cancelled** mid-stream),
collapse an instrument trace, toggle **Follow output**, toggle an instrument
(the next simulated reply names it), pin/remove scratch notes, and flip theme
mode / density / motion in Settings.

**Sessions stream independently.** `source.status` is keyed by session id, so two
jobs can run at the same time: the status chip and the composer always describe
*the session on screen*, a completion in one job never relabels another, and
cancelling one leaves the rest running. The rule the model enforces is
single-flight **per session** — sending into a session that is already streaming
throws, while any other session is free to start. The chip shows `N jobs` when
more than one is live.

**Simulated, always.** The transport reads static fixtures in `src/data/fixtures.ts`
— no backend, no network, no `@underload/harness` import, and no external action
is ever taken. The footer states this on every page.

## GitHub Pages

`.github/workflows/deploy-pages.yml` builds the library and this site, then
publishes `example/dist` on pushes to `main` (and on `workflow_dispatch`).

**One-time repo setting** (nothing else needs touching; re-run the workflow
any time afterwards):

1. Repo **Settings** → **Pages** → **Build and deployment**.
2. **Source**: `GitHub Actions`.
3. Push to `main` (or run the workflow manually) and open the deployment URL,
   currently `https://underloadjs.github.io/dashboard/`.

The build passes `--base=/${{ github.event.repository.name }}/`, so asset URLs
resolve under the project subpath. For a **custom domain**, set the domain in the
Pages settings and build with a matching base instead, e.g.
`EXAMPLE_BASE=/` (or `npm run example:build -- --base=/workstation/`) — the CLI
flag always wins over the environment variable.

## Layout of this directory

```
index.html              app entry (Vite root = example/)
vite-shared.ts          one alias + base-path rule, shared by app and test configs
vite.config.ts          dev/build config
vitest.config.ts        jsdom test config (this directory only)
tsconfig.json           standalone typecheck program for the app
src/main.tsx            thin launcher: find #root, mount, wire HMR teardown
src/app/entry.tsx       mount + cleanup (React unmount, then core dispose)
src/app/                contract ids, composition root, blind shell, React bridge
src/plugins/            one plugin per capability (state/commands/services/slots)
src/components/         the React views the plugins register
src/data/fixtures.ts    all demo data + the palettes
src/support/clock.ts    timer seam: real in the browser, manual in tests
src/styles/             the workstation stylesheet (the example's own skin)
```

Hot reload matters here: `src/app/entry.tsx` tears the React tree down **before**
`instance.dispose()`, so no store notification can reach an unmounted component
and the transport's pending chunk timers are released (covered by
`src/app/entry.test.tsx`).

## Building and publishing this package

Two release paths exist, and neither is invented by the example:

- **Inside the noobscript monorepo** — `npm run release` runs
  `vite-node ../../../scripts/publish-safe.ts`, which only exists there. This is
  the path the workspace's `turbo run release` uses; the Pages workflow never
  calls it.
- **Standalone checkout** — publishing is plain `npm publish`, which fires the
  `prepublishOnly` gate (`typecheck`, `test`, `test:package:scripts`, `build`,
  `test:package`). The workflow runs those same checks on every push/PR, minus
  the publish itself: CI builds and deploys, it never publishes.
