// Vitest config for the LIBRARY side of the package (`npm test`).
//
// Scope is pinned to src/** so `vitest run` never picks up the example app's
// tests — those have their own jsdom config
// (example/vitest.config.ts, run by `npm run test:example`), mirroring the
// harness split (packages/underload/harness/vitest.config.ts vs
// src/frontend/vitest.config.ts).
//
// Environment stays `jsdom` (the scaffold default): the core itself is a
// generic dependency-free runtime with no DOM access, so a `node` environment
// would be sufficient, but jsdom keeps any future src/ test that mounts a
// React view working without a second config, and it costs nothing here
// because jsdom is already installed for the example suite.
//
// `root` is pinned to this folder so the include glob stays package-relative
// when the monorepo turbo runner invokes vitest from the workspace root.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx}'],
        // node_modules, both build outputs (dist = published bundle, lib =
        // stray tsc emit) and the example app are never test sources here.
        exclude: ['**/node_modules/**', 'dist/**', 'lib/**', 'example/**'],
        passWithNoTests: true,
        testTimeout: 15000
    }
});
