// Shared resolution rules for the example app's two Vite entry points
// (vite.config.ts for dev/build, vitest.config.ts for tests).
//
// One source of truth is deliberate: dev, build, and test must resolve
// '@underload/dashboard' and the deployment base path identically, otherwise a
// green test suite would not say anything about the deployed bundle.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute path of example/ (this file's directory), cwd-independent. Uses
// `fileURLToPath(import.meta.url)` like packages/underload/harness/vite.config.ts:
// `__dirname` is unreliable inside a "type": "module" package.
export const EXAMPLE_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Alias target for '@underload/dashboard'.
//
//   default          ../src/index.ts  (library SOURCE — dev, CI, and tests)
//   DASHBOARD_ENTRY  overrides the target: an absolute path (or a cwd-relative
//                    one, `path.resolve` keeps absolutes as-is) pointing at e.g.
//                    the published dist bundle, or at a stub entry used to
//                    exercise the example while the core source is in flight.
export function exampleResolve(): { alias: Record<string, string> } {
    const override = process.env.DASHBOARD_ENTRY;
    return {
        alias: {
            '@underload/dashboard': override
                ? path.resolve(EXAMPLE_ROOT, override)
                : path.resolve(EXAMPLE_ROOT, '../src/index.ts')
        }
    };
}

// Normalise a deployment subpath into Vite's leading+trailing slash form
// (mirrors packages/underload/harness/src/frontend/vite.config.ts).
export function normalizeBase(value: string | undefined): string {
    if (value === undefined) return '/';
    const trimmed = value.replace(/^\/+/, '').replace(/\/+$/, '');
    return trimmed.length === 0 ? '/' : `/${trimmed}/`;
}
