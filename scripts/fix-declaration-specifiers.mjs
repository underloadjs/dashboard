// Declaration-specifier post-processor for the published `dist/` declaration tree.
//
// WHY THIS EXISTS (the defect it fixes)
// `npm run build` emits JS with Vite (`vite.config.ts`, one bundled ESM file) and
// declarations with `tsc -p tsconfig.build.json`. tsc copies the SOURCE specifier
// text verbatim, and src/** is written extensionless (`./types`, `./dashboard`)
// because the library program uses `moduleResolution: bundler`. The emitted
// declarations therefore keep extensionless relative specifiers:
//
//     dist/dashboard.d.ts:        export { DashboardError } from './core';
//     dist/extensions/state.d.ts: import type { DashboardState } from '../types';
//
// The package is `"type": "module"`, so every emitted `.d.ts` is an ESM module. A
// consumer compiling with `module: node16`/`NodeNext` (or `moduleResolution:
// node16`/`NodeNext`) resolves those files under ESM rules and rejects each
// extensionless relative specifier with TS2834 ("Relative import paths need
// explicit file extensions in ECMAScript modules when '--module' is 'nodenext'").
// With the layered layout that is one TS2834 per extensionless specifier in the
// whole emitted tree (the entry alone re-exports through `./core` and `./types`,
// and every layer folder adds a `../` hop), and the consumer never sees the rest
// of the public surface. `skipLibCheck` does not hide them: they are resolution
// errors.
//
// THE FIX
// Rewrite every relative declaration specifier to the JS name of the sibling
// declaration it resolves to — the specifier style TypeScript itself prescribes
// under NodeNext, where `./types.js` maps back to `./types.d.ts`:
//
//     export { dashboard } from './dashboard';   ->  './dashboard.js'
//     export * from './ui/turns';                ->  './ui/turns.js'   (directory-free layout)
//     export * from '.';                         ->  './index.js'      (bare directory ref)
//
// The published JS is a single bundle (`dist/underload-dashboard.mjs`), so no real
// `.js` file needs to exist for those specifiers — TypeScript only needs the
// `.d.ts` sibling, which is in the tarball. External/bare specifiers (a future
// `from 'react'`) and explicit non-declaration extensions (`.json`, `.css`) are
// left untouched, so type accuracy is preserved and only relative file identity is
// made explicit.
//
// This is a BUILD-layer concern: no source file carries an extension, so src/** is
// never edited and `npm run typecheck` (bundler resolution) keeps passing.
//
// ALGORITHM (deterministic, fails loudly)
//   1. Walk the emitted tree for `*.d.ts` (sorted, so output is stable).
//   2. On every non-comment line, match relative specifiers in the three positions
//      a declaration can use one: `from '…'`, `import '…'`, `import('…')`.
//   3. Resolve each against the EMITTED tree: `<spec>.d.ts`, else
//      `<spec>/index.d.ts`. A resolved specifier becomes `<spec>.js`; an
//      unresolvable one is reported and the CLI exits non-zero — silently shipping
//      a package no consumer can type-check is worse than a failed build.
//   4. A specifier already ending in `.js` is verified, never rewritten, which
//      makes a second run a no-op (idempotent) and `--check` a CI-able assertion.
//
// USAGE
//     node scripts/fix-declaration-specifiers.mjs              # <package>/dist
//     node scripts/fix-declaration-specifiers.mjs <dir>        # any emitted tree
//     node scripts/fix-declaration-specifiers.mjs <dir> --check # report only, exit 1 on drift
//
// Invoked by `npm run build` (package.json "build") right after the tsc emit, and
// verified in its fixed state by ./check-package.mjs.
//
// Cross-references:
//   - ../tsconfig.build.json  — the declaration emit this post-processes
//   - ../vite.config.ts       — why the JS side is bundled instead of per-module
//   - ./check-package.mjs     — built-package proof (NodeNext consumer + pack shape)
//   - ./fix-declaration-specifiers.test.mjs — unit coverage of the pure rewrite
//   - sibling precedent (monorepo only, NOT imported here): the same algorithm in
//     packages/underload/harness/scripts/fix-declaration-specifiers.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Package root: this file lives in `<package>/scripts/`, so `../dist` is the target.
// The package is published as its own repository, hence the path is derived from
// this module's URL and never reaches outside the package (no monorepo dependency).
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Extensions that are never declaration references; rewriting them would break
// resolution (they are real files, not TypeScript module specifiers).
const EXPLICIT_EXTENSION = /\.(?:mjs|cjs|json|css|node|wasm)$/i;

// `from '…'`, `import '…'`, `import('…')`. Group 1 = lead-in, 2 = quote,
// 3 = the relative specifier; the quote backreference (\2) keeps the closing quote
// identical to the opening one. A bare `.`/`..` is allowed so a directory reference
// (`from '.'`) is matched too. tsc always emits a specifier on one line, so the
// callers may safely scan line by line (a line-comment guard keeps prose out).
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g;

// Emitted-comment lines (JSDoc bodies, `//` notes): they may mention a path
// (`./main.ts`) without referencing a module, so they are never rewritten.
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

// Only relative specifiers are this script's business; bare specifiers belong to
// `dependencies` and stay exactly as tsc emitted them.
const RELATIVE = /^\.{1,2}(?:\/|$)/;

/**
 * Every module specifier a declaration text references, in source order (comment
 * lines excluded, exactly as in the rewrite) so "what this file points at" has one
 * definition for both the fixer and the packaging proof.
 * @param {string} text
 * @returns {string[]}
 */
export const declarationSpecifiers = (text) =>
    text
        .split(/\r?\n/)
        .filter((line) => !COMMENT_LINE.test(line))
        .flatMap((line) => [...line.matchAll(SPECIFIER)].map((match) => match[3]));

/**
 * Every `*.d.ts` under `directory`, sorted for stable cross-platform output.
 * @param {string} directory
 * @returns {string[]}
 */
export const listDeclarationFiles = (directory) => {
    if (!existsSync(directory)) return [];

    /** @type {string[]} */
    const files = [];

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) files.push(...listDeclarationFiles(full));
        else if (entry.name.endsWith('.d.ts')) files.push(full);
    }

    return files.sort();
};

/**
 * Resolve one relative specifier against the EMITTED declaration tree.
 *
 * Returns the replacement specifier, or `null` when no declaration answers it; the
 * caller turns a `null` into a build failure instead of leaving an invalid
 * specifier in a published file.
 *
 * @param {string} fromFile  declaration the specifier appears in (for base dir + report)
 * @param {string} specifier  relative specifier as emitted
 * @returns {string | null}
 */
const resolveSpecifier = (fromFile, specifier) => {
    const directory = path.dirname(fromFile);
    const cleaned = specifier.replace(/\/+$/, '');
    const resolved = path.resolve(directory, cleaned);

    // Already JS-form: valid only when the mapped declaration really exists, which
    // is what makes re-running this script a verified no-op.
    if (/\.js$/i.test(cleaned)) return existsSync(resolved.replace(/\.js$/i, '.d.ts')) ? specifier : null;

    // An explicit non-declaration extension is a real file reference, not a module
    // specifier: keep it, provided the file is actually next to the declaration.
    if (EXPLICIT_EXTENSION.test(cleaned)) return existsSync(resolved) ? specifier : null;

    // Extensionless module: `./types` -> `./types.js` (maps to ./types.d.ts).
    if (existsSync(`${resolved}.d.ts`)) return `${cleaned}.js`;

    // Directory module: `.` / `./ui` -> `./index.js` (maps to ./index.d.ts).
    if (existsSync(path.join(resolved, 'index.d.ts'))) return `${cleaned}/index.js`;

    return null;
};

/**
 * Pure, I/O-free rewrite of one declaration's TEXT.
 *
 * @param {string} text      the emitted declaration text
 * @param {string} filePath  used to resolve specifiers and to report problems
 * @param {{ file: string, specifier: string }[]} unresolved  out-param, appended to
 * @returns {{ text: string, changed: boolean }}
 */
export const rewriteDeclarationText = (text, filePath, unresolved) => {
    let changed = false;

    const lines = text.split(/\r?\n/).map((line) => {
        if (COMMENT_LINE.test(line)) return line;

        return line.replace(SPECIFIER, (match, lead, quote, specifier) => {
            if (!RELATIVE.test(specifier)) return match;

            const replacement = resolveSpecifier(filePath, specifier);

            if (replacement === null) {
                unresolved.push({ file: filePath, specifier });
                return match;
            }

            // Verified-as-already-correct: no edit, so a second run changes nothing.
            if (replacement === specifier) return match;

            changed = true;
            return `${lead}${quote}${replacement}${quote}`;
        });
    });

    // Preserve the emit's line endings byte-for-byte (tsc follows the source file).
    return { text: lines.join(text.includes('\r\n') ? '\r\n' : '\n'), changed };
};

/**
 * Fix (or, with `checkOnly`, only inspect) every declaration under `directory`.
 *
 * @param {{ directory?: string, checkOnly?: boolean }} [options]
 * @returns {{ directory: string, scanned: number, rewritten: string[], unresolved: { file: string, specifier: string }[] }}
 */
export const fixDeclarationSpecifiers = (options = {}) => {
    const directory = path.resolve(options.directory ?? path.join(PACKAGE_ROOT, 'dist'));
    const checkOnly = options.checkOnly ?? false;
    const files = listDeclarationFiles(directory);

    /** @type {{ file: string, specifier: string }[]} */
    const unresolved = [];
    /** @type {string[]} */
    const rewritten = [];

    for (const file of files) {
        const original = readFileSync(file, 'utf8');
        const result = rewriteDeclarationText(original, file, unresolved);

        if (!result.changed) continue;

        rewritten.push(file);
        // `--check` reports what a real run would change and leaves the tree alone.
        if (!checkOnly) writeFileSync(file, result.text, 'utf8');
    }

    return { directory, scanned: files.length, rewritten, unresolved };
};

// CLI entry: fail loudly on an unresolvable specifier, and on a `--check` that found
// declarations still in their pre-fix state (the build forgot this step).
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const checkOnly = process.argv.includes('--check');
    // `node scripts/fix-declaration-specifiers.mjs --check` targets the package dist;
    // a leading positional argument overrides the directory.
    const directory = process.argv[2]?.startsWith('--') === true ? undefined : process.argv[2];
    const result = fixDeclarationSpecifiers({ directory, checkOnly });

    if (result.unresolved.length > 0) {
        for (const { file, specifier } of result.unresolved) {
            console.error(`unresolved declaration specifier: '${specifier}' in ${path.relative(PACKAGE_ROOT, file)}`);
        }
        process.exit(1);
    }

    if (checkOnly && result.rewritten.length > 0) {
        for (const file of result.rewritten) {
            console.error(`declaration needs an explicit .js specifier: ${path.relative(PACKAGE_ROOT, file)}`);
        }
        process.exit(1);
    }

    console.log(
        `declarations: ${checkOnly ? 'checked' : 'rewrote'} ${result.rewritten.length}/${result.scanned} file(s) in ${result.directory}`
    );
}
