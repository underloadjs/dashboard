// Deterministic failure surface for @underload/dashboard.
//
// Every failure raised by the framework is a DashboardError carrying a stable
// `code`, so hosts (and the future harness adapter) branch on machine-readable
// data instead of matching human-readable message text. Message text is
// diagnostic only and is NOT part of the contract.
//
// Cross-references:
//   - ../plugin/order.ts     — 'invalid-options' / plugin-graph codes (build time, before setup)
//   - ../extensions/registries.ts — 'invalid-*' / 'duplicate-*' / 'unknown-*' per-registry codes
//   - ./listeners.ts         — 'listener-failed' (notification isolation)
//   - ../dashboard.ts        — 'disposed' / 'registration-out-of-scope' / 'setup-failed' / 'cleanup-failed'

export type DashboardErrorCode =
    // ---- input shape (dashboard(options)) ----
    | 'invalid-options' // options object or options.plugins has the wrong shape
    | 'invalid-plugin' // entry is not an object, or has no callable setup()
    | 'invalid-plugin-id' // plugin id is not a non-empty string
    | 'invalid-plugin-requires' // requires is not an array of non-empty strings
    | 'invalid-cleanup' // setup() returned something that is neither void nor a function
    | 'invalid-identifier' // state/service/command id, or event/slot name, is not a non-empty string
    | 'invalid-handler' // command/event handler is not a function
    | 'invalid-contribution' // slot contribution record is malformed (shape, id, or order)
    // ---- plugin graph (resolved before any setup() runs) ----
    | 'duplicate-plugin-id'
    | 'missing-dependency'
    | 'cyclic-dependency'
    // ---- lifecycle ----
    | 'registration-out-of-scope' // registration attempted outside its own plugin setup()
    | 'disposed' // any operation after dispose() (or after a discarded build)
    | 'setup-failed' // a plugin's setup() threw; the build is discarded and rolled back
    | 'cleanup-failed' // one or more cleanups threw while disposing
    // ---- registries ----
    | 'duplicate-state'
    | 'duplicate-service'
    | 'duplicate-command'
    | 'duplicate-contribution'
    | 'unknown-state'
    | 'unknown-service'
    | 'unknown-command'
    | 'listener-failed'; // a state/event listener threw; delivery was not interrupted

// Extra data attached to an error.
//   cause  - the underlying failure being carried. Present for 'setup-failed'
//            (whatever setup() threw, unmodified) and for 'listener-failed' /
//            'cleanup-failed' (the first collected failure). Absent for
//            'invalid-cleanup', where plugin code threw nothing, and for every
//            single-site registry/lifecycle rejection.
//   errors - every collected failure: 'setup-failed' and 'invalid-cleanup' carry
//            the rollback cleanup failures, 'cleanup-failed' and
//            'listener-failed' carry all of theirs. [] when nothing was aggregated.
export type DashboardErrorDetails = {
    cause?: unknown;
    errors?: readonly unknown[];
};

export class DashboardError extends Error {
    readonly code: DashboardErrorCode;
    readonly cause?: unknown;
    readonly errors: readonly unknown[];

    constructor(code: DashboardErrorCode, message: string, details?: DashboardErrorDetails) {
        super(message);
        // Restores the prototype chain when the emitted class is transposed by a
        // down-level bundler, which otherwise breaks `error instanceof DashboardError`.
        Object.setPrototypeOf(this, DashboardError.prototype);
        this.name = 'DashboardError';
        this.code = code;
        this.cause = details ? details.cause : undefined;
        this.errors = details && details.errors ? details.errors : [];
    }
}

// Small helper so every throw site stays one line and every message stays
// prefixed the same way; `never` keeps control-flow analysis honest at call sites.
export function fail(code: DashboardErrorCode, message: string, details?: DashboardErrorDetails): never {
    throw new DashboardError(code, message, details);
}

// Renders an offending value for error text without ever throwing itself
// (JSON.stringify would blow up on circular objects and BigInt).
export function describeValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'string') return JSON.stringify(value);
    if (type === 'number' || type === 'boolean') return String(value);
    if (type === 'symbol' || type === 'bigint') return String(value);
    if (type === 'function') return 'a function';
    return 'a non-empty object';
}
