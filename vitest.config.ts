import { defineConfig } from 'vitest/config';

// jsdom environment because this package ships React dashboard
// hooks/components — mirrors packages/underload/react and the root
// vitest.config.ts so tests share the same base setup.
// Discovery is scoped to this package's src/ tree so vitest never picks up
// files from neighbouring workspaces when run from the monorepo root.
export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx}'],
        passWithNoTests: true,
        exclude: ['**/node_modules/**'],
        testTimeout: 15000
    }
});
