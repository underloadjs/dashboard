// Vite config for the example workstation app (`npm run example:dev` /
// `npm run example:build` / `npm run example:preview`).
//
// The example is NOT part of the published package: package.json ships
// `files: ["dist"]` and the library entry maps to dist/, so nothing under
// example/ can leak into the npm tarball.
//
// It consumes the framework exactly the way an external consumer does
// (`import { dashboard } from '@underload/dashboard'`), resolved from library
// SOURCE through the shared alias in ./vite-shared.ts — so the example tracks
// the in-flight core with no build-and-link dance, the same source-consumed
// convention packages/underload/bench already relies on.
//
// Base path: GitHub Pages serves this repo under /<repo-name>/ (currently
// /dashboard/), so .github/workflows/deploy-pages.yml passes
// `--base=/${{ github.event.repository.name }}/` (the convention from
// packages/underload/bench/.github/workflows/deploy-pages.yml). EXAMPLE_BASE is
// the env-var equivalent for a custom domain; the CLI flag wins over both.
// Documented in example/README.md.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { EXAMPLE_ROOT, exampleResolve, normalizeBase } from './vite-shared.ts';

export default defineConfig({
    // Pin the root to example/ so index.html and the build output stay inside
    // the example regardless of the invoking cwd.
    root: EXAMPLE_ROOT,
    base: normalizeBase(process.env.EXAMPLE_BASE),
    plugins: [react()],
    resolve: exampleResolve(),
    server: {
        // Fixed port so the example never collides with comfy (8100), bench
        // (8200) or the harness playground (5180).
        port: 8300,
        host: true
    },
    build: {
        // Relative to `root` (example/) -> example/dist, the Pages artifact.
        // Disjoint from the library output (dist/), so neither build clobbers
        // the other.
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true
    },
    preview: {
        port: 8300
    }
});
