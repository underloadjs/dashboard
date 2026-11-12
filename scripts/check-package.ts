// Source-only packaging proof for @underload/dashboard: does the PUBLISHED artifact
// work for real consumers, and does it contain ONLY the library source?
//
// WHY THIS EXISTS
// The source suite (vitest, `moduleResolution: bundler`) cannot see two defect
// classes, and this gate is the only place that checks the shape a consumer
// actually downloads:
//   F1  the manifest drifts away from the SOURCE-ONLY contract. This package is a
//       library, and libraries in this workspace publish TypeScript source, not a
//       build: every export condition (including `types`), plus `main`/`module`/
//       `types`, resolve to `./src/dashboard.ts`; `files` publishes `src/` only;
//       and no build output (`dist/`, `*.mjs`, `*.cjs`, `*.d.ts`) is shipped at
//       all. A `dist` target sneaking back into the map is invisible in-repo
//       (Vite/vitest/vite-node resolve source either way) but breaks the published
//       package the moment `dist/` stops being produced. §1 pins the manifest,
//       §3 pins the tarball.
//   F2  package boundaries were only carried by intent. The real
//       `npm pack --dry-run --json` report is parsed here: every tarball entry must
//       be library SOURCE (src/**), an npm default include (manifest, readme,
//       licence, docs) — never `example/`, `scripts/`, `dist/`, a test file, a test
//       layer directory anywhere in the published tree (`src/tests/**`), a built
//       artifact (`.mjs`/`.cjs`/`.js`/`.d.ts`/`.map`), or `.github/workflows`. That
//       same packed entry list is copied into the scratch install, so the type-check
//       and the runtime probe run against exactly what a consumer downloads.
//   F3  source-first resolution must survive PACKING. A `src/*.ts` target that is
//       not in the tarball resolves to nothing after install, so `src/` must be
//       published (minus its test layer) and every export target must appear in the
//       packed entry list (§3). §4 then compiles a real consumer that imports the
//       package BY NAME from a scratch `node_modules` holding the packed shape (a
//       tsconfig `paths` alias, like the one in example/tsconfig.json, would prove
//       nothing), and §5 executes that same packed entry through vite-node, so the
//       behaviour is proven and not just the types.
//
// WHAT THE SOURCE-ONLY CONTRACT COSTS (deliberate, and the reason the old
// NodeNext fixture is gone): a consumer compiling with
// `module`/`moduleResolution: NodeNext` reads `src/dashboard.ts`, whose relative
// specifiers are extensionless (`./core`), and TS2834 fires once per such
// specifier. Emitting `.d.ts` with explicit `.js` specifiers is what used to pay
// that cost; the source-only ruling retires the emit, so NodeNext consumers read
// the same tree a bundler does. Every in-repo consumer (distribution/chat-assistant,
// example/) and the sibling harness (packages/underload/harness, `types` ->
// `src/index.ts`, extensionless specifiers) resolve with
// `moduleResolution: bundler`, which is the mode §4 pins exactly.
//
// USAGE
//     yarn vite-node scripts/check-package.ts             # no build step needed
//     yarn vite-node scripts/check-package.ts --keep      # keep the scratch tree
//     yarn vite-node scripts/check-package.ts --scratch <dir>
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
//   - ../package.json                              — exports/files/scripts contract under test
//   - ../src/dashboard.ts                          — the single public entry every condition names
//   - ../src/tests/resolution.test.ts              — fast, build-free mirror of §1 inside `npm test`
//   - ../example/vite-shared.ts                    — the in-repo consumer alias onto the same entry
//   - ../vitest.config.ts                          — the runner that executes the packed entry in §5
//   - packages/underload/harness/package.json      — the reference source-only exports/files shape
//   - Consumer fixtures are INLINE (this file), so the example app staying out of
//     the tarball cannot break this proof.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@underload/dashboard';
const MANIFEST_PATH = path.join(PACKAGE_ROOT, 'package.json');
const SRC_DIR = path.join(PACKAGE_ROOT, 'src');

// The only path the manifest is allowed to publish as code: the raw entry. It is the
// only file at src/ root, and the tree below it (src/core, src/extensions, src/plugin,
// src/types) is reached through its extensionless relative specifiers, which the
// bundler-mode resolvers every consumer of this package uses resolve natively.
const SOURCE_TARGET = './src/dashboard.ts';

// Source-only publishing has no build layer, so these are the artifacts that must
// never appear in the tarball again (the `.js`/`.d.ts`/`.map` pair is what a stray
// `tsc`/`vite build` emit would leave behind inside `src/`).
const BUILT_EXTENSIONS = /\.(?:mjs|cjs|js|d\.ts|map)$/iu;

// The `never` return is annotated on the VARIABLE (not only on the arrow), which is
// what makes TypeScript treat a `fail(...)` call as an unreachable endpoint: the
// `resolveTsc`/`resolveViteNode` fallbacks and the `npm pack` parse guard below rely on
// that to keep `packed`/the return type definitely assigned.
const fail: (message: string) => never = (message) => {
    console.error(`package check: ${message}`);
    process.exit(1);
};

// A test artifact by name — used for both src/ and the tarball, so "shipped test"
// has a single definition (`.test.ts`, `*.spec.mjs`, `foo.test.d.ts`, test dirs).
const TEST_FILE = /(^|[/.])(?:test|spec)(?:[.-]|$)/iu;
const isTestArtifact = (file: string): boolean => TEST_FILE.test(file);

// `files[].path` from npm is POSIX; every path comparison in here uses POSIX form.
const toPosix = (value: string): string => value.split(path.sep).join('/');

/** Every file under `directory`, POSIX-relative to it, sorted. */
const listFiles = (directory: string, relativeTo: string = directory): string[] => {
    const files: string[] = [];

    if (!existsSync(directory)) return files;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) files.push(...listFiles(full, relativeTo));
        else files.push(toPosix(path.relative(relativeTo, full)));
    }

    return files.sort();
};

/** Flattens an exports map into `{ condition, target }` pairs (one subpath here). */
const exportTargets = (value: unknown, condition: string = '.'): { condition: string; target: string }[] => {
    if (typeof value === 'string') return [{ condition, target: value }];

    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => exportTargets(nested, `${condition}.${key}`));
};

// Resolves a tool CLI without assuming the install layout (workspace hoisting in the
// monorepo vs. a standalone `yarn install` inside the package). Both candidates are
// JS launchers, never repo `.ts` entries, so spawning them through
// `process.execPath` stays compliant with the runner policy (root AGENTS.md).
const resolveUpward = (relativeTool: string): string | undefined => {
    const candidates = [
        path.join(PACKAGE_ROOT, 'node_modules', relativeTool),
        ...Array.from({ length: 4 }, (_, index) =>
            path.join(PACKAGE_ROOT, ...Array.from({ length: index + 1 }, () => '..'), 'node_modules', relativeTool)
        ),
    ];

    for (const candidate of candidates) if (existsSync(candidate)) return candidate;

    return undefined;
};

const resolveTsc = (): string => {
    const local = resolveUpward(path.join('typescript', 'bin', 'tsc'));
    if (local !== undefined) return local;

    try {
        return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    } catch {
        return fail('typescript is not installed — install the package dependencies first');
    }
};

// vite-node is the ONLY runner for repo TypeScript (root AGENTS.md), so the runtime
// probe spawns its own CLI (`vite-node <entry.ts>`), never a bare node on a .ts file.
const resolveViteNode = (): string => {
    const local = resolveUpward(path.join('vite-node', 'dist', 'cli.mjs'));
    if (local !== undefined) return local;

    try {
        return path.join(path.dirname(require.resolve('vite-node/package.json')), 'dist', 'cli.mjs');
    } catch {
        return fail('vite-node is not installed — install the package dependencies first');
    }
};

/** Runs a command and returns `{ status, stdout, stderr, output }` (both streams captured). */
const run = (
    command: string,
    args: string[],
    options: { cwd?: string; shell?: boolean } = {}
): { status: number; stdout: string; stderr: string; output: string } => {
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
const resolveNpm = (): { command: string; args: string[]; options: { shell?: boolean } } => {
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
const findWorkspaceRoot = (start: string): string | undefined => {
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

type PackageManifest = {
    name: string;
    type: string;
    version: string;
    main: string;
    module: string;
    types: string;
    exports: Record<string, unknown>;
    files: string[];
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
};

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as PackageManifest;
const tsc = resolveTsc();
const viteNode = resolveViteNode();

// `--scratch <dir>` overrides the location for a CI runner whose workspace sits
// elsewhere; a trailing flag is not treated as the directory.
const scratchIndex = process.argv.indexOf('--scratch');
const scratchArg = scratchIndex >= 0 ? process.argv[scratchIndex + 1] : undefined;
const scratchRoot = path.resolve(scratchArg !== undefined && !scratchArg.startsWith('--') ? scratchArg : defaultScratchRoot);

// ---------------------------------------------------------------------------
// 1. Manifest contract: ESM-only, one public entry, SOURCE for every condition,
//    no build output named anywhere, no dependencies.
// ---------------------------------------------------------------------------
if (manifest.name !== PACKAGE_NAME) fail(`unexpected package name '${manifest.name}'`);
if (manifest.type !== 'module') fail('package.json must stay "type": "module" (the published source is ESM)');

// `files` is pinned exactly, because both halves carry a defect:
//   - adding `dist` (or any build directory) ships an artifact this package no longer
//     produces, and npm then publishes a stale tree;
//   - dropping any `!src/**` negation ships the conformance suite (and any
//     snapshot/nested-install noise) to every consumer.
const EXPECTED_FILES = [
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

// Legacy resolution fields: `main`/`module`/`types` are what a consumer with a
// resolver that ignores "exports" reads, and the exports map does not cover them, so
// an entry rename has to land in BOTH places. Under source-only publishing they point
// at the same file the export conditions do — same shape as
// packages/underload/harness/package.json.
if (manifest.main !== SOURCE_TARGET) fail(`"main" must stay ${SOURCE_TARGET}, got ${JSON.stringify(manifest.main)}`);
if (manifest.module !== SOURCE_TARGET) fail(`"module" must stay ${SOURCE_TARGET}, got ${JSON.stringify(manifest.module)}`);
if (manifest.types !== SOURCE_TARGET) fail(`"types" must stay ${SOURCE_TARGET}, got ${JSON.stringify(manifest.types)}`);

const exportsMap = manifest.exports ?? {};
const publicSubpaths = Object.keys(exportsMap).sort().join(',');
if (publicSubpaths !== '.,./package.json')
    fail(`only the root entry and ./package.json may be exported, got [${publicSubpaths}]`);

// `./package.json` is a manifest re-export, not code: exempt from the target rule.
const targets = exportTargets(exportsMap).filter(({ target }) => !target.endsWith('package.json'));
if (targets.length === 0) fail('the root entry must publish at least one source target');

// Every condition family resolves to the SAME source file: there is no bundle to
// disagree with, no declaration to point `types` at, and no `development` condition
// left to special-case (the harness shape). A condition that names anything else —
// `./dist/…` above all — is the F1 regression this gate exists to catch.
for (const { condition, target } of targets) {
    if (target !== SOURCE_TARGET) fail(`"${condition}" must point at ${SOURCE_TARGET}, got ${target}`);
    if (/(?:^|\/)dist\/|\.(?:mjs|cjs|d\.ts)$/iu.test(target)) fail(`"${condition}" names a build artifact: ${target}`);
    // A dangling exports target is MODULE_NOT_FOUND for the consumer at runtime.
    if (!existsSync(path.join(PACKAGE_ROOT, target))) fail(`export target does not exist on disk: ${target}`);
}

// The condition set is pinned exactly: a condition the rule above would happily pass
// on a wildcard (e.g. a `browser` or `node` condition added without deciding what a
// browser host gets) still has to be an explicit decision here. The walk prefixes each
// key with its subpath (`.` -> `..types`), so only bare condition names are compared.
const conditions = targets.map(({ condition }) => condition.replace(/^\.+/u, '')).sort();
const EXPECTED_CONDITIONS = ['default', 'types'];
if (JSON.stringify(conditions) !== JSON.stringify(EXPECTED_CONDITIONS))
    fail(`the root entry must declare exactly [${EXPECTED_CONDITIONS.join(', ')}], got [${conditions.join(', ')}]`);

// ---------------------------------------------------------------------------
// 2. Source tree: present, the only thing the package owns, and import-free.
// ---------------------------------------------------------------------------
if (!existsSync(path.join(SRC_DIR, 'dashboard.ts'))) fail(`the published entry is missing: ${SOURCE_TARGET}`);

const srcFiles = listFiles(SRC_DIR);
if (srcFiles.length === 0) fail('src/ is empty — the published source tree is the package');

// The published source must be editable TypeScript and nothing else: a `.js`/`.mjs`/
// `.cjs`/`.d.ts`/`.map` twin inside src/ is a build output that would ship beside the
// source (and resolve ahead of it for some resolvers).
const srcBuilt = srcFiles.filter((file) => BUILT_EXTENSIONS.test(file));
if (srcBuilt.length > 0) fail(`src/ carries built artifacts: ${srcBuilt.join(', ')}`);

const srcUnexpected = srcFiles.filter((file) => !/\.tsx?$/iu.test(file));
if (srcUnexpected.length > 0) fail(`src/ carries non-TypeScript entries: ${srcUnexpected.join(', ')}`);

// Undeclared-dependency scan. The bundle used to hide the runtime graph, so this is
// the only place that proves the published source imports nothing outside the
// package: every bare specifier in src/** must be a `node:` builtin or a declared
// dependency, and the core is dependency-free (checked above), so the real expected
// list is empty. Without this, one `import { x } from 'some-package'` would make the
// published entry fail to install-and-run and no in-repo test would notice.
const SPECIFIER_PATTERNS: RegExp[] = [
    /\bfrom\s*['"]([^'"]+)['"]/gu, // static `import … from` and `export … from`
    /\bimport\s*\(\s*['"]([^'"]+)['"]/gu, // dynamic `import('…')`
    /\brequire\s*\(\s*['"]([^'"]+)['"]/gu, // `require('…')`
    /\bimport\s+['"]([^'"]+)['"]/gu, // side-effect `import '…'`
];

const declaredDependencies = new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
]);

const undeclaredImports: string[] = [];
// Only the PUBLISHED files are scanned: the test layer (src/tests/**, `*.test.ts`) is
// excluded from the tarball, so its `vitest`/`vite` imports resolve from devDependencies
// and are none of a consumer's business. devDependencies are deliberately NOT added to
// the declared set — a shipped src/ file importing a devDependency is exactly the defect
// this scan exists to catch.
for (const file of srcFiles.filter(
    (name) => /\.tsx?$/iu.test(name) && !isTestArtifact(name) && !/(?:^|\/)tests?\//iu.test(name)
)) {
    const text = readFileSync(path.join(SRC_DIR, file), 'utf8');

    for (const pattern of SPECIFIER_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            const specifier = match[1];

            // Relative/absolute specifiers are inside the package by definition.
            if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
            // `node:` prefixed builtins need no manifest entry (the core imports none).
            if (specifier.startsWith('node:')) continue;

            // A scoped package is declared by its full name; a bare one by its root
            // (`some-package/dist/thing` is still `some-package`).
            const rootName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
            if (declaredDependencies.has(rootName)) continue;

            if (!undeclaredImports.includes(`${specifier} in ${file}`)) undeclaredImports.push(`${specifier} in ${file}`);
        }
    }
}
if (undeclaredImports.length > 0)
    fail(`src/ imports undeclared package(s): ${undeclaredImports.join(', ')} — add a dependency or drop the import`);

// ---------------------------------------------------------------------------
// 3. Tarball boundary: what npm would actually ship.
// ---------------------------------------------------------------------------
const pack = run(npm.command, [...npm.args, 'pack', '--dry-run', '--json'], { cwd: PACKAGE_ROOT, ...npm.options });
if (pack.status !== 0) fail(`npm pack --dry-run failed:\n${pack.output}`);

type PackReport = { files?: { path: string; size: number }[] };
let packed: PackReport;
try {
    const parsed: unknown = JSON.parse(pack.stdout.replace(/^\uFEFF/u, ''));
    packed = (Array.isArray(parsed) ? parsed[0] : parsed) as PackReport;
} catch {
    // `fail` is annotated `never`, so this endpoint is unreachable and `packed`
    // is still definitely assigned for the code below.
    fail(`npm pack --dry-run did not print JSON on stdout:\n${pack.stdout}`);
}

// The raw report is kept in the repository Temp/ next to the scratch install, so the
// boundary evidence survives the run (no tarball is written: --dry-run).
mkdirSync(scratchRoot, { recursive: true });
writeFileSync(path.join(scratchRoot, 'pack-dry-run.json'), `${JSON.stringify(packed, null, 2)}\n`, 'utf8');

const packedPaths = (packed.files ?? []).map(({ path: file }) => file);
if (packedPaths.length === 0) fail('npm pack reported no files');

// npm always ships the manifest plus a readme/licence at the root; docs/ is the one
// documentation directory the packaging brief allows. Everything else must be source.
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
const ALLOWED_PREFIXES = ['src/', 'docs/'];
// Directories that must never reach a consumer install. `dist/` is now a leak rather
// than the payload: the library publishes source, and a `dist/` in the tarball means
// either `files` grew back or a build output went stale-and-published.
const FORBIDDEN_PREFIXES = ['dist/', 'example/', 'scripts/', 'tests/', 'test/', 'fixtures/', 'coverage/', 'lib/', 'temp/', '.github/'];

const unexpected = packedPaths.filter(
    (file) => !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)) && !DEFAULT_INCLUDES.has(file.toLowerCase())
);
if (unexpected.length > 0) fail(`tarball carries non-library entries: ${unexpected.join(', ')}`);

const forbidden = packedPaths.filter((file) => FORBIDDEN_PREFIXES.some((prefix) => file.toLowerCase().startsWith(prefix)));
if (forbidden.length > 0) fail(`tarball leaks a forbidden directory: ${forbidden.join(', ')}`);

const packedTests = packedPaths.filter(isTestArtifact);
if (packedTests.length > 0) fail(`tarball leaks test files: ${packedTests.join(', ')}`);

// With the test layer in `src/tests/`, its path is a *segment* match, never a
// root-level FORBIDDEN_PREFIX match (every tarball entry starts with `src/`, so
// `tests/` is never a prefix of the whole path).
const packedTestLayer = packedPaths.filter((file) => /(?:^|\/)tests?\//iu.test(file));
if (packedTestLayer.length > 0) fail(`tarball carries the test layer: ${packedTestLayer.join(', ')}`);

// No built artifact anywhere in the tarball — the headline source-only rule. This is
// checked over EVERY entry (not just src/) so a root-level `index.mjs` or a stray
// `dist/` twin fails here even if the prefix rules below were relaxed.
const packedBuilt = packedPaths.filter((file) => BUILT_EXTENSIONS.test(file));
if (packedBuilt.length > 0) fail(`tarball carries built artifact(s) (.mjs/.cjs/.js/.d.ts/.map): ${packedBuilt.join(', ')}`);

// The published source tree must be exactly editable TypeScript. Empty means every
// export condition resolves to nothing after install; a non-`.ts` entry under `src/`
// (a stylesheet, a nested build output, a compiled twin) is an artifact a consumer
// cannot import through a source condition.
const packedSource = packedPaths.filter((file) => file.startsWith('src/'));
if (packedSource.length === 0) fail('the tarball carries no src/ source, so the export targets resolve to nothing after install');
const unexpectedSource = packedSource.filter((file) => !/\.tsx?$/iu.test(file));
if (unexpectedSource.length > 0) fail(`src/ carries non-TypeScript entries: ${unexpectedSource.join(', ')}`);

// The exports targets must survive packing, or the published package resolves to
// nothing even though the source tree looks right. This is also the evidence behind
// the deep-import probe in §4: `./src/core/index.ts` really is installed (it is part
// of the src/ list asserted above), so the ONLY thing that can block
// `@underload/dashboard/src/core` in a consumer is the "exports" map.
for (const { target } of targets) {
    if (!packedPaths.includes(toPosix(path.normalize(target)))) fail(`export target ${target} is not in the tarball`);
}
for (const required of ['README.md', 'package.json']) {
    if (!packedPaths.includes(required)) fail(`npm did not include ${required} in the tarball`);
}

// ---------------------------------------------------------------------------
// 4. Scratch install of the packed shape + a real consumer program, and §5 the
//    same entry executed through vite-node.
// ---------------------------------------------------------------------------
// Children (tsc, vite-node) inherit a temp root inside the repository Temp/ as well.
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

// One consumer module: the whole public surface (factory, plugin API, generic
// state/service/command/event/slot reads, error class) plus the invalid uses that
// must stay errors, so the published types cannot silently loosen relative to
// src/**. Compiled with `moduleResolution: bundler` — the mode every consumer of a
// source-only library actually uses (see the header for the NodeNext consequence).
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
// contract; it must stay unresolved. This is the sharp version of that probe:
// src/core/index.ts IS installed (the tarball assertions above prove the src/ tree
// ships), so the failure below can only come from the "exports" map, never from a
// missing file. Both spellings are checked: the extensionless one a Bundler consumer
// would try, the explicit one an ESM consumer would try, so a future wildcard subpath
// export cannot quietly reopen the internals.
// @ts-expect-error - './src/core' is blocked by the "exports" map even though src/core/index.ts ships.
import { fail } from '${PACKAGE_NAME}/src/core';
// @ts-expect-error - './src/core.js' is blocked by the "exports" map for the same reason.
import { failAgain } from '${PACKAGE_NAME}/src/core.js';

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

void fail;
void failAgain;
void pluginWithoutId;
void wrongStateType;
void inventedCode;
`;

/** Writes one consumer project (package.json + tsconfig + index.ts) in `work`. */
const consumer = (name: string, compilerOptions: Record<string, unknown>): string => {
    const directory = path.join(work, name);
    mkdirSync(directory, { recursive: true });

    // `"type": "module"` keeps the consumer itself in ESM mode, so the resolution
    // rules apply symmetrically to its own specifiers; Node/TS module resolution
    // still walks up to `<work>/node_modules`, which is where the package is
    // installed.
    writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name, private: true, type: 'module' }, null, 4)}\n`, 'utf8');
    writeFileSync(
        path.join(directory, 'tsconfig.json'),
        `${JSON.stringify(
            {
                compilerOptions: {
                    target: 'ESNext',
                    strict: true,
                    noEmit: true,
                    // The whole point: the published SOURCE is checked (its own
                    // relative specifiers included), and no ambient @types may cover
                    // for a missing one.
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
    // The mode this package publishes for: Vite/vitest/vite-node resolution, which is
    // what example/, distribution/chat-assistant and every bundler consumer uses.
    { name: 'Bundler consumer', directory: consumer('consumer-bundler', { module: 'ESNext', moduleResolution: 'Bundler' }) },
];

// Runtime probe: proves the packed SOURCE entry imports BY NAME and behaves — right
// types alone are not enough. Exact values, so a behaviour change fails here too.
// It runs through vite-node because the entry it resolves is `src/dashboard.ts`, which
// plain Node cannot execute (root AGENTS.md: vite-node is the repo runner for .ts).
const runtimeDir = path.join(work, 'consumer-runtime');
mkdirSync(runtimeDir, { recursive: true });
writeFileSync(
    path.join(runtimeDir, 'package.json'),
    `${JSON.stringify({ name: 'consumer-runtime', private: true, type: 'module' }, null, 4)}\n`,
    'utf8'
);
writeFileSync(
    path.join(runtimeDir, 'entry.ts'),
    `import assert from 'node:assert/strict';
import { dashboard, DashboardError } from '${PACKAGE_NAME}';

const demo = {
    id: 'demo',
    setup(api: any): void {
        const count = api.state<number>('demo.count', 0);
        count.set((previous: number) => previous + 1);
        api.service<{ label: string }>('demo.service', { label: 'demo' });
        api.command<number, number>('demo.double', (value: number) => value * 2);
        api.slot<string>('demo.panels', { id: 'b', order: 2, value: 'second' });
        api.slot<string>('demo.panels', { id: 'a', order: 1, value: 'first' });
    },
};
const dependent = { id: 'dependent', requires: ['demo'], setup: (): undefined => undefined };

const instance = dashboard({ plugins: [demo, dependent] });
assert.deepEqual(instance.plugins, ['demo', 'dependent']);
assert.equal(instance.state<number>('demo.count').get(), 1);
assert.equal(instance.service<{ label: string }>('demo.service').label, 'demo');
assert.equal(instance.execute<number, number>('demo.double', 21), 42);
assert.deepEqual(
    instance.slot<string>('demo.panels').map((contribution: { id: string }) => contribution.id),
    ['a', 'b']
);

instance.dispose();

let code = 'no-throw';
try {
    instance.state<number>('demo.count');
} catch (error) {
    code = error instanceof DashboardError ? error.code : 'not-a-DashboardError';
}
assert.equal(code, 'disposed');

console.log('runtime-ok ' + JSON.stringify({ plugins: [...instance.plugins], code }));
`,
    'utf8'
);

const keep = process.argv.includes('--keep');
const runtime = run(process.execPath, [viteNode, 'entry.ts'], { cwd: runtimeDir });
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
    console.error(`package check: packed source runtime (vite-node) FAILED\n${runtime.output}`);
} else {
    console.log(`package check: packed source runtime (vite-node) OK (${runtime.output.split(/\r?\n/u).pop()})`);
}

if (failed) process.exit(1);

// One-line boundary summary: the source tree, the tarball split into published source
// and every remaining entry named explicitly (npm's default includes are the only
// thing that may appear there), and proof that no build output shipped.
const nonSrc = packedPaths.filter((file) => !file.startsWith('src/'));
console.log(
    `package check: ${srcFiles.length} source file(s) in src/, 0 undeclared import(s), ${packedPaths.length} tarball entry(ies) ` +
        `(${packedSource.length} published source file(s), no dist/ and no built artifact, ` +
        `${nonSrc.length ? `non-src: ${nonSrc.join(', ')}` : 'no other entry'}) ` +
        `for ${PACKAGE_NAME}@${manifest.version}; scratch ${keep ? `kept at ${work}` : 'removed'}`
);
