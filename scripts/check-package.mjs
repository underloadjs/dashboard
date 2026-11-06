// Built-package proof for @underload/dashboard: does the PUBLISHED artifact work
// for real consumers, and does it contain only the library?
//
// WHY THIS EXISTS
// The source suite (vitest, `moduleResolution: bundler`) cannot see two defect
// classes, and both were found in the shipped tree:
//   F1  NodeNext consumers could not read the declarations at all. tsc preserves
//       the extensionless source specifiers, so the entry declaration shipped
//       `export { DashboardError } from './core'` — today that file is
//       `dist/dashboard.d.ts` (the entry is `src/dashboard.ts`); when the entry was
//       the flat `dist/index.d.ts` the same defect read
//       `export { dashboard } from './dashboard'`. Every consumer compiling with
//       `module`/`moduleResolution: NodeNext` hit one TS2834 resolution error per
//       extensionless specifier and lost the public surface, in every emitted file,
//       not just the entry. ./fix-declaration-specifiers.mjs rewrites them.
//       This script asserts the built tree is in that fixed state AND compiles a
//       real NodeNext consumer that imports the package BY NAME from a scratch
//       `node_modules` holding the packed shape (a tsconfig `paths` alias, like the
//       one in example/tsconfig.json, would prove nothing).
//   F2  package boundaries were only carried by intent. The real
//       `npm pack --dry-run --json` report is parsed here: every tarball entry must
//       be library output (dist/**), library SOURCE (src/**, the tree the
//       `development` condition below publishes), or an npm default include
//       (manifest, readme, licence, docs) — never `example/`, `scripts/`, a test
//       file, a test layer directory anywhere in the published tree (`dist/tests/**`
//       or `src/tests/**`), a fixture, or `.github/workflows`. That same packed entry
//       list is copied into the scratch install, so the type-check runs against
//       exactly what a consumer downloads.
//   F3  source-first resolution must survive PACKING. `exports["."].development`
//       (the condition Vite/Vitest/vite-node select in dev + test mode) points at the
//       raw `./src/dashboard.ts` entry — `dist/` is the npm distribution bundle only,
//       and per-module `.ts` is what a bundler tree shakes. A `development` target
//       that is not in the tarball resolves to nothing after install, so `src/` must
//       be published (minus its test layer) and every export target — source
//       included — must appear in the packed entry list (§3 reuses the same check).
//       `types` conditions stay on the emitted `./dist/dashboard.d.ts`, because a
//       NodeNext consumer cannot read `src/*.ts` (its relative specifiers are
//       extensionless, i.e. exactly defect F1). The two consumer fixtures below
//       therefore still compile against the DECLARATIONS: TS always applies the
//       `types` condition, and it precedes `development` in the map.
//       (Same contract the sibling harness enforces in
//       packages/underload/harness/scripts/check-package-types.mjs §1d/1e.)
//
// USAGE
//     node scripts/check-package.mjs             # requires `npm run build` first
//     node scripts/check-package.mjs --keep      # keep the scratch tree for poking
//     node scripts/check-package.mjs --scratch <dir>
//
// Scratch lives in a repository-root `Temp/` (root AGENTS.md): inside the noobscript
// workspace that is the workspace root (`<workspace>/Temp/underload-dashboard/`), and
// in a standalone `underloadjs/dashboard` checkout it is the package's own ignored
// `Temp/` — detection is the nearest ancestor carrying BOTH `AGENTS.md` and `Temp/`.
// Child processes inherit TEMP/TMP/TMPDIR pointed there, so nothing falls back to the
// OS temp directory.
//
// Exit codes: 0 = the published shape is sound; 1 = first hard failure (message
// names the fix). The consumer/runtime results are all reported before exiting, so
// one run shows every problem.
//
// Cross-references:
//   - ./fix-declaration-specifiers.mjs       — the post-process step 2 verifies
//   - ./fix-declaration-specifiers.test.mjs  — unit coverage of the rewrite itself
//   - ../package.json                        — exports/files contract under test
//   - ../tsconfig.build.json                 — the declaration emit
//   - ../vite.config.ts                      — the bundled ESM runtime entry
//   - Consumer fixtures are INLINE (this file), so the example app staying out of
//     the tarball cannot break this proof.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarationSpecifiers, fixDeclarationSpecifiers } from './fix-declaration-specifiers.mjs';

const require = createRequire(import.meta.url);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@underload/dashboard';
const MANIFEST_PATH = path.join(PACKAGE_ROOT, 'package.json');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');

// The only three paths the manifest is allowed to publish: the raw entry, the bundled
// ESM runtime, and the declaration twin of the published entry. The entry is
// `src/dashboard.ts` (the only file at src/ root), and tsconfig.build.json maps rootDir
// `src` -> outDir `dist`, so its declaration is `dist/dashboard.d.ts` — the tree below
// it mirrors the src layers (`dist/core/`, `dist/extensions/`, `dist/plugin/`,
// `dist/types/`).
const RUNTIME_TARGET = './dist/underload-dashboard.mjs';
const TYPES_TARGET = './dist/dashboard.d.ts';
// SOURCE_TARGET is what the `development` condition (Vite/Vitest/vite-node dev + test
// mode) resolves, and what `main`/`module`/`types` advertise to a `node10` consumer:
// raw TypeScript, so a workspace run never evaluates a stale bundle and a bundler can
// tree shake per module. `dist/` stays the npm distribution artifact.
const SOURCE_TARGET = './src/dashboard.ts';

/** Hard stop with a one-line cause: a packaging gate must fail, never half-pass. */
const fail = (message) => {
    console.error(`package check: ${message}`);
    process.exit(1);
};

// A test artifact by name — used for both dist/ and the tarball, so "shipped test"
// has a single definition (`.test.ts`, `*.spec.mjs`, `foo.test.d.ts`, test dirs).
const TEST_FILE = /(^|[/.])(?:test|spec)(?:[.-]|$)/i;
const isTestArtifact = (file) => TEST_FILE.test(file);

// `files[].path` from npm is POSIX; every path comparison in here uses POSIX form.
const toPosix = (value) => value.split(path.sep).join('/');

/** Every file under `directory`, POSIX-relative to it, sorted. */
const listFiles = (directory, relativeTo = directory) => {
    /** @type {string[]} */
    const files = [];

    if (!existsSync(directory)) return files;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) files.push(...listFiles(full, relativeTo));
        else files.push(toPosix(path.relative(relativeTo, full)));
    }

    return files.sort();
};

/** Flattens an exports map into `{ condition, target }` pairs (one subpath here). */
const exportTargets = (value, condition = '.') => {
    if (typeof value === 'string') return [{ condition, target: value }];

    return Object.entries(value).flatMap(([key, nested]) => exportTargets(nested, `${condition}.${key}`));
};

// Resolves the TypeScript CLI without assuming the install layout (workspace
// hoisting in the monorepo vs. a standalone `npm install` inside the package).
const resolveTsc = () => {
    const candidates = [
        path.join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        ...Array.from({ length: 4 }, (_, index) =>
            path.join(PACKAGE_ROOT, ...Array.from({ length: index + 1 }, () => '..'), 'node_modules', 'typescript', 'bin', 'tsc')
        ),
    ];

    for (const candidate of candidates) if (existsSync(candidate)) return candidate;

    try {
        return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    } catch {
        return fail('typescript is not installed — install the package dependencies first');
    }
};

/** Runs a command and returns `{ status, stdout, stderr, output }` (both streams captured). */
const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });

    if (result.error !== undefined) fail(`${command} ${args.join(' ')} could not run: ${result.error.message}`);

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    return {
        status: result.status ?? 1,
        // JSON-emitting commands must be parsed from stdout alone: npm puts its
        // warnings on stderr, and merging the streams corrupts the payload.
        stdout,
        stderr,
        output: `${stdout}${stderr}`.trim(),
    };
};

// npm must be spawned in a way that works on every platform: Node 22+ rejects a bare
// `.cmd` without a shell (EINVAL), so prefer npm's own CLI script next to the running
// node binary and fall back to shell mode only when it is not there.
const resolveNpm = () => {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) return { command: process.execPath, args: [cli], options: {} };

    return {
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: [],
        options: { shell: process.platform === 'win32' },
    };
};
// Scratch root policy (root AGENTS.md): all throwaway work lives in a repository-root
// `Temp/`, never the OS temp directory. The workspace root is the nearest ancestor
// carrying BOTH `AGENTS.md` and `Temp/` (inside the noobscript monorepo that is the
// workspace root, not this package, which has a Temp/ but no AGENTS.md). A standalone
// checkout of this package has no such ancestor, so its own `Temp/` is used —
// `packages/underload/dashboard/.gitignore` ignores `Temp/` exactly for that case.
// Same policy as the sibling harness (read-only precedent, not imported: this package
// must stay self-contained), expressed locally to avoid a monorepo dependency.
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
const defaultScratchRoot =
    workspaceRoot === undefined
        ? path.join(PACKAGE_ROOT, 'Temp', 'package-types')
        : path.join(workspaceRoot, 'Temp', 'underload-dashboard', 'package-types');

const npm = resolveNpm();
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const tsc = resolveTsc();

// `--scratch <dir>` overrides the location for a CI runner whose workspace sits
// elsewhere; a trailing flag is not treated as the directory.
const scratchIndex = process.argv.indexOf('--scratch');
const scratchArg = scratchIndex >= 0 ? process.argv[scratchIndex + 1] : undefined;
const scratchRoot = path.resolve(scratchArg !== undefined && !scratchArg.startsWith('--') ? scratchArg : defaultScratchRoot);

// ---------------------------------------------------------------------------
// 1. Manifest contract: ESM-only, one public entry, source + bundle publish, no deps.
// ---------------------------------------------------------------------------
if (manifest.name !== PACKAGE_NAME) fail(`unexpected package name '${manifest.name}'`);
if (manifest.type !== 'module') fail('package.json must stay "type": "module" (every declaration is ESM)');

// `files` is pinned exactly, because both halves carry a defect:
//   - dropping `src` makes the `development` export target a 404 after install;
//   - dropping any `!src/**` negation ships the conformance suite (and any
//     snapshot/nested-install noise) to every consumer.
const EXPECTED_FILES = [
    'dist',
    'src',
    '!src/**/*.test.ts',
    '!src/**/*.test.tsx',
    '!src/**/*.spec.ts',
    '!src/**/*.spec.tsx',
    '!src/**/__snapshots__/**',
    '!src/**/node_modules/**',
];
if (JSON.stringify(manifest.files) !== JSON.stringify(EXPECTED_FILES))
    fail(`"files" must stay exactly ${JSON.stringify(EXPECTED_FILES)}, got ${JSON.stringify(manifest.files)}`);
if (manifest.dependencies !== undefined) fail('the core must stay dependency-free: no runtime "dependencies"');

// Legacy resolution fields: `main`/`module`/`types` are what a consumer compiling
// with `moduleResolution: node10` (and what a bundler that ignores "exports") reads,
// and the exports map does not cover them, so an entry rename has to land in BOTH
// places. They point at the SOURCE entry, exactly like every other workspace library
// (packages/presource/core, packages/godspace/core, packages/userfiction/core): a
// `node10`/bundler consumer gets raw `.ts` (type-checkable, per-module tree shakeable),
// while modern Node and NodeNext consumers are served by the "exports" map below, whose
// runtime conditions stay on the built bundle.
if (manifest.main !== SOURCE_TARGET) fail(`"main" must stay ${SOURCE_TARGET}, got ${JSON.stringify(manifest.main)}`);
if (manifest.module !== SOURCE_TARGET) fail(`"module" must stay ${SOURCE_TARGET}, got ${JSON.stringify(manifest.module)}`);
if (manifest.types !== SOURCE_TARGET) fail(`"types" must stay ${SOURCE_TARGET}, got ${JSON.stringify(manifest.types)}`);

const exportsMap = manifest.exports ?? {};
const publicSubpaths = Object.keys(exportsMap).sort().join(',');
if (publicSubpaths !== '.,./package.json')
    fail(`only the root entry and ./package.json may be exported, got [${publicSubpaths}]`);

// `./package.json` is a manifest re-export, not code: exempt from the target rule.
const targets = exportTargets(exportsMap).filter(({ target }) => !target.endsWith('package.json'));
if (targets.length === 0) fail('the root entry must publish a source, a types, and a runtime target');

// One allowed target per condition family:
//   `.types`             -> the emitted declaration (a NodeNext consumer cannot read
//                           `src/*.ts`, whose relative specifiers are extensionless);
//   `.development`       -> the raw source entry (the condition Vite/Vitest/vite-node
//                           select in dev + test mode — F3, and the whole reason `src`
//                           is in `files`);
//   `.import`/`.default` -> the bundled ESM runtime (npm distribution only).
const targetOfCondition = (condition) =>
    condition.endsWith('types') ? TYPES_TARGET : condition.endsWith('development') ? SOURCE_TARGET : RUNTIME_TARGET;

for (const { condition, target } of targets) {
    const expected = targetOfCondition(condition);
    if (target !== expected) fail(`"${condition}" must point at ${expected}, got ${target}`);
    // A dangling exports target is MODULE_NOT_FOUND for the consumer at runtime.
    if (!existsSync(path.join(PACKAGE_ROOT, target))) fail(`export target does not exist on disk: ${target}`);
}

// The condition set is pinned exactly: a condition the rule above has no branch for
// would otherwise pass silently on the runtime fallback (e.g. a `browser` or `node`
// condition added without deciding which artifact a browser host gets). The walk
// prefixes each key with its subpath (`.` -> `...types`), so only the bare condition
// names are compared.
const conditions = targets.map(({ condition }) => condition.replace(/^\.+/, '')).sort();
const EXPECTED_CONDITIONS = ['default', 'development', 'import', 'types'];
if (JSON.stringify(conditions) !== JSON.stringify(EXPECTED_CONDITIONS))
    fail(`the root entry must declare exactly [${EXPECTED_CONDITIONS.join(', ')}], got [${conditions.join(', ')}]`);

// ---------------------------------------------------------------------------
// 2. Built tree: present, test-free, and already post-processed.
// ---------------------------------------------------------------------------
if (!existsSync(DIST_DIR)) fail('dist/ is missing — run `npm run build` first');

const distFiles = listFiles(DIST_DIR);
if (distFiles.length === 0) fail('dist/ is empty — run `npm run build` first');
if (distFiles.some((file) => isTestArtifact(file)))
    fail(`dist/ contains test artifacts: ${distFiles.filter(isTestArtifact).join(', ')}`);

// The conformance suite now lives in a directory (`src/tests/`), not beside the entry,
// so a name-only test check is no longer enough: `tests/index.d.ts` matches neither
// TEST_FILE (the segment ends in `s`, not `.`/`-`) nor the tarball FORBIDDEN_PREFIXES
// (every tarball path starts with `dist/`, so `tests/` is never a prefix). A `tests/`
// or `test/` path segment anywhere in the emitted tree is the test layer escaping the
// tsconfig.build.json exclude list and reaching a consumer install.
const distTestLayer = distFiles.filter((file) => /(?:^|\/)tests?\//i.test(file));
if (distTestLayer.length > 0) fail(`dist/ contains the test layer: ${distTestLayer.join(', ')}`);

// A stray `.ts` would be unbuilt source; `.d.cts`/`.cts` would contradict ESM-only.
const distUnexpected = distFiles.filter((file) => !/\.(?:mjs|d\.ts|map|json)$/i.test(file));
if (distUnexpected.length > 0) fail(`dist/ contains unexpected file types: ${distUnexpected.join(', ')}`);

// The F1 guard. `--check` must find nothing unresolved (a relative specifier the
// fixer cannot map to an emitted declaration) and nothing left to rewrite (a build
// that skipped the post-process step, i.e. the shipped defect).
const declarationState = fixDeclarationSpecifiers({ directory: DIST_DIR, checkOnly: true });

if (declarationState.unresolved.length > 0) {
    fail(
        `unresolved declaration specifier(s): ${declarationState.unresolved
            .map(({ file, specifier }) => `${specifier} in ${toPosix(path.relative(PACKAGE_ROOT, file))}`)
            .join(', ')}`
    );
}
if (declarationState.rewritten.length > 0) {
    fail(
        `declarations are not post-processed (${declarationState.rewritten.length}/${declarationState.scanned} still use ` +
            'extensionless relative specifiers, which is TS2834 for a NodeNext consumer) — run `npm run build`'
    );
}

// The entry declaration (`dist/dashboard.d.ts`, the manifest "types" target) is the
// only entry, so every declaration it (transitively) names must exist in dist/; a
// missing sibling would otherwise surface only inside a consumer build. Under the
// layered layout those specifiers cross folder boundaries (`./core/index.js`,
// `./types/index.js`, then the layer barrels' own `./errors.js` / `./validate.js` /
// ...), which is why the walk is seeded with the entry FILE rather than a
// same-directory glob. The closure that walks out of the entry today is
// `dashboard.d.ts`, `core/index.d.ts` -> `core/errors.d.ts` + `core/validate.d.ts` +
// `core/listeners.d.ts`, and `types/index.d.ts`; the `extensions/` and `plugin/`
// declarations are emitted but not named by the public surface, and the all-files
// `--check` above still proves they are NodeNext-clean. Worklist (not a snapshot) so
// newly discovered declarations are walked too.
const closure = new Set([path.join(DIST_DIR, 'dashboard.d.ts')]);
for (const pending of closure) {
    const file = path.resolve(pending);
    if (!existsSync(file)) fail(`the public declaration closure references a missing file: ${toPosix(path.relative(PACKAGE_ROOT, file))}`);

    for (const specifier of declarationSpecifiers(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;

        // Post-processed specifiers end in `.js`; the declaration is the `.d.ts` twin.
        const resolved = path.resolve(path.dirname(file), specifier).replace(/\.js$/i, '.d.ts');
        if (!closure.has(resolved)) closure.add(resolved);
    }
}

// ---------------------------------------------------------------------------
// 3. Tarball boundary: what npm would actually ship.
// ---------------------------------------------------------------------------
const pack = run(npm.command, [...npm.args, 'pack', '--dry-run', '--json'], { cwd: PACKAGE_ROOT, ...npm.options });
if (pack.status !== 0) fail(`npm pack --dry-run failed:\n${pack.output}`);

/** @type {{ files?: { path: string, size: number }[] }} */
let packed;
try {
    const parsed = JSON.parse(pack.stdout.replace(/^﻿/u, ''));
    packed = Array.isArray(parsed) ? parsed[0] : parsed;
} catch {
    fail(`npm pack --dry-run did not print JSON on stdout:\n${pack.stdout}`);
}

// The raw report is kept in the repository Temp/ next to the scratch install, so the
// boundary evidence survives the run (no tarball is written: --dry-run).
mkdirSync(scratchRoot, { recursive: true });
writeFileSync(path.join(scratchRoot, 'pack-dry-run.json'), `${JSON.stringify(packed, null, 2)}\n`, 'utf8');

const packedPaths = (packed.files ?? []).map(({ path: file }) => file);
if (packedPaths.length === 0) fail('npm pack reported no files');

// npm always ships the manifest plus a readme/licence at the root; docs/ is the one
// documentation directory the packaging brief allows. Everything else must be dist.
const DEFAULT_INCLUDES = new Set([
    'package.json',
    'readme.md',
    'readme',
    'readme.txt',
    'license',
    'licence',
    'copying',
    'changelog.md',
    'changes.md',
    'notice.txt',
    'security.md',
]);
const ALLOWED_PREFIXES = ['dist/', 'src/', 'docs/'];
// Directories that exist in the repo but must never reach a consumer install. `src/`
// is NOT in this list any more: it is the tree the `development` condition publishes
// (F3), so a dev-mode consumer of the installed package resolves real source. Its
// test layer is still excluded, by the name and segment checks below.
const FORBIDDEN_PREFIXES = ['example/', 'scripts/', 'tests/', 'test/', 'fixtures/', 'coverage/', 'lib/', 'temp/', '.github/'];

const unexpected = packedPaths.filter(
    (file) => !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)) && !DEFAULT_INCLUDES.has(file.toLowerCase())
);
if (unexpected.length > 0) fail(`tarball carries non-library entries: ${unexpected.join(', ')}`);

const forbidden = packedPaths.filter((file) => FORBIDDEN_PREFIXES.some((prefix) => file.toLowerCase().startsWith(prefix)));
if (forbidden.length > 0) fail(`tarball leaks a forbidden directory: ${forbidden.join(', ')}`);

const packedTests = packedPaths.filter(isTestArtifact);
if (packedTests.length > 0) fail(`tarball leaks test files: ${packedTests.join(', ')}`);

// Same rule as the dist check above: with the test layer in `src/tests/`, its
// declarations would land at `dist/tests/**`, which is a *segment* match, never a
// root-level FORBIDDEN_PREFIX match (every tarball dist entry starts with `dist/`).
const packedTestLayer = packedPaths.filter((file) => /(?:^|\/)tests?\//i.test(file));
if (packedTestLayer.length > 0) fail(`tarball carries the test layer: ${packedTestLayer.join(', ')}`);

// The published source tree must be exactly editable TypeScript. Empty means the
// `development` condition resolves to nothing after install; a non-`.ts` entry under
// `src/` (a stylesheet, a nested build output, a compiled twin) is an artifact a
// consumer cannot import through that condition.
const packedSource = packedPaths.filter((file) => file.startsWith('src/'));
if (packedSource.length === 0)
    fail('the tarball carries no src/ source, so the "development" target resolves to nothing after install');
const unexpectedSource = packedSource.filter((file) => !file.endsWith('.ts'));
if (unexpectedSource.length > 0) fail(`src/ carries non-TypeScript entries: ${unexpectedSource.join(', ')}`);

// The exports targets must survive packing, or the published package resolves to
// nothing even though the source tree looks right. This is also the evidence behind
// the deep-import probe below: `./dist/dashboard.d.ts` (the types target) is asserted
// to ship here, so the ONLY thing that can block `@underload/dashboard/dist/dashboard`
// in a consumer is the "exports" map — not a missing file.
for (const { target } of targets) {
    if (!packedPaths.includes(toPosix(path.normalize(target)))) fail(`export target ${target} is not in the tarball`);
}
for (const required of ['README.md', 'package.json']) {
    if (!packedPaths.includes(required)) fail(`npm did not include ${required} in the tarball`);
}

// ---------------------------------------------------------------------------
// 4. Scratch install of the packed shape + real consumer programs.
// ---------------------------------------------------------------------------
mkdirSync(scratchRoot, { recursive: true });

// Children (tsc, node) inherit a temp root inside the repository Temp/ as well.
process.env.TEMP = scratchRoot;
process.env.TMP = scratchRoot;
process.env.TMPDIR = scratchRoot;

const work = mkdtempSync(path.join(scratchRoot, 'run-'));
const installDir = path.join(work, 'node_modules', ...PACKAGE_NAME.split('/'));

// The published shape only: manifest + the tarball entries, copied path-for-path.
mkdirSync(installDir, { recursive: true });
for (const file of packedPaths) {
    const source = path.join(PACKAGE_ROOT, file);
    if (!existsSync(source)) continue;

    const destination = path.join(installDir, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
}

// One consumer module, reused by both resolution modes: the whole public surface
// (factory, plugin API, generic state/service/command/event/slot reads, error class)
// plus the invalid uses that must stay errors, so the published types cannot silently
// loosen relative to src/**.
const consumerSource = `import { dashboard, DashboardError } from '${PACKAGE_NAME}';
import type {
    Dashboard,
    DashboardContribution,
    DashboardContributionInput,
    DashboardErrorCode,
    DashboardOptions,
    DashboardPlugin,
    DashboardPluginAPI,
    DashboardState,
} from '${PACKAGE_NAME}';

// The package publishes no code subpaths, so a deep import is not part of the
// contract; it must stay unresolved in every resolution mode. This is the sharp
// version of that probe: after the entry rename, dist/dashboard.d.ts IS the types
// target and really is installed (the tarball assertions above prove that file
// ships), so the failure below can only come from the "exports" map, never from a
// missing file. Both spellings are checked: the extensionless one a Bundler consumer
// would try, the .js one a NodeNext consumer would try, so a future wildcard subpath
// export cannot quietly reopen the internals.
// @ts-expect-error - './dist/dashboard' is blocked by the "exports" map even though dist/dashboard.d.ts ships.
import { dashboard as deepDashboard } from '${PACKAGE_NAME}/dist/dashboard';
// @ts-expect-error - './dist/dashboard.js' is blocked by the "exports" map for the same reason.
import { dashboard as deepDashboardJs } from '${PACKAGE_NAME}/dist/dashboard.js';

type Panel = { readonly id: string; readonly label: string };
type Line = { readonly role: 'user' | 'assistant'; readonly text: string };
type Transport = { readonly baseUrl: string; send: (prompt: string) => Promise<string> };

const transportPlugin: DashboardPlugin = {
    id: 'transport',
    setup(api: DashboardPluginAPI): void | (() => void) {
        api.service<Transport>('transport', {
            baseUrl: 'http://localhost:5500',
            send: async (prompt: string) => \`\${prompt.trim()} [sent]\`,
        });
    },
};

const composerPlugin: DashboardPlugin = {
    id: 'composer',
    requires: ['transport'],
    setup(api: DashboardPluginAPI): void | (() => void) {
        const transport = api.getService<Transport>('transport');
        const transcript = api.state<Line[]>('composer.transcript', []);
        const busy = api.state<boolean>('composer.busy', false);
        const draft: DashboardState<string> = api.state<string>('composer.draft', '');

        api.command<string, Promise<readonly Line[]>>('composer.send', async (prompt: string) => {
            busy.set(true);
            const text = await transport.send(prompt);
            transcript.set((previous: Line[]) => [...previous, { role: 'assistant', text }]);
            busy.set(false);
            return transcript.get();
        });

        const stop: () => void = api.on<number>('composer.updated', (count: number) => {
            void count;
        });
        api.emit<number>('composer.updated', transcript.get().length);
        stop();

        const contribution: DashboardContributionInput<Panel> = {
            id: 'composer',
            order: 10,
            value: { id: 'composer', label: 'Composer' },
        };
        api.slot<Panel>('workstage', contribution);

        // setup() may hand back a teardown; the value type is exactly that union.
        void draft;
        return () => busy.set(false);
    },
};

const options: DashboardOptions = { plugins: [transportPlugin, composerPlugin] };
const instance: Dashboard = dashboard(options);

export const ranOrder: readonly string[] = instance.plugins;
export const panels: readonly DashboardContribution<Panel>[] = instance.slot<Panel>('workstage');
export const panelIds: readonly string[] = panels.map((contribution: DashboardContribution<Panel>) => contribution.id);
export const busyFlag: boolean = instance.state<boolean>('composer.busy').get();
export const draftValue: string = instance.state<string>('composer.draft').get();
export const transcriptLength: number = instance.state<Line[]>('composer.transcript').get().length;
export const transportBaseUrl: string = instance.service<Transport>('transport').baseUrl;
export const listening: () => void = instance.on<number>('composer.updated', (count: number) => {
    void count;
});
export const silent: void = instance.emit<number>('composer.updated', 0);
export async function send(prompt: string): Promise<readonly Line[]> {
    return instance.execute<string, Promise<readonly Line[]>>('composer.send', prompt);
}
export const failure: DashboardError = new DashboardError('disposed', 'Dashboard is disposed.');
export const failureCode: DashboardErrorCode = failure.code;
export const disposed: boolean = instance.disposed;
instance.dispose();

// Invalid uses that must keep failing (a satisfied @ts-expect-error would itself
// fail the build, so each of these is pinned in both directions).
// @ts-expect-error - a DashboardPlugin without an id cannot be validated or ordered.
const pluginWithoutId: DashboardPlugin = { setup(): void {} };
// @ts-expect-error - state() is generic: a string cell read as a number is a type error.
const wrongStateType: number = instance.state<string>('composer.draft').get();
// @ts-expect-error - DashboardErrorCode is a closed union of documented codes.
const inventedCode: DashboardErrorCode = 'not-a-real-code';

void deepDashboard;
void deepDashboardJs;
void pluginWithoutId;
void wrongStateType;
void inventedCode;
`;

/** Writes one consumer project (package.json + tsconfig + index.ts) in `work`. */
const consumer = (name, compilerOptions) => {
    const directory = path.join(work, name);
    mkdirSync(directory, { recursive: true });

    // `"type": "module"` keeps the consumer itself in ESM mode, so the NodeNext rules
    // apply symmetrically to its own specifiers; Node/TS module resolution still walks
    // up to `<work>/node_modules`, which is where the package is installed.
    writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name, private: true, type: 'module' }, null, 4)}\n`, 'utf8');
    writeFileSync(
        path.join(directory, 'tsconfig.json'),
        `${JSON.stringify(
            {
                compilerOptions: {
                    target: 'ESNext',
                    strict: true,
                    noEmit: true,
                    // The whole point: the package's own declarations are checked, and
                    // no ambient @types may cover for a missing one.
                    skipLibCheck: false,
                    types: [],
                    lib: ['ESNext'],
                    ...compilerOptions,
                },
                include: ['index.ts'],
            },
            null,
            4
        )}\n`,
        'utf8'
    );
    writeFileSync(path.join(directory, 'index.ts'), consumerSource, 'utf8');

    return directory;
};

const consumers = [
    // F1: Node 16+/NodeNext resolution — the mode that used to break.
    { name: 'NodeNext consumer', directory: consumer('consumer-nodenext', { module: 'NodeNext', moduleResolution: 'NodeNext' }) },
    // The library program's own mode: the new `.js` specifiers must not confuse it.
    { name: 'Bundler consumer', directory: consumer('consumer-bundler', { module: 'ESNext', moduleResolution: 'Bundler' }) },
];

// Runtime probe: proves the packed ESM entry imports BY NAME under Node (i.e. the
// exports map resolves), that a non-exported subpath is rejected BY THE MAP
// (ERR_PACKAGE_PATH_NOT_EXPORTED, not ERR_MODULE_NOT_FOUND), and that documented
// behaviour is intact — right types alone are not enough. Exact values, so a
// behaviour change fails here too.
const runtimeDir = path.join(work, 'consumer-runtime');
mkdirSync(runtimeDir, { recursive: true });
writeFileSync(path.join(runtimeDir, 'package.json'), `${JSON.stringify({ name: 'consumer-runtime', private: true, type: 'module' }, null, 4)}\n`, 'utf8');
writeFileSync(
    path.join(runtimeDir, 'entry.mjs'),
    `import assert from 'node:assert/strict';
import { dashboard, DashboardError } from '${PACKAGE_NAME}';

const demo = {
    id: 'demo',
    setup(api) {
        const count = api.state('demo.count', 0);
        count.set((previous) => previous + 1);
        api.service('demo.service', { label: 'demo' });
        api.command('demo.double', (value) => value * 2);
        api.slot('demo.panels', { id: 'b', order: 2, value: 'second' });
        api.slot('demo.panels', { id: 'a', order: 1, value: 'first' });
    },
};
const dependent = { id: 'dependent', requires: ['demo'], setup: () => undefined };

const instance = dashboard({ plugins: [demo, dependent] });
assert.deepEqual(instance.plugins, ['demo', 'dependent']);
assert.equal(instance.state('demo.count').get(), 1);
assert.equal(instance.service('demo.service').label, 'demo');
assert.equal(instance.execute('demo.double', 21), 42);
assert.deepEqual(
    instance.slot('demo.panels').map((contribution) => contribution.id),
    ['a', 'b']
);

instance.dispose();

let code = 'no-throw';
try {
    instance.state('demo.count');
} catch (error) {
    code = error instanceof DashboardError ? error.code : 'not-a-DashboardError';
}
assert.equal(code, 'disposed');

// Runtime half of the boundary proof: the file the deep import names really is in the
// install (dist/dashboard.d.ts is the published types target), so a failure here can
// only come from the "exports" map. A missing file would surface as
// ERR_MODULE_NOT_FOUND instead, which is why the code is asserted exactly.
let deepImport = 'no-throw';
try {
    await import('${PACKAGE_NAME}/dist/dashboard.js');
} catch (error) {
    deepImport = error && typeof error === 'object' ? String(error.code ?? error.constructor.name) : String(error);
}
assert.equal(deepImport, 'ERR_PACKAGE_PATH_NOT_EXPORTED');

console.log('runtime-ok ' + JSON.stringify({ plugins: [...instance.plugins], code, deepImport }));
`,
    'utf8'
);

const keep = process.argv.includes('--keep');
const runtime = run(process.execPath, ['entry.mjs'], { cwd: runtimeDir });
const results = consumers.map((entry) => ({ ...entry, ...run(process.execPath, [tsc, '-p', entry.directory], { cwd: entry.directory }) }));

if (!keep) rmSync(work, { recursive: true, force: true });

let failed = false;

for (const result of results) {
    if (result.status === 0) {
        console.log(`package check: ${result.name} OK`);
        continue;
    }

    failed = true;
    console.error(`package check: ${result.name} FAILED\n${result.output}`);
}

if (runtime.status !== 0) {
    failed = true;
    console.error(`package check: packed ESM runtime FAILED\n${runtime.output}`);
} else {
    console.log(`package check: packed ESM runtime OK (${runtime.output.split(/\r?\n/).pop()})`);
}

if (failed) process.exit(1);

// One-line boundary summary: declarations, closure, and the tarball split into the
// bundle, the published source, and every remaining entry named explicitly (npm's
// default includes are the only thing that may appear there).
const nonDist = packedPaths.filter((file) => !file.startsWith('dist/') && !file.startsWith('src/'));
console.log(
    `package check: ${declarationState.scanned} declaration file(s) NodeNext-clean, ${closure.size} declaration(s) in the ` +
        `public closure, ${packedPaths.length} tarball entry(ies) (${packedSource.length} src/ source file(s), ` +
        `${nonDist.length ? `non-dist/non-src: ${nonDist.join(', ')}` : 'no other entry'}) ` +
        `for ${PACKAGE_NAME}@${manifest.version}; scratch ${keep ? `kept at ${work}` : 'removed'}`
);
