// `plugin` layer — everything that must already be true about the plugin list
// before the first setup() runs.
//
// ./order.ts owns the two-phase build's first phase: input validation
// (dashboard(options) shape, plugin shape, ids, requires edges) and the
// deterministic dependency schedule. A dashboard that cannot be scheduled is
// discarded without a single plugin having observed it.
//
// Barrel policy: see ./../core/index.ts — consumed only by the composition root
// (../dashboard.ts).

export { orderPlugins, readPlugins } from './order';
