// Plugin input validation and deterministic dependency ordering.
//
// Everything in this file runs BEFORE any plugin's setup(): a dashboard that
// cannot be scheduled is discarded without a single plugin having observed it.
// That is the whole point of the two-phase build — plugin authors may assume
// that if their setup() ran, the graph is valid and their `requires` edges are
// already set up.
//
// Ordering rule (the contract's "deterministic"): depth-first over the declared
// list, emitting a plugin only after everything it requires. Independent plugins
// therefore keep their declared relative order, and the same input always
// produces the same execution order regardless of Map/Set behaviour.
//
// Cross-references: ../dashboard.ts (caller), ../core/errors.ts (codes below).

import { describeValue, fail } from '../core/errors';
import type { DashboardOptions, DashboardPlugin } from '../types';

// Accepts `dashboard()`, `dashboard({})` and `dashboard({ plugins: [] })`
// identically; unknown option keys are ignored so the shape can grow.
export function readPlugins(options: DashboardOptions | undefined | null): readonly DashboardPlugin[] {
    if (options === undefined || options === null) return [];
    if (typeof options !== 'object' || Array.isArray(options)) {
        fail('invalid-options', `dashboard() expects an options object, received ${describeValue(options)}.`);
    }

    const plugins = options.plugins;
    if (plugins === undefined || plugins === null) return [];
    if (!Array.isArray(plugins)) {
        fail('invalid-options', `dashboard options "plugins" must be an array, received ${describeValue(plugins)}.`);
    }
    return plugins as readonly DashboardPlugin[];
}

// Shape + identity + graph validation. Returns nothing: it exists so the
// ordering pass below can assume every id is unique and every edge resolvable.
function validatePlugins(plugins: readonly DashboardPlugin[]): Map<string, DashboardPlugin> {
    const byId = new Map<string, DashboardPlugin>();
    let index = 0;

    while (index < plugins.length) {
        const plugin = plugins[index];

        if (plugin === null || typeof plugin !== 'object') {
            fail('invalid-plugin',
                `Plugin at index ${index} must be an object with an id and a setup() function, received ${describeValue(plugin)}.`);
        }
        if (typeof plugin.setup !== 'function') {
            fail('invalid-plugin',
                `Plugin at index ${index} (${describeValue(plugin.id)}) must define a setup(api) function, received ${describeValue(plugin.setup)}.`);
        }

        const id = plugin.id;
        if (typeof id !== 'string' || id.length === 0) {
            fail('invalid-plugin-id',
                `Plugin at index ${index} must have a non-empty string id, received ${describeValue(id)}.`);
        }

        const requires = plugin.requires;
        if (requires !== undefined && requires !== null) {
            if (!Array.isArray(requires)) {
                fail('invalid-plugin-requires',
                    `Plugin "${id}" must declare requires as an array of plugin ids, received ${describeValue(requires)}.`);
            }
            let edge = 0;
            while (edge < requires.length) {
                const required = requires[edge];
                if (typeof required !== 'string' || required.length === 0) {
                    fail('invalid-plugin-requires',
                        `Plugin "${id}" declares requires[${edge}] as ${describeValue(required)}; every entry must be a non-empty plugin id.`);
                }
                edge += 1;
            }
        }

        const previous = byId.get(id);
        if (previous !== undefined) {
            // Checked here (not after the loop) so the message can name both indexes.
            const previousIndex = indexOfPlugin(plugins, id);
            fail('duplicate-plugin-id',
                `Plugin id "${id}" is declared twice (index ${previousIndex} and index ${index}); plugin ids must be unique within one dashboard().`);
        }
        byId.set(id, plugin);

        index += 1;
    }

    return byId;
}

function indexOfPlugin(plugins: readonly DashboardPlugin[], id: string): number {
    let index = 0;
    while (index < plugins.length) {
        if (plugins[index].id === id) return index;
        index += 1;
    }
    return -1;
}

// Emits a depth-first, dependency-first, declaration-stable schedule.
export function orderPlugins(plugins: readonly DashboardPlugin[]): readonly DashboardPlugin[] {
    const byId = validatePlugins(plugins);

    // Missing edges are resolved in one pass, in declaration order, so the first
    // reported failure is always the first bad edge a reader would find.
    let scan = 0;
    while (scan < plugins.length) {
        const plugin = plugins[scan];
        const requires = plugin.requires;
        if (requires !== undefined && requires !== null) {
            let edge = 0;
            while (edge < requires.length) {
                const required = requires[edge];
                if (!byId.has(required)) {
                    fail('missing-dependency',
                        `Plugin "${plugin.id}" requires "${required}", which is not among the plugins passed to dashboard(). ` +
                        `Known plugin ids: ${idList(byId)}.`);
                }
                edge += 1;
            }
        }
        scan += 1;
    }

    const scheduled: DashboardPlugin[] = [];
    const done = new Map<string, boolean>(); // fully emitted
    const onStack = new Map<string, boolean>(); // currently being visited
    const path: string[] = []; // ids on the current stack, for the cycle message

    const visit = (plugin: DashboardPlugin): void => {
        const id = plugin.id;
        if (done.get(id) === true) return;

        if (onStack.get(id) === true) {
            const start = path.indexOf(id);
            const cycle = path.slice(start < 0 ? 0 : start);
            cycle.push(id);
            fail('cyclic-dependency',
                `Plugin dependencies form a cycle: ${cycle.join(' -> ')}. ` +
                `Every requires edge must point at a plugin that can be set up first.`);
        }

        onStack.set(id, true);
        path.push(id);

        const requires = plugin.requires;
        if (requires !== undefined && requires !== null) {
            let edge = 0;
            while (edge < requires.length) {
                visit(byId.get(requires[edge]) as DashboardPlugin);
                edge += 1;
            }
        }

        path.pop();
        onStack.delete(id);
        done.set(id, true);
        scheduled.push(plugin);
    };

    let index = 0;
    while (index < plugins.length) {
        visit(plugins[index]);
        index += 1;
    }

    return scheduled;
}

function idList(byId: Map<string, DashboardPlugin>): string {
    const ids: string[] = [];
    byId.forEach((_plugin, id) => ids.push(`"${id}"`));
    return ids.length > 0 ? ids.join(', ') : '(none)';
}
