// Event bus: open, named, payload-opaque channels.
//
// Events are never declared. Emitting into a channel with no subscribers is a
// no-op, and the payload is passed by reference (the emitter owns it; the
// framework does not clone or freeze it, so emit payloads are expected to be
// treated as read-only by listeners).
//
// Cross-references:
//   - ./listeners.ts — delivery order + throwing-listener isolation
//   - ./dashboard.ts — every channel is dropped by dispose(), which is what makes
//     "listeners are plugin-owned and disposed" true for api.on AND dashboard.on

import { ListenerSet } from './listeners';
import { requireHandler, requireIdentifier } from './validate';

export class EventBus {
    private readonly channels = new Map<string, ListenerSet>();

    // Returns the listener's unsubscribe handle.
    subscribe(event: string, handler: (payload: unknown) => void): () => void {
        const name = requireIdentifier('Event name', event);
        requireHandler('Event handler', handler);

        let channel = this.channels.get(name);
        if (channel === undefined) {
            channel = new ListenerSet();
            this.channels.set(name, channel);
        }
        return channel.subscribe(handler);
    }

    emit(event: string, payload: unknown): void {
        const name = requireIdentifier('Event name', event);
        const channel = this.channels.get(name);
        if (channel === undefined) return;
        channel.emit(payload, `event "${name}"`);
    }

    // Drops every subscription on every channel. Outstanding unsubscribe
    // handles stay harmless (./listeners.ts flags its entries inactive).
    clear(): void {
        this.channels.forEach((channel) => channel.clear());
        this.channels.clear();
    }
}
