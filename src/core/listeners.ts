// One notification channel: an ordered, unsubscribable listener list.
//
// Shared by state cells (../extensions/state.ts) and event channels
// (../extensions/bus.ts) so both guarantee the same delivery semantics:
//   - listeners run synchronously in subscription order
//   - a snapshot is taken first, so subscribing during a notification does not
//     run the new listener within that same pass
//   - unsubscribing during a notification takes effect immediately (the entry
//     is flagged inactive and is skipped if it is still in the snapshot)
//   - a throwing listener never blocks the listeners after it; every listener
//     runs, then the failures are re-thrown together as one 'listener-failed'
//     DashboardError (cause = first failure, errors = all failures)
//   - unsubscribe handles are idempotent and stay harmless after clear()
//
// Cross-references: ./errors.ts ('listener-failed').

import { fail } from './errors';

export type Listener = (payload: unknown) => void;

// Entries are objects (not the functions themselves) so identity survives
// duplicate subscriptions of the same function and stays cheap to remove.
type ListenerEntry = {
    handler: Listener;
    active: boolean;
};

export class ListenerSet {
    private entries: ListenerEntry[] = [];

    // Returns an idempotent unsubscribe bound to this exact entry.
    subscribe(handler: Listener): () => void {
        const entry: ListenerEntry = { handler, active: true };
        this.entries.push(entry);
        return () => {
            if (!entry.active) return; // already removed, or removed by clear()
            entry.active = false;
            const position = this.entries.indexOf(entry);
            if (position !== -1) this.entries.splice(position, 1);
        };
    }

    // Runs every active listener with `payload`; `label` only names the channel
    // inside the aggregated error message (e.g. `event "session.open"`).
    emit(payload: unknown, label: string): void {
        if (this.entries.length === 0) return;

        const failures: unknown[] = [];
        const snapshot = this.entries.slice();
        let index = 0;
        while (index < snapshot.length) {
            const entry = snapshot[index];
            if (entry.active) {
                try {
                    entry.handler(payload);
                } catch (error) {
                    failures.push(error);
                }
            }
            index += 1;
        }

        if (failures.length > 0) {
            fail('listener-failed', `A listener attached to ${label} threw while being notified; ` +
                `${failures.length} of ${snapshot.length} listener(s) failed and delivery to the rest still completed.`,
            { cause: failures[0], errors: failures });
        }
    }

    // Drops every listener (used by dispose()); outstanding unsubscribe handles
    // keep working and simply do nothing.
    clear(): void {
        let index = 0;
        while (index < this.entries.length) {
            this.entries[index].active = false;
            index += 1;
        }
        this.entries = [];
    }

    get size(): number {
        return this.entries.length;
    }
}
