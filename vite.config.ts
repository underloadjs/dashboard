// Vite config for the @underload/dashboard LIBRARY build (`npm run build`).
//
// Output map (matches the `exports` map in package.json):
//   src/dashboard.ts -> dist/underload-dashboard.mjs   (single ESM bundle)
//
// Declarations are emitted separately by `tsc -p tsconfig.build.json` (repo
// convention, see packages/presource/core/package.json "build" and
// packages/underload/harness/vite.config.ts).
//
// Why a bundled lib entry instead of plain `tsc` JS emit: the core is laid out
// as src/dashboard.ts plus the src/core, src/extensions, src/plugin and src/types
// layer folders, and tsc never rewrites relative specifiers, so extensionless
// imports (`./core`, `../core/errors`) would ship as invalid Node ESM. Rolling the
// graph into one file keeps dist/underload-dashboard.mjs a valid ESM module
// regardless of how src/ is laid out.
//
// `emptyOutDir: true` is safe because the publish order is
// `vite build && tsc -p tsconfig.build.json`: Vite clears dist first, tsc adds
// the .d.ts tree afterwards.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    // Pin the root to this folder so `vite build` works from any cwd (the CI
    // workflow runs it from the package root; the monorepo turbo runner does too).
    root: fileURLToPath(new URL('.', import.meta.url)),
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
        lib: {
            // Addressed by absolute source path: a missing entry fails the build
            // instead of emitting an empty module.
            entry: fileURLToPath(new URL('./src/dashboard.ts', import.meta.url)),
            formats: ['es'],
            fileName: () => 'underload-dashboard.mjs'
        },
        rollupOptions: {
            // The core is dependency-free (no runtime `dependencies` in
            // package.json), so nothing may be bundled in except its own src/
            // graph. Node builtins stay external for the defensive case where a
            // future module touches one.
            external: [/^node:/]
        }
    }
});
