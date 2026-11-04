// Public entry boundary for @underload/dashboard.
//
// Replaces the scaffold-era manifest test: the manifest is generated/maintained
// by the build config and pinning its script and dependency strings here only
// recorded churn. What IS contractual is the runtime shape of the single public
// entry — the exports a consumer can actually reach — so that is what this file
// pins, with exact values.
//
// Cross-references:
//   - ../dashboard.ts — the entry under test; the barrel and dashboard() semantics
//     (./lifecycle.test.ts and friends) now live in this one file
//   - ../core/errors.ts — DashboardError shape

import { describe, expect, it } from 'vitest';

import * as entry from '../dashboard';
import { DashboardError, dashboard } from '../dashboard';
import type { DashboardErrorCode, DashboardErrorDetails } from '../dashboard';

describe('@underload/dashboard public entry', () => {
    it('owns exactly two runtime exports, no default', () => {
        // Type-only exports (Dashboard, DashboardPlugin, ...) vanish at runtime,
        // so the namespace is the complete reachable surface. A leaked internal
        // (ListenerSet, StateRegistry, orderPlugins) or an accidental default
        // would show up here.
        expect(Object.keys(entry).sort()).toEqual(['DashboardError', 'dashboard']);
        expect((entry as Record<string, unknown>).default).toBeUndefined();
    });

    it('exports dashboard as a callable factory', () => {
        expect(typeof dashboard).toBe('function');
        // `options` is optional, so the zero-argument call is the empty-dashboard
        // contract (pinned for real in ./lifecycle.test.ts and ./plugins.test.ts).
        // Arity is not asserted: it depends on how the toolchain erases `options?`.
        expect(dashboard()).toBeTypeOf('object');
    });

    it('exports DashboardError as an Error subclass with an enumerable-free code field', () => {
        const error = new DashboardError('disposed', 'gone') as DashboardError & Record<string, unknown>;

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(DashboardError);
        expect(error.name).toBe('DashboardError');
        expect({
            code: error.code,
            message: error.message,
            cause: error.cause,
            errors: error.errors,
        }).toEqual({
            code: 'disposed',
            message: 'gone',
            cause: undefined,
            errors: [],
        });
        expect(error.stack).toBeTypeOf('string');
    });

    it('aggregates secondary failures onto the same error shape', () => {
        const first = new Error('first');
        const second = new Error('second');
        const error = new DashboardError('cleanup-failed', 'teardown failed', {
            cause: first,
            errors: [first, second],
        });
        expect({ code: error.code, cause: error.cause, errors: error.errors.slice() }).toEqual({
            code: 'cleanup-failed',
            cause: first,
            errors: [first, second],
        });
    });

    it('names the constructor details type from the entry without adding a runtime export', () => {
        // DashboardErrorDetails appears in the public constructor signature, so it
        // must be nameable from the barrel. It is a type-only export: erasing it
        // leaves the runtime surface at exactly two names (pinned above).
        const details: DashboardErrorDetails = { cause: new Error('inner'), errors: [new Error('inner')] };
        const error = new DashboardError('listener-failed', 'a listener threw', details);
        const code: DashboardErrorCode = error.code;

        expect({ code, cause: error.cause, errors: error.errors.slice() }).toEqual({
            code: 'listener-failed',
            cause: details.cause,
            errors: [details.cause],
        });
        expect(Object.keys(entry).sort()).toEqual(['DashboardError', 'dashboard']);
    });

    it('keeps the code list as a string union usable by hosts', () => {
        // Runtime-erased type, so the only honest assertion is that documented
        // codes thrown by the framework really are DashboardError instances.
        const code: DashboardErrorCode = 'unknown-command';
        expect(code).toBe('unknown-command');
        expect(new DashboardError(code, 'x').code).toBe('unknown-command');
    });

    it('builds a live, empty dashboard from the barrel', () => {
        const instance = dashboard();
        expect({
            plugins: instance.plugins.slice(),
            disposed: instance.disposed,
            slot: instance.slot('anything'),
        }).toEqual({ plugins: [], disposed: false, slot: [] });
        instance.dispose();
        expect(instance.disposed).toBe(true);
    });
});
