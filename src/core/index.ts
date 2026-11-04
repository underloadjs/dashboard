// `core` layer — the primitives every other layer is built on.
//
// Nothing in here knows about plugins, ownership or the lifecycle. It is exactly:
//   - ./errors.ts    — DashboardError + the closed code list (the failure surface)
//   - ./validate.ts  — the identifier/handler guards every registry shares
//   - ./listeners.ts — the one notification channel backing state cells AND events
//
// This is the bottom of the dependency graph: `core` imports nothing from outside
// the folder, which is what lets extensions/ and plugin/ depend on it without
// ever forming a cycle.
//
// Barrel policy (applies to every layer folder): only the composition root
// (../dashboard.ts) consumes these barrels. Modules inside a layer import their
// dependency by exact path (`../core/errors`, never `../core`), so each file
// states precisely what it needs and a barrel can never pull in an edge nobody
// intended.

export { DashboardError, describeValue, fail } from './errors';
export type { DashboardErrorCode, DashboardErrorDetails } from './errors';

export { ListenerSet } from './listeners';
export type { Listener } from './listeners';

export { ownerLabel, requireHandler, requireIdentifier } from './validate';
