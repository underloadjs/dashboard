// Source-only resolution contract for @underload/dashboard (the package publishes
// TypeScript SOURCE; there is no build output for a consumer to resolve).
//
// What this file pins (all deterministic, every value read from the real files):
//   1. `main` / `module` / `types` stay on the SOURCE entry `./src/dashboard.ts`
//      (the legacy/`exports`-ignoring view, same convention as
//      packages/underload/harness and packages/presource/*);
//   2. the whole `exports` map, exactly: ONE public entry whose every condition
//      (`types` AND `default`) names the raw source entry, plus the
//      `./package.json` re-export — no `development` special case, no `import`
//      condition pointing at a bundle, and no `dist` target anywhere;
//   3. `files` stays the exact 7-entry list that publishes `src/` (minus its test
//      layer) and publishes NO build directory, so the export targets are not a 404
//      after install and no stale `dist/` can ride along;
//   4. every condition resolves to that ONE source file (the map has exactly 2 code
//      targets), the target really exists on disk, and no target names a build
//      artifact (`.mjs`/`.cjs`/`.d.ts`/`dist/`);
//   5. Vite's OWN resolver maps `@underload/dashboard` to `src/dashboard.ts` in dev
//      mode for BOTH `{ ssr: true }` (the SSR/test chain) and `{ ssr: false }` (the
//      client chain) and never to `dist/` — i.e. the manifest conditions, not a
//      hand-written alias, are what make a workspace run build-free;
//   6. drift guard for the in-repo consumer: `example/vite-shared.ts` aliases the
//      specifier at the SAME file as the manifest `default` target;
//   7. drift guard for the type side: `example/tsconfig.json` `paths` mirrors that
//      same file (kept because `paths` is what makes the example's own program land
//      on source instead of on an installed copy).
//
// Why these assertions exist at all: the library suite runs with `moduleResolution:
// bundler` and never resolves the package BY NAME, so it cannot see the manifest
// regressions that break real consumers. The packaging gate
// (../../scripts/check-package.ts §1) enforces the same contract for a PUBLISHED
// consumer; this file is the fast, build-free mirror of it, so a manifest edit fails
// `npm test` without any build step.
//
// Cross-references:
//   - ../../package.json                    — manifest fields asserted below
//   - ../../scripts/check-package.ts        — SOURCE_TARGET, EXPECTED_FILES,
//                                             EXPECTED_CONDITIONS and the
//                                             `exportTargets` walk mirrored here
//   - ../dashboard.ts                       — the source entry every condition names
//   - ../../vitest.config.ts                — jsdom environment + 15s testTimeout this
//                                             file's Vite probe relies on; its `include`
//                                             covers src/** and scripts/**
//   - ../../example/vite-shared.ts          — the consumer alias (item 6)
//   - ../../example/tsconfig.json           — the consumer `paths` mirror (item 7)
//   - packages/underload/harness/package.json + src/structure.test.ts — the same
//                                             source-only contract in the sibling
//                                             package; source of the
//                                             `stripJsonComments` and Vite-resolver
//                                             probe precedents

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { exampleResolve } from '../../example/vite-shared.ts';

// src/tests/ -> the package root, cwd-independent (matches vitest.config.ts's `root`).
//
// `import.meta.dirname` (Node >= 20.11) is used FIRST because this suite runs in the
// jsdom environment, where Vitest hands out a non-standard `import.meta.url`
// (`file:D:\...\resolution.test.ts`, backslashes, no `//` authority). `new URL('.',
// that)` does not round-trip: `fileURLToPath` rejects it with ERR_INVALID_URL_SCHEME.
// The URL form stays as the fallback for a plain-Node run (e.g. `vite-node`), where
// `import.meta.url` is a well-formed `file:///` URL.
const TEST_DIR: string = import.meta.dirname ?? fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(TEST_DIR, '..', '..');
const EXAMPLE_ROOT = path.join(PACKAGE_ROOT, 'example');

// Vite returns ids with platform separators, so both sides of every id comparison
// below are normalised to `/` and stay exact string equalities. `readText` is the one
// file reader for the manifest and for the JSONC example/tsconfig.json below.
const toPosix = (value: string): string => value.replace(/\\/g, '/');
const readText = (absolutePath: string): string => fs.readFileSync(absolutePath, 'utf8');

// Removes JSONC comment SYNTAX only: `//` runs to the end of the line and `/* */`
// blocks, but never inside a string literal.
//
// Why not the plain regex pair: example/tsconfig.json comments legitimately contain
// `src/*.ts` and `**/*.test.tsx`, and `/\/\*[\s\S]*?\*\//` reads the `/*` inside
// those as a block-comment opener — swallowing text up to a later `*/`, i.e. exactly
// the `paths` value this file asserts on. String-aware walk is the harness precedent
// (packages/underload/harness/src/structure.test.ts:66-108), which exists for the
// same reason.
const stripJsonComments = (text: string): string => {
    let out = '';
    let inString = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (inString) {
            // Inside a string only `\x` escapes are structural, so a `//` (a URL, a
            // glob) is copied verbatim.
            out += char;
            if (char === '\\') {
                out += next ?? '';
                index += 1;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            out += char;
        } else if (char === '/' && next === '/') {
            // Line comment: skip to the newline and keep it, so a parse error still
            // reports the original line number.
            while (index < text.length && text[index] !== '\n') index += 1;
            out += '\n';
        } else if (char === '/' && next === '*') {
            // Block comment: skip through the closing `*/`, keeping only its newlines
            // (same reason: line numbers must survive).
            index += 2;
            const end = text.indexOf('*/', index);
            out += (end === -1 ? text.slice(index) : text.slice(index, end)).replace(/[^\n]/g, '');
            index = end === -1 ? text.length : end + 1;
        } else {
            out += char;
        }
    }

    return out;
};

// One flattened row per string target of the exports map, mirroring the
// `exportTargets` walk in ../../scripts/check-package.ts EXACTLY, including the
// dot-prefixed condition path (root subpath `.` + key `types` => `..types`). Condition
// classification therefore compares bare condition NAMES after stripping the leading
// dots, the same way the gate does.
type ExportTarget = { subpath: string; condition: string; target: string };

const flattenExportTargets = (exportsMap: unknown): ExportTarget[] => {
    const targets: ExportTarget[] = [];

    const walk = (subpath: string, condition: string, value: unknown): void => {
        if (typeof value === 'string') {
            targets.push({ subpath, condition, target: value });
            return;
        }

        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
            walk(subpath, `${condition}.${key}`, nested);
        }
    };

    for (const [subpath, value] of Object.entries(exportsMap as Record<string, unknown>)) {
        walk(subpath, subpath, value);
    }

    return targets;
};

type PackageManifest = {
    main: string;
    module: string;
    types: string;
    exports: Record<string, unknown>;
    files: string[];
};

const manifest = JSON.parse(readText(path.join(PACKAGE_ROOT, 'package.json'))) as PackageManifest;

// `./package.json` is a manifest re-export, not code: excluded from every target
// family below (same filter as the gate's `targets` walk).
const exportTargets: ExportTarget[] = flattenExportTargets(manifest.exports);
const codeTargets: ExportTarget[] = exportTargets.filter(({ target }) => !target.endsWith('package.json'));

const bareCondition = (condition: string): string => condition.replace(/^\.+/u, '');
const isTypesCondition = (condition: string): boolean => bareCondition(condition) === 'types';
const isDefaultCondition = (condition: string): boolean => bareCondition(condition) === 'default';

const typesTargets: string[] = codeTargets.filter(({ condition }) => isTypesCondition(condition)).map(({ target }) => target);
const defaultTargets: string[] = codeTargets
    .filter(({ condition }) => isDefaultCondition(condition))
    .map(({ target }) => target);
// Anything that is neither: with a source-only map there is nothing else, so this list
// is expected to be empty (an added `import`/`browser`/`development` condition lands
// here and fails the exactness assertions below).
const otherTargets: string[] = codeTargets
    .filter(({ condition }) => !isTypesCondition(condition) && !isDefaultCondition(condition))
    .map(({ target }) => target);

// The single file every consumer-side mirror (alias, tsconfig `paths`, Vite resolver)
// must land on. Derived from the manifest `default` (runtime) target, not hardcoded, so
// item 6 and item 7 are drift guards against the manifest rather than against a literal.
const SOURCE_TARGET = defaultTargets.length === 1 ? defaultTargets[0] : '';
const SOURCE_ABSOLUTE = path.resolve(PACKAGE_ROOT, SOURCE_TARGET);

// Scratch root policy (root AGENTS.md): throwaway work goes in a repository-root
// `Temp/`, never the OS temp. Detection is the nearest ancestor carrying BOTH
// `AGENTS.md` and `Temp/` — inside the noobscript workspace that is the workspace
// root, not this package; a standalone `underloadjs/dashboard` checkout falls back to
// the package's own ignored `Temp/`. Pattern copied from the gate's
// `findWorkspaceRoot` (../../scripts/check-package.ts), which this package mirrors
// locally because it must stay self-contained, not import a monorepo helper.
const findWorkspaceRoot = (start: string): string | undefined => {
    let current = path.resolve(start);

    for (;;) {
        if (fs.existsSync(path.join(current, 'AGENTS.md')) && fs.existsSync(path.join(current, 'Temp'))) return current;

        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
};

const workspaceRoot = findWorkspaceRoot(PACKAGE_ROOT);
const scratchRoot =
    workspaceRoot === undefined
        ? path.join(PACKAGE_ROOT, 'Temp', 'underload-dashboard')
        : path.join(workspaceRoot, 'Temp', 'underload-dashboard');

describe('@underload/dashboard source-first resolution', () => {
    it('resolves legacy main/module/types fields to the source entry', () => {
        // What a `moduleResolution: node10` consumer (and any bundler that ignores
        // `exports`) reads. They must name the SOURCE, exactly like every other
        // workspace library, so an entry rename landing only in `exports` fails here.
        // Pinned in check-package.mjs:253-255 as well.
        expect(manifest.main).toBe('./src/dashboard.ts');
        expect(manifest.module).toBe('./src/dashboard.ts');
        expect(manifest.types).toBe('./src/dashboard.ts');
    });

    it('publishes source for every condition, and no build artifact for any', () => {
        // The whole map, exact: one public code entry plus the `./package.json`
        // re-export, and BOTH conditions naming the raw source entry (conditions are
        // matched in declaration order, and with `types` first a TS host is steered to
        // the same file a bundler executes). A condition that moved back onto
        // `./dist/…` would resolve to nothing, because this package has no build step.
        expect(manifest.exports).toEqual({
            '.': {
                types: './src/dashboard.ts',
                default: './src/dashboard.ts',
            },
            './package.json': './package.json',
        });
    });

    it('ships src/ only in files, so the export targets survive install without a build', () => {
        // Both halves of this list are defects when broken: dropping `src` turns every
        // export target into a 404 after install; adding a build directory (`dist`)
        // publishes an artifact this package no longer produces; and dropping any
        // `!src/**` negation ships the test layer (this very file) to every consumer.
        // Exact multiset and order — the gate's EXPECTED_FILES pins the same array.
        expect(manifest.files).toEqual([
            'src',
            '!src/**/*.test.ts',
            '!src/**/*.test.tsx',
            '!src/**/*.spec.ts',
            '!src/**/*.spec.tsx',
            '!src/**/__snapshots__/**',
            '!src/**/node_modules/**',
        ]);
    });

    it('routes every condition to exactly one source file', () => {
        // Condition-level proof, independent of the map shape above: `types` and
        // `default` both name the raw source entry, and nothing else is published (a
        // `development`/`import`/`browser` condition would land in `otherTargets` and
        // force an explicit decision about which artifact a host gets).
        expect(typesTargets).toEqual(['./src/dashboard.ts']);
        expect(defaultTargets).toEqual(['./src/dashboard.ts']);
        expect(otherTargets).toEqual([]);

        // No condition may point at a build artifact: `dist/`, `.mjs`, `.cjs` and
        // `.d.ts` spellings are the exact regressions the source-only ruling retires.
        for (const target of codeTargets.map(({ target }) => target)) {
            expect(/(?:^|\/)dist\/|\.(?:mjs|cjs|d\.ts)$/u.test(target)).toBe(false);
        }

        // Exactly 2 code targets, i.e. the two conditions above and no extras
        // (mirrors EXPECTED_CONDITIONS in ../../scripts/check-package.ts).
        expect(codeTargets.length).toBe(2);
        expect(codeTargets.map(({ condition }) => bareCondition(condition)).sort()).toEqual(['default', 'types']);

        // A dangling target is a resolution failure for every consumer, so the file it
        // names has to exist in the tree.
        expect(fs.existsSync(path.join(PACKAGE_ROOT, './src/dashboard.ts'))).toBe(true);
    });

    it('resolves the specifier to source for a dev/test host, never to dist', async () => {
        // The claim in ../../vitest.config.ts ("no build needed") is only true because
        // every export condition names the source, so the proof goes through Vite's OWN
        // resolver rather than a re-implementation: `createServer` runs in dev mode,
        // where Vite selects the `default` condition (a TS host picks `types`, and both
        // point at the same file).
        //
        // BOTH `ssr` modes are pinned because they are two different resolution
        // chains: `ssr: true` is the one Vitest's node/ssr pipeline uses, `ssr:
        // false` the client/browser chain. If only one resolved to source, a browser
        // example run could silently evaluate the stale bundle while the suite stays
        // green.
        //
        // `configFile: false` keeps the probe about manifest conditions only (no
        // example alias in play), and `cacheDir` is a scratch directory under the
        // repository-root `Temp/` (AGENTS.md policy): the suite that runs this file
        // owns `node_modules/.vite`, so a nested dev server must not disturb its
        // optimize-deps cache.
        const { createServer } = await import('vite');
        const scratch = path.join(scratchRoot, `resolution-${process.pid}-${Date.now()}`);

        const server = await createServer({
            configFile: false,
            root: PACKAGE_ROOT,
            cacheDir: scratch,
            logLevel: 'silent',
        });

        try {
            const resolved: Record<string, { ssr: boolean; id: string }> = {};

            for (const ssr of [true, false]) {
                const result = await server.pluginContainer.resolveId('@underload/dashboard', undefined, { ssr });
                // An unresolved specifier is recorded as the literal 'undefined' so
                // the exact comparison below fails loudly instead of skipping.
                resolved[`ssr:${ssr}`] = { ssr, id: result ? toPosix(result.id) : 'undefined' };
            }

            const sourceId = toPosix(SOURCE_ABSOLUTE);
            expect(resolved).toEqual({
                'ssr:true': { ssr: true, id: sourceId },
                'ssr:false': { ssr: false, id: sourceId },
            });

            // Headline rule, restated directly: neither chain may reach the bundle.
            expect(Object.values(resolved).some(({ id }) => id.includes('/dist/'))).toBe(false);
        } finally {
            // Always tear the nested server down: an open dev server holds file
            // watchers and keeps `vitest run` from exiting.
            await server.close();
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    it('keeps the example Vite alias on the manifest default target', () => {
        // Three mirrors of one module (manifest `default`, the example's Vite alias,
        // the example's tsconfig `paths` below). If they disagree, a test typechecks one
        // file and executes another. The aliases exist at all so the example always
        // builds against the sibling SOURCE even when an installed copy of the package
        // (a published tarball, or a workspace link to a different revision) is present
        // in `node_modules`.
        //
        // `DASHBOARD_ENTRY` is an operator override for the alias target; it must not
        // leak in from the environment or this assertion stops being deterministic.
        const previousEntry = process.env.DASHBOARD_ENTRY;
        delete process.env.DASHBOARD_ENTRY;

        try {
            const alias = exampleResolve().alias;

            // Exact key set: one alias, no stale subpath entry left pointing at a
            // specifier the manifest does not publish.
            expect(Object.keys(alias)).toEqual(['@underload/dashboard']);

            // Same FILE as the `default` target (both sides absolute-resolved, so
            // a `../src` vs `src` spelling difference cannot hide a rename).
            expect(path.resolve(alias['@underload/dashboard'])).toBe(SOURCE_ABSOLUTE);
            expect(fs.existsSync(path.resolve(alias['@underload/dashboard']))).toBe(true);
        } finally {
            if (previousEntry === undefined) delete process.env.DASHBOARD_ENTRY;
            else process.env.DASHBOARD_ENTRY = previousEntry;
        }
    });

    it('keeps the example tsconfig paths on the same source file', () => {
        // The type side of the same mirror. example/tsconfig.json is JSONC, hence the
        // string-aware strip above: a naive block-comment regex corrupts exactly the
        // `paths` value asserted here.
        const tsconfig = JSON.parse(stripJsonComments(readText(path.join(EXAMPLE_ROOT, 'tsconfig.json')))) as {
            compilerOptions: { paths: Record<string, string[]> };
        };
        const paths = tsconfig.compilerOptions.paths;

        // Exact key set (no stale alias) and the exact declaration, then the file
        // identity proof: `paths` entries resolve relative to the tsconfig's own
        // directory, so they are compared against EXAMPLE_ROOT.
        expect(Object.keys(paths)).toEqual(['@underload/dashboard']);
        expect(paths['@underload/dashboard']).toEqual(['../src/dashboard.ts']);
        expect(path.resolve(EXAMPLE_ROOT, paths['@underload/dashboard'][0])).toBe(SOURCE_ABSOLUTE);
    });
});
