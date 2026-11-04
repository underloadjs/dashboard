// Service, command and slot registries.
//
// Three different shapes of "publish something", one shared discipline: ids are
// global and unique per registry, duplicates are rejected at the registration
// site naming both plugins, and lookups of an unknown id fail loudly rather than
// returning undefined.
//
// Cross-references:
//   - ./state.ts       — the fourth registry (state cells), same discipline
//   - ../dashboard.ts  — lifecycle guards wrapped around every call below
//   - ../core/validate.ts — 'invalid-identifier' / 'invalid-handler' shared checks

import { describeValue, fail } from '../core/errors';
import { ownerLabel, requireIdentifier } from '../core/validate';
import type { DashboardContribution, DashboardContributionInput } from '../types';

export type ServiceOwner = { owner: string; value: unknown };

// Values are stored as-is (never cloned): a service is normally an object with
// identity that matters (a client, a store, an adapter).
export class ServiceRegistry {
    private readonly values = new Map<string, ServiceOwner>();

    register<T>(ownerId: string, id: string, value: T): void {
        const key = requireIdentifier('Service id', id);
        const existing = this.values.get(key);
        if (existing !== undefined) {
            fail('duplicate-service',
                `Service "${key}" is already provided by ${ownerLabel(existing.owner)}; ` +
                `${ownerLabel(ownerId)} cannot provide the same id twice.`);
        }
        this.values.set(key, { owner: ownerId, value });
    }

    get<T>(id: string): T {
        const key = requireIdentifier('Service id', id);
        const entry = this.values.get(key);
        if (entry === undefined) {
            fail('unknown-service',
                `No service is provided under "${key}". Declare it with api.service("${key}", value) in a plugin this plugin requires.`);
        }
        return entry.value as T;
    }

    clear(): void {
        this.values.clear();
    }
}

export type CommandHandler = (input: unknown) => unknown;

export type CommandOwner = { owner: string; handler: CommandHandler };

export class CommandRegistry {
    private readonly handlers = new Map<string, CommandOwner>();

    register(ownerId: string, id: string, handler: CommandHandler): void {
        const key = requireIdentifier('Command id', id);
        if (typeof handler !== 'function') {
            fail('invalid-handler', `Command "${key}" handler must be a function, received ${describeValue(handler)}.`);
        }
        const existing = this.handlers.get(key);
        if (existing !== undefined) {
            fail('duplicate-command',
                `Command "${key}" is already registered by ${ownerLabel(existing.owner)}; ` +
                `${ownerLabel(ownerId)} cannot register the same id twice.`);
        }
        this.handlers.set(key, { owner: ownerId, handler });
    }

    // Returned verbatim to the caller by dashboard.execute(); the registry never
    // wraps the result, which is what preserves a promise-returning handler.
    get(id: string): CommandHandler {
        const key = requireIdentifier('Command id', id);
        const entry = this.handlers.get(key);
        if (entry === undefined) {
            fail('unknown-command', `No command is registered under "${key}".`);
        }
        return entry.handler;
    }

    clear(): void {
        this.handlers.clear();
    }
}

// A contribution that survived validation: normalised order (always finite,
// default 0), frozen public record, and the registration sequence used to break
// order ties deterministically.
type SlotEntry = {
    sequence: number;
    owner: string;
    contribution: DashboardContribution<unknown>;
};

type SlotChannel = {
    // Insertion order is kept here; the sorted public view lives in `snapshot`.
    entries: SlotEntry[];
    ids: Map<string, string>; // contribution id -> owning plugin, for duplicate messages
    snapshot: readonly DashboardContribution<unknown>[] | null; // lazily built, invalidated on register
};

// Identity-stable empty result for unknown slots: unknown slot names are legal
// (slots are open), and returning one shared frozen array avoids allocating per
// read in render loops.
const EMPTY_SLOT: readonly DashboardContribution<never>[] = Object.freeze([] as DashboardContribution<never>[]);

export class SlotRegistry {
    private readonly channels = new Map<string, SlotChannel>();

    register(ownerId: string, slotName: string, contribution: DashboardContributionInput<unknown>): void {
        const name = requireIdentifier('Slot name', slotName);

        if (contribution === null || typeof contribution !== 'object') {
            fail('invalid-contribution',
                `Contribution to slot "${name}" must be an object with an id and a value, received ${describeValue(contribution)}.`);
        }

        const id = contribution.id;
        if (typeof id !== 'string' || id.length === 0) {
            fail('invalid-contribution',
                `Contribution to slot "${name}" must have a non-empty string id, received ${describeValue(id)}.`);
        }

        // `order` is optional; when present it must be a finite number, because
        // NaN/Infinity would make the sort (and therefore the UI order) unstable.
        let order = 0;
        if (contribution.order !== undefined) {
            if (typeof contribution.order !== 'number' || contribution.order !== contribution.order ||
                contribution.order === Number.POSITIVE_INFINITY || contribution.order === Number.NEGATIVE_INFINITY) {
                fail('invalid-contribution',
                    `Contribution "${id}" in slot "${name}" must have a finite numeric order, received ${describeValue(contribution.order)}.`);
            }
            order = contribution.order;
        }

        let channel = this.channels.get(name);
        if (channel === undefined) {
            channel = { entries: [], ids: new Map<string, string>(), snapshot: null };
            this.channels.set(name, channel);
        }

        const existingOwner = channel.ids.get(id);
        if (existingOwner !== undefined) {
            fail('duplicate-contribution',
                `Slot "${name}" already has a contribution "${id}" from ${ownerLabel(existingOwner)}; ` +
                `${ownerLabel(ownerId)} cannot reuse the same contribution id in one slot.`);
        }

        // Frozen so a host cannot reorder or rewrite the framework's records;
        // the contribution's own `value` stays untouched (opaque to us).
        const record: DashboardContribution<unknown> = Object.freeze({
            slot: name,
            id,
            order,
            value: contribution.value,
        });

        channel.entries.push({ sequence: channel.entries.length, owner: ownerId, contribution: record });
        channel.ids.set(id, ownerId);
        channel.snapshot = null; // invalidates the cached sort
    }

    // Sorted by order ascending, ties by registration order ascending. Stable
    // identity until the next contribution to this slot arrives.
    read<T>(slotName: string): readonly DashboardContribution<T>[] {
        const name = requireIdentifier('Slot name', slotName);
        const channel = this.channels.get(name);
        if (channel === undefined) return EMPTY_SLOT as readonly DashboardContribution<T>[];

        if (channel.snapshot === null) {
            const sorted = channel.entries.slice();
            sorted.sort((a, b) => {
                if (a.contribution.order !== b.contribution.order) return a.contribution.order - b.contribution.order;
                return a.sequence - b.sequence;
            });
            const views: DashboardContribution<unknown>[] = [];
            let index = 0;
            while (index < sorted.length) {
                views.push(sorted[index].contribution);
                index += 1;
            }
            channel.snapshot = Object.freeze(views);
        }

        return channel.snapshot as readonly DashboardContribution<T>[];
    }

    clear(): void {
        this.channels.clear();
    }
}
