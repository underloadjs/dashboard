// Vitest config for the EXAMPLE app only (`npm run test:example`).
//
// Separate from the library config (../vitest.config.ts), exactly as the
// harness splits its node tests from its UI tests
// (packages/underload/harness/src/frontend/vitest.config.ts): the example needs
// a DOM plus the React JSX transform, the library core deliberately has neither.
//
// `root` is pinned to example/ so the include glob stays short and the suite can
// never reach the library's src/** tests by accident. The '@underload/dashboard'
// alias comes from ./vite-shared so dev, build, and test resolve one module.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { EXAMPLE_ROOT, exampleResolve } from './vite-shared.ts';

export default defineConfig({
    root: EXAMPLE_ROOT,
    plugins: [react()],
    resolve: exampleResolve(),
    test: {
        // jsdom: every example test renders the workstation and drives it with
        // real DOM events (React + DOM), so an explicit DOM environment is
        // required here rather than inherited from the library config.
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        exclude: ['**/node_modules/**', 'dist/**'],
        passWithNoTests: false,
        testTimeout: 15000
    }
});
