// Regression coverage for ./fix-declaration-specifiers.mjs (the fix that makes the
// published declarations readable by a `module`/`moduleResolution: NodeNext`
// consumer — the shipped tree used to fail with four TS2834 errors in
// dist/index.d.ts, see ./check-package.mjs header).
//
// Run with: node --test scripts/fix-declaration-specifiers.test.mjs  (`npm run
// test:package:scripts`). Plain node:test, not vitest: this is build-layer tooling
// that must run without the library's test config, and `scripts/**` is excluded from
// the tarball (check-package.mjs asserts that), so it can never reach a consumer.
//
// Every assertion is an exact value: full rewritten text, full specifier lists, full
// unresolved records, exact file counts. Resolution is path-based (existsSync), so
// the fixtures are real files under the repository-root Temp/ (root AGENTS.md), never
// the OS temp directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarationSpecifiers, fixDeclarationSpecifiers, listDeclarationFiles, rewriteDeclarationText } from './fix-declaration-specifiers.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPTS_DIR, '..');

// Scratch policy (root AGENTS.md, mirrored by ./check-package.mjs): the workspace
// root is the nearest ancestor carrying BOTH `AGENTS.md` and `Temp/`; a standalone
// checkout of this package has none, so its own git-ignored `Temp/` is used. Never
// the OS temp directory, and no dependency on the sibling harness package.
const findWorkspaceRoot = (start) => {
    let current = path.resolve(start);

    while (true) {
        if (existsSync(path.join(current, 'AGENTS.md')) && existsSync(path.join(current, 'Temp'))) return current;

        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
};

const workspaceRoot = findWorkspaceRoot(PACKAGE_ROOT);
const scratchRoot =
    workspaceRoot === undefined
        ? path.join(PACKAGE_ROOT, 'Temp', 'declaration-specifiers')
        : path.join(workspaceRoot, 'Temp', 'underload-dashboard', 'declaration-specifiers');
mkdirSync(scratchRoot, { recursive: true });
// Children of this process (and node:test itself) inherit a repository-local temp.
process.env.TEMP = scratchRoot;
process.env.TMP = scratchRoot;
process.env.TMPDIR = scratchRoot;

/**
 * Builds a real emitted tree `{ 'index.d.ts': text, ... }` in a fresh scratch
 * directory and returns `{ directory, file(relative) -> absolute, text(relative) }`.
 */
const fixture = (files) => {
    const directory = mkdtempSync(path.join(scratchRoot, 'fixture-'));

    for (const [relative, text] of Object.entries(files)) {
        const target = path.join(directory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, text, 'utf8');
    }

    return {
        directory,
        file: (relative) => path.join(directory, relative),
        text: (relative) => readFileSync(path.join(directory, relative), 'utf8'),
    };
};

test('declarationSpecifiers reports every module reference a text makes, in order', () => {
    const text = [
        "import type { DashboardState } from './types';",
        "export { dashboard } from './dashboard';",
        "export * from '.';",
        "import './side-effect';",
        "export type Lazy = import('./lazy').Lazy;",
        "import React from 'react';",
        '// see ./comment for details',
        '/* from "./block" is prose too */',
        '',
    ].join('\n');

    // Comment lines carry no references, so only the five real module positions are reported.
    assert.deepEqual(declarationSpecifiers(text), ['./types', './dashboard', '.', './side-effect', './lazy']);
});

test('a flat emitted barrel gains exactly the .js specifiers TypeScript needs under NodeNext', () => {
    // Mirrors the real dist/ shape: a barrel re-export plus a type-only import.
    const emit = [
        "export { dashboard } from './dashboard';",
        "export { DashboardError } from './errors';",
        "export type { DashboardErrorCode } from './errors';",
        "export type { Dashboard, DashboardPlugin, } from './types';",
        '',
    ].join('\n');
    const tree = fixture({
        'index.d.ts': emit,
        'dashboard.d.ts': "import type { Dashboard } from './types';\nexport declare function dashboard(): Dashboard;\n",
        'errors.d.ts': "export declare class DashboardError extends Error {}\n",
        'types.d.ts': 'export interface Dashboard {}\n',
    });

    const unresolved = [];
    const result = rewriteDeclarationText(emit, tree.file('index.d.ts'), unresolved);

    assert.equal(
        result.text,
        [
            "export { dashboard } from './dashboard.js';",
            "export { DashboardError } from './errors.js';",
            "export type { DashboardErrorCode } from './errors.js';",
            "export type { Dashboard, DashboardPlugin, } from './types.js';",
            '',
        ].join('\n')
    );
    assert.equal(result.changed, true);
    assert.deepEqual(unresolved, []);
});

test('an already-fixed tree is a verified no-op (idempotent, so --check is a gate)', () => {
    const fixed = "export { dashboard } from './dashboard.js';\nexport * from './harnesses/index.js';\n";
    const tree = fixture({ 'index.d.ts': fixed, 'dashboard.d.ts': 'export declare function dashboard(): void;\n', 'harnesses/index.d.ts': 'export * from "./types.js";\n', 'harnesses/types.d.ts': 'export type T = string;\n' });

    const unresolved = [];
    const result = rewriteDeclarationText(fixed, tree.file('index.d.ts'), unresolved);

    assert.equal(result.text, fixed);
    assert.equal(result.changed, false);
    assert.deepEqual(unresolved, []);
});

test('directory and bare specifiers resolve to the emitted index.js', () => {
    const emit = "export * from './harnesses';\nexport * from '.';\nexport type Nested = import('./ui/turns').Turn;\n";
    const tree = fixture({
        'index.d.ts': emit,
        'harnesses/index.d.ts': 'export type Harness = string;\n',
        'ui/turns.d.ts': 'export type Turn = number;\n',
    });

    const unresolved = [];
    const result = rewriteDeclarationText(emit, tree.file('index.d.ts'), unresolved);

    assert.equal(result.text, "export * from './harnesses/index.js';\nexport * from './index.js';\nexport type Nested = import('./ui/turns.js').Turn;\n");
    assert.equal(result.changed, true);
    assert.deepEqual(unresolved, []);
});

test('bare and node: specifiers and explicit non-declaration extensions are never rewritten', () => {
    // The package is dependency-free today, but a future `from 'react'` or an emitted
    // `./meta.json` reference must survive untouched: rewriting those breaks real
    // resolution, not NodeNext module identity.
    const emit = "import type { FC } from 'react';\nimport fs from 'node:fs';\nexport type Meta = typeof import('./meta.json');\nexport * from './styles.css';\n";
    const tree = fixture({
        'index.d.ts': emit,
        'meta.json': '{}\n',
        'styles.css': 'body{}\n',
    });

    const unresolved = [];
    const result = rewriteDeclarationText(emit, tree.file('index.d.ts'), unresolved);

    assert.equal(result.text, emit);
    assert.equal(result.changed, false);
    assert.deepEqual(unresolved, []);
});

test('a specifier with no emitted declaration is reported, not silently kept', () => {
    // Silent omission is what would let an unresolvable specifier ship: the tree must
    // fail the build instead.
    const emit = "export * from './gone';\nexport * from './present';\n";
    const tree = fixture({ 'index.d.ts': emit, 'present.d.ts': 'export type Present = 1;\n' });

    const unresolved = [];
    const result = rewriteDeclarationText(emit, tree.file('index.d.ts'), unresolved);

    assert.deepEqual(unresolved, [{ file: tree.file('index.d.ts'), specifier: './gone' }]);
    assert.equal(result.text, "export * from './gone';\nexport * from './present.js';\n");
    assert.equal(result.changed, true);
});

test('a .js specifier that points at nothing is unresolved (a stale rewrite is a failure)', () => {
    const emit = "export * from './removed.js';\n";
    const tree = fixture({ 'index.d.ts': emit });

    const unresolved = [];
    const result = rewriteDeclarationText(emit, tree.file('index.d.ts'), unresolved);

    assert.deepEqual(unresolved, [{ file: tree.file('index.d.ts'), specifier: './removed.js' }]);
    assert.equal(result.text, emit);
    assert.equal(result.changed, false);
});

test('comment lines are never rewritten, even when they look like references', () => {
    const emit = "// built from ./dashboard by scripts/build.mjs\n/** @see ./types for the contract */\n * from './prose'\nexport { dashboard } from './dashboard';\n";
    const tree = fixture({ 'index.d.ts': emit, 'dashboard.d.ts': 'export declare function dashboard(): void;\n' });

    const unresolved = [];
    const result = rewriteDeclarationText(emit, tree.file('index.d.ts'), unresolved);

    assert.equal(result.text, "// built from ./dashboard by scripts/build.mjs\n/** @see ./types for the contract */\n * from './prose'\nexport { dashboard } from './dashboard.js';\n");
    assert.deepEqual(unresolved, []);
});

test('CRLF emit keeps CRLF bytes and LF emit keeps LF bytes', () => {
    const tree = fixture({
        'crlf.d.ts': "export * from './target';\r\n",
        'target.d.ts': 'export type T = 1;\n',
        'lf.d.ts': "export * from './target';\n",
    });

    const crlf = rewriteDeclarationText(tree.text('crlf.d.ts'), tree.file('crlf.d.ts'), []);
    const lf = rewriteDeclarationText(tree.text('lf.d.ts'), tree.file('lf.d.ts'), []);

    assert.equal(crlf.text, "export * from './target.js';\r\n");
    assert.equal(lf.text, "export * from './target.js';\n");
});

test('listDeclarationFiles walks nested directories, sorted, .d.ts only', () => {
    const tree = fixture({
        'index.d.ts': 'export {};\n',
        'underload-dashboard.mjs': 'export {};\n',
        'ui/turns.d.ts': 'export {};\n',
        'ui/notes.md': 'text\n',
        'deep/deeper/leaf.d.ts': 'export {};\n',
    });

    const found = listDeclarationFiles(tree.directory).map((file) => path.relative(tree.directory, file).split(path.sep).join('/'));

    assert.deepEqual(found, ['deep/deeper/leaf.d.ts', 'index.d.ts', 'ui/turns.d.ts']);
    assert.deepEqual(listDeclarationFiles(path.join(tree.directory, 'nope')), []);
});

test('fixDeclarationSpecifiers rewrites the tree once, --check never writes, and a fixed tree is clean', () => {
    const tree = fixture({
        'index.d.ts': "export { dashboard } from './dashboard';\nexport type { Dashboard } from './types';\n",
        'dashboard.d.ts': "import type { Dashboard } from './types';\nexport declare function dashboard(): Dashboard;\n",
        'types.d.ts': 'export interface Dashboard { plugins: readonly string[] }\n',
    });
    const before = tree.text('index.d.ts');

    // 1. --check reports the pre-fix state and leaves every byte alone.
    const check = fixDeclarationSpecifiers({ directory: tree.directory, checkOnly: true });
    assert.deepEqual(
        check.rewritten.map((file) => path.relative(tree.directory, file).split(path.sep).join('/')),
        ['dashboard.d.ts', 'index.d.ts']
    );
    assert.equal(check.scanned, 3);
    assert.deepEqual(check.unresolved, []);
    assert.equal(tree.text('index.d.ts'), before);
    assert.equal(tree.text('dashboard.d.ts'), "import type { Dashboard } from './types';\nexport declare function dashboard(): Dashboard;\n");

    // 2. A real run fixes exactly those files.
    const fix = fixDeclarationSpecifiers({ directory: tree.directory });
    assert.deepEqual(
        fix.rewritten.map((file) => path.relative(tree.directory, file).split(path.sep).join('/')),
        ['dashboard.d.ts', 'index.d.ts']
    );
    assert.equal(tree.text('index.d.ts'), "export { dashboard } from './dashboard.js';\nexport type { Dashboard } from './types.js';\n");
    assert.equal(tree.text('dashboard.d.ts'), "import type { Dashboard } from './types.js';\nexport declare function dashboard(): Dashboard;\n");
    // types.d.ts carries no relative reference, so it must not be touched at all.
    assert.equal(tree.text('types.d.ts'), 'export interface Dashboard { plugins: readonly string[] }\n');

    // 3. The fixed tree passes --check with nothing left to do.
    const recheck = fixDeclarationSpecifiers({ directory: tree.directory, checkOnly: true });
    assert.deepEqual(recheck.rewritten, []);
    assert.deepEqual(recheck.unresolved, []);
    assert.equal(recheck.scanned, 3);

    rmSync(tree.directory, { recursive: true, force: true });
});

// Every fixture is created under one scratch root, so a single removal leaves the
// repository Temp/ clean after the run (Temp/ is disposable, not a dumping ground).
after(() => rmSync(scratchRoot, { recursive: true, force: true }));
