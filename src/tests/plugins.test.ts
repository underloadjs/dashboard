// Plugin input validation and deterministic dependency ordering.
//
// The contract pinned here:
//   - dashboard() / dashboard({}) / dashboard({ plugins: [] }) are all an empty dashboard
//   - malformed input and graph problems (duplicate ids, missing edges, cycles)
//     are rejected BEFORE any setup() runs, with an exact DashboardErrorCode
//   - the schedule is depth-first, dependency-first and declaration-stable, and
//     instance.plugins reports the order setup() really ran in
//
// Error MESSAGES are diagnostic only (see ../core/errors.ts), so failures are pinned by
// code, with the offending ids asserted as substrings.
//
// Cross-references: ../plugin/order.ts (scheduler), ../dashboard.ts (call site),
// ./lifecycle.test.ts (setup/cleanup ordering once the graph is valid).

import { describe, expect, it } from 'vitest';

import { DashboardError, dashboard } from '../dashboard';
import type { DashboardPlugin, DashboardPluginAPI } from '../types';

// Extracts the DashboardError a call must throw, so an unexpected error type (or
// no error at all) fails the test with a readable message instead of passing.
function failureOf(operation: () => unknown): DashboardError {
    try {
        operation();
    } catch (error) {
        if (error instanceof DashboardError) return error;
        throw new Error(`Expected a DashboardError, received ${String(error)}`);
    }
    throw new Error('Expected the call to throw, but it completed normally.');
}

describe('dashboard() options', () => {
    it('accepts no options, empty options and an empty plugin list identically', () => {
        const variants = [dashboard(), dashboard({}), dashboard({ plugins: [] }), dashboard({ plugins: undefined })];
        const observed = [];
        let index = 0;
        while (index < variants.length) {
            const instance = variants[index];
            observed.push({ plugins: instance.plugins.slice(), disposed: instance.disposed });
            index += 1;
        }
        expect(observed).toEqual([
            { plugins: [], disposed: false },
            { plugins: [], disposed: false },
            { plugins: [], disposed: false },
            { plugins: [], disposed: false },
        ]);
    });

    it('ignores unknown option keys so the options shape can grow', () => {
        const instance = dashboard({ plugins: [], futureFlag: true } as never);
        expect(instance.plugins).toEqual([]);
        expect(instance.disposed).toBe(false);
    });

    it('rejects a non-object options argument', () => {
        expect(failureOf(() => dashboard('plugins' as never)).code).toBe('invalid-options');
        expect(failureOf(() => dashboard([] as never)).code).toBe('invalid-options');
    });

    it('rejects a plugin list that is not an array', () => {
        const error = failureOf(() => dashboard({ plugins: {} as never }));
        expect(error.code).toBe('invalid-options');
        expect(error.message).toContain('plugins');
    });
});

describe('plugin shape validation', () => {
    it('rejects an entry that is not an object', () => {
        const error = failureOf(() => dashboard({ plugins: [null as never] }));
        expect(error.code).toBe('invalid-plugin');
        expect(error.message).toContain('index 0');
    });

    it('rejects a plugin without a callable setup', () => {
        const error = failureOf(() => dashboard({ plugins: [{ id: 'plain' } as never] }));
        expect(error.code).toBe('invalid-plugin');
        expect(error.message).toContain('plain');
    });

    it('rejects a missing or empty plugin id', () => {
        expect(failureOf(() => dashboard({ plugins: [{ setup: () => undefined } as never] })).code).toBe('invalid-plugin-id');
        const empty = failureOf(() => dashboard({ plugins: [{ id: '', setup: () => undefined } as never] }));
        expect(empty.code).toBe('invalid-plugin-id');
        expect(empty.message).toContain('index 0');
    });

    it('rejects a requires list that is not an array of plugin ids', () => {
        const notArray = failureOf(() => dashboard({ plugins: [{ id: 'a', requires: 'b', setup: () => undefined } as never] }));
        expect(notArray.code).toBe('invalid-plugin-requires');
        expect(notArray.message).toContain('a');

        const badEntry = failureOf(() => dashboard({ plugins: [{ id: 'a', requires: [''], setup: () => undefined } as never] }));
        expect(badEntry.code).toBe('invalid-plugin-requires');
        expect(badEntry.message).toContain('requires[0]');
    });
});

describe('plugin graph resolution', () => {
    // Every case below must reject without a single setup() having run.
    function tracked(id: string, log: string[], requires: readonly string[] = []): DashboardPlugin {
        return {
            id,
            requires,
            setup: () => {
                log.push(id);
            },
        };
    }

    it('rejects a duplicate plugin id and reports both indexes', () => {
        const log: string[] = [];
        const error = failureOf(() => dashboard({ plugins: [tracked('a', log), tracked('b', log), tracked('a', log)] }));
        expect(error.code).toBe('duplicate-plugin-id');
        expect(error.message).toContain('"a"');
        expect(error.message).toContain('index 0 and index 2');
        expect(log).toEqual([]);
    });

    it('rejects a missing dependency before any setup', () => {
        const log: string[] = [];
        const error = failureOf(() => dashboard({ plugins: [tracked('app', log, ['transport']), tracked('util', log)] }));
        expect(error.code).toBe('missing-dependency');
        expect(error.message).toContain('Plugin "app" requires "transport"');
        // The message lists what IS available, which is what makes the mistake
        // obvious without reading the plugin source.
        expect(error.message).toContain('"app", "util"');
        expect(log).toEqual([]);
    });

    it('reports the first missing edge in declaration order', () => {
        const log: string[] = [];
        // "b" is declared before "a", so b -> ghost is the first bad edge found.
        const error = failureOf(() => dashboard({
            plugins: [tracked('b', log, ['ghost']), tracked('a', log, ['phantom'])],
        }));
        expect(error.code).toBe('missing-dependency');
        expect(error.message).toContain('"b" requires "ghost"');
    });

    it('rejects a self dependency as a cycle', () => {
        const log: string[] = [];
        const error = failureOf(() => dashboard({ plugins: [tracked('loop', log, ['loop'])] }));
        expect(error.code).toBe('cyclic-dependency');
        expect(error.message).toContain('loop -> loop');
        expect(log).toEqual([]);
    });

    it('rejects a two-plugin cycle', () => {
        const log: string[] = [];
        const error = failureOf(() => dashboard({
            plugins: [tracked('x', log, ['y']), tracked('y', log, ['x'])],
        }));
        expect(error.code).toBe('cyclic-dependency');
        expect(error.message).toContain('x -> y -> x');
        expect(log).toEqual([]);
    });

    it('rejects a three-plugin cycle that starts away from the entry point', () => {
        const log: string[] = [];
        const error = failureOf(() => dashboard({
            plugins: [tracked('a', log, ['b']), tracked('b', log, ['c']), tracked('c', log, ['a'])],
        }));
        expect(error.code).toBe('cyclic-dependency');
        expect(error.message).toContain('a -> b -> c -> a');
        expect(log).toEqual([]);
    });

    it('treats a self-dependency inside an otherwise valid graph as a cycle', () => {
        const log: string[] = [];
        // a and b are fine; c points at itself, so the whole build is discarded.
        const error = failureOf(() => dashboard({
            plugins: [tracked('a', log), tracked('b', log, ['a']), tracked('c', log, ['c'])],
        }));
        expect(error.code).toBe('cyclic-dependency');
        expect(log).toEqual([]);
    });
});

describe('deterministic setup ordering', () => {
    function probe(log: string[], id: string, requires: readonly string[] = []): DashboardPlugin {
        return {
            id,
            requires,
            setup: () => {
                log.push(id);
            },
        };
    }

    it('keeps declaration order when nothing depends on anything', () => {
        const log: string[] = [];
        const instance = dashboard({ plugins: [probe(log, 'a'), probe(log, 'b'), probe(log, 'c')] });
        expect(log).toEqual(['a', 'b', 'c']);
        expect(instance.plugins).toEqual(['a', 'b', 'c']);
    });

    it('sets up a required plugin first even when it is declared last', () => {
        const log: string[] = [];
        const instance = dashboard({ plugins: [probe(log, 'app', ['util']), probe(log, 'util')] });
        expect(log).toEqual(['util', 'app']);
        expect(instance.plugins).toEqual(['util', 'app']);
    });

    it('orders a transitive chain depth-first', () => {
        const log: string[] = [];
        const instance = dashboard({
            plugins: [probe(log, 'c', ['b']), probe(log, 'a'), probe(log, 'b', ['a'])],
        });
        expect(log).toEqual(['a', 'b', 'c']);
        expect(instance.plugins).toEqual(['a', 'b', 'c']);
    });

    it('is depth-first and declaration-stable: a dependency subtree completes before the next declared plugin', () => {
        const log: string[] = [];
        // Declared: app(->util), log, util. Visiting app pulls util in first,
        // then app itself completes, and the untouched sibling `log` is emitted
        // after that whole subtree. Same input, same order, every time.
        const instance = dashboard({
            plugins: [probe(log, 'app', ['util']), probe(log, 'log'), probe(log, 'util')],
        });
        expect(log).toEqual(['util', 'app', 'log']);
        expect(instance.plugins).toEqual(['util', 'app', 'log']);
    });

    it('schedules a diamond deterministically', () => {
        const log: string[] = [];
        const instance = dashboard({
            plugins: [
                probe(log, 'top', ['left', 'right']),
                probe(log, 'left', ['base']),
                probe(log, 'right', ['base']),
                probe(log, 'base'),
            ],
        });
        expect(log).toEqual(['base', 'left', 'right', 'top']);
        expect(instance.plugins).toEqual(['base', 'left', 'right', 'top']);
    });

    it('produces the same order on repeated builds', () => {
        const first: string[] = [];
        const second: string[] = [];
        const build = (log: string[]) => dashboard({
            plugins: [
                probe(log, 'app', ['util', 'bus']),
                probe(log, 'bus', ['util']),
                probe(log, 'util'),
            ],
        });
        build(first);
        build(second);
        expect(first).toEqual(['util', 'bus', 'app']);
        expect(second).toEqual(first);
    });

    it('reports plugins as a frozen snapshot of the setup order', () => {
        const log: string[] = [];
        const instance = dashboard({ plugins: [probe(log, 'app', ['util']), probe(log, 'util')] });
        expect(Object.isFrozen(instance.plugins)).toBe(true);
        // The snapshot is the *setup* order, not the declaration order, and it
        // survives dispose() so a host can still log what ran.
        expect(instance.plugins).toEqual(['util', 'app']);
        instance.dispose();
        expect(instance.plugins).toEqual(['util', 'app']);
    });

    it('lets a plugin read a required plugin service during setup', () => {
        const log: string[] = [];
        const provider: DashboardPlugin = {
            id: 'provider',
            setup: (api: DashboardPluginAPI) => {
                api.service('client', { baseUrl: 'http://localhost:5500' });
                log.push('provider');
            },
        };
        const consumer: DashboardPlugin = {
            id: 'consumer',
            requires: ['provider'],
            setup: (api: DashboardPluginAPI) => {
                log.push(`consumer:${api.getService<{ baseUrl: string }>('client').baseUrl}`);
            },
        };
        dashboard({ plugins: [consumer, provider] });
        expect(log).toEqual(['provider', 'consumer:http://localhost:5500']);
    });
});
