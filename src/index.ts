// @underload/dashboard — the package's single public entry (barrel).
//
// One runtime factory plus one error class and the types that describe them.
// Nothing DOM/React/CSS/harness-specific is exported, and nothing internal
// (ListenerSet, the registries, the scheduler) leaks out, so the headless
// framework can be consumed by any host without an adapter becoming coupled to
// an implementation detail.
//
// `DashboardErrorDetails` and `DashboardErrorCode` are type-only exports: the
// first appears in DashboardError's public constructor signature, so a consumer
// must be able to name it. Type-only exports erase at build time, which is why
// the runtime surface stays exactly `dashboard` + `DashboardError` (pinned in
// ./index.test.ts).
//
// Cross-references:
//   - ./dashboard.ts — dashboard() and the plugin lifecycle
//   - ./types.ts     — every public type, documented in place
//   - ./errors.ts    — DashboardError + the code list
//   - ../README.md and ../docs/specification.md — the prose contract (the README
//     links the specification by absolute URL because docs/ is not in the npm tarball)

export { dashboard } from './dashboard';
export { DashboardError } from './errors';

export type { DashboardErrorCode, DashboardErrorDetails } from './errors';
export type {
    Dashboard,
    DashboardContribution,
    DashboardContributionInput,
    DashboardOptions,
    DashboardPlugin,
    DashboardPluginAPI,
    DashboardState,
} from './types';
