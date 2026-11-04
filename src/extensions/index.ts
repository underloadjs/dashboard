// `extensions` layer — the registries that ARE the extension points.
//
// Five open, id-keyed channels a plugin (or the host) publishes into:
//   - ./state.ts     — reactive cells          (api.state / dashboard.state)
//   - ./bus.ts       — event channels         (api.on / api.emit)
//   - ./registries.ts— services, commands, slots (api.service / api.command / api.slot)
//
// All of them are deliberately lifecycle-blind: they validate ids, reject
// duplicates and hand back values, but they never decide whether a call is legal
// right now — that is dashboard()'s job (../dashboard.ts wraps every call in a
// phase/owner guard). They sit on top of `core` for failure reporting and
// listener delivery, and nothing else.
//
// Barrel policy: see ./../core/index.ts — exact-path imports inside the layer,
// barrels consumed only by the composition root.

export { EventBus } from './bus';

export { createState, StateRegistry } from './state';
export type { ManagedState } from './state';

export { CommandRegistry, ServiceRegistry, SlotRegistry } from './registries';
export type { CommandHandler, CommandOwner, ServiceOwner } from './registries';
