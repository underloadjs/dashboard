// Shared identifier validation for every registry key.
//
// State ids, service ids, command ids, event names and slot names are all
// plain non-empty strings. Rejecting anything else at the registration site
// keeps failures attributable to the plugin that caused them; silently accepting
// `''` or `undefined` would create channels that no lookup can name.
//
// Cross-references: ../extensions/state.ts, ../extensions/bus.ts,
// ../extensions/registries.ts (callers), ./errors.ts ('invalid-identifier' code).

import { describeValue, fail } from './errors';

export function requireIdentifier(kind: string, value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        fail('invalid-identifier', `${kind} must be a non-empty string, received ${describeValue(value)}.`);
    }
    return value as string;
}

// Handlers must be callable. Typed consumers cannot hit this; plain-JS
// consumers get a clear registration-site failure instead of a later
// "is not a function" TypeError.
export function requireHandler(kind: string, value: unknown): void {
    if (typeof value !== 'function') {
        fail('invalid-handler', `${kind} must be a function, received ${describeValue(value)}.`);
    }
}

// Renders a registration owner for duplicate-definition messages. Every owner in
// this framework is a plugin, but the fallback keeps the message honest if a
// host-owned registration is ever added.
export function ownerLabel(ownerId: string): string {
    return ownerId.length > 0 ? `plugin "${ownerId}"` : 'the dashboard';
}
