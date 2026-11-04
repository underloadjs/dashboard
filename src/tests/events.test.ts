// Event channel semantics (api.on / api.emit / dashboard.on / dashboard.emit).
//
// Contract pinned here (see ../extensions/bus.ts and ../core/listeners.ts):
//   - events are an open, undeclared set: emitting into a channel nobody
//     listens to is a no-op, and unknown names never fail
//   - delivery is synchronous, in subscription order, payload passed by
//     reference (the framework does not clone or freeze it)
//   - a throwing listener does not stop the others: everything is delivered,
//     then one aggregated 'listener-failed' error carries every failure
//   - subscriptions (plugin-owned via api.on and host-owned via dashboard.on)
//     are dropped together when the dashboard is disposed, but a plugin cleanup
//     may still emit while teardown runs
//   - unsubscribe handles are idempotent and remain harmless after dispose()
//
// Cross-references: ./events.test.ts helpers mirror ./state.test.ts because both
// share ../core/listeners.ts; ./lifecycle.test.ts pins the disposal ordering.

import { describe, expect, it } from 'vitest';

import { DashboardError, dashboard } from '../dashboard';
import type { DashboardPlugin, DashboardPluginAPI } from '../types';

function failureOf(operation: () => unknown): DashboardError {
    try {
        operation();
    } catch (error) {
        if (error instanceof DashboardError) return error;
        throw new Error(`Expected a DashboardError, received ${String(error)}`);
    }
    throw new Error('Expected the call to throw, but it completed normally.');
}

describe('event delivery', () => {
    it('delivers one payload to every subscriber in subscription order, by reference', () => {
        const instance = dashboard();
        const seen: Array<{ listener: string; payload: unknown }> = [];
        const payload = { sessionId: 's-1', lines: 3 };

        instance.on<{ sessionId: string; lines: number }>('session.open', (value) => {
            seen.push({ listener: 'one', payload: value });
        });
        instance.on<{ sessionId: string; lines: number }>('session.open', (value) => {
            seen.push({ listener: 'two', payload: value });
        });
        instance.on<{ sessionId: string; lines: number }>('session.close', () => {
            seen.push({ listener: 'other-channel', payload: null });
        });

        expect(instance.emit('session.open', payload)).toBeUndefined();

        expect(seen).toEqual([
            { listener: 'one', payload: { sessionId: 's-1', lines: 3 } },
            { listener: 'two', payload: { sessionId: 's-1', lines: 3 } },
        ]);
        // No structural clone: listeners see the emitter's own object.
        expect(seen[0].payload).toBe(payload);
        expect(seen[1].payload).toBe(payload);
    });

    it('treats an emit with no subscribers, and an emit without a payload, as no-ops', () => {
        const instance = dashboard();
        expect(instance.emit('nobody.listening')).toBeUndefined();
        expect(instance.emit('nobody.listening', 42)).toBeUndefined();

        const seen: unknown[] = [];
        instance.on('void.event', (value) => { seen.push(value); });
        instance.emit('void.event');
        expect(seen).toEqual([undefined]);
    });

    it('stops delivery after unsubscribe and tolerates replay', () => {
        const instance = dashboard();
        const log: string[] = [];

        const unsubscribe = instance.on<string>('tick', (value) => { log.push(`tick:${value}`); });
        instance.emit('tick', 'a');
        unsubscribe();
        expect(unsubscribe()).toBeUndefined();
        instance.emit('tick', 'b');

        expect(log).toEqual(['tick:a']);
    });

    it('re-enters safely so a listener can emit on the same channel', () => {
        const instance = dashboard();
        const log: string[] = [];

        instance.on<number>('tick', (depth) => {
            log.push(`tick:${depth}`);
            if (depth > 0) instance.emit('tick', depth - 1);
        });

        instance.emit('tick', 2);
        expect(log).toEqual(['tick:2', 'tick:1', 'tick:0']);
    });

    it('delivers to every listener even when several throw, then aggregates the failures', () => {
        const instance = dashboard();
        const log: string[] = [];
        const first = new Error('first listener exploded');
        const second = new Error('second listener exploded');

        instance.on('boom', () => { log.push('one'); });
        instance.on('boom', () => { throw first; });
        instance.on('boom', () => { log.push('three'); });
        instance.on('boom', () => { throw second; });

        const error = failureOf(() => instance.emit('boom', null));
        expect(error.code).toBe('listener-failed');
        // Identity, not structural equality: the host must be able to reach the
        // exact failures the listeners raised.
        expect(error.cause).toBe(first);
        expect(error.errors.length).toBe(2);
        expect(error.errors[0]).toBe(first);
        expect(error.errors[1]).toBe(second);
        expect(log).toEqual(['one', 'three']);
    });
});

describe('event ownership and validation', () => {
    it('wires plugin subscriptions through api.on and lets them cross plugin boundaries', () => {
        const heard: string[] = [];

        const listenerPlugin: DashboardPlugin = {
            id: 'listener',
            setup: (api) => {
                api.on<string>('notice', (value) => { heard.push(`heard:${value}`); });
            },
        };
        const speakerPlugin: DashboardPlugin = {
            id: 'speaker',
            requires: ['listener'],
            setup: (api) => {
                // Subscriptions from other plugins are already live, so an emit
                // inside setup reaches them.
                api.emit('notice', 'from-setup');
            },
        };

        dashboard({ plugins: [listenerPlugin, speakerPlugin] });
        expect(heard).toEqual(['heard:from-setup']);
    });

    it('keeps plugin listeners alive through teardown and drops them with the dashboard', () => {
        const heard: string[] = [];

        const listenerPlugin: DashboardPlugin = {
            id: 'listener',
            setup: (api) => {
                api.on<string>('bye', (value) => { heard.push(`heard:${value}`); });
            },
        };
        const closerPlugin: DashboardPlugin = {
            id: 'closer',
            requires: ['listener'],
            // Dispose runs this cleanup first (reverse setup order), while the
            // channels still exist.
            setup: (api) => () => {
                api.emit('bye', 'from-cleanup');
            },
        };

        const instance = dashboard({ plugins: [listenerPlugin, closerPlugin] });
        const hostUnsubscribe = instance.on<string>('bye', (value) => { heard.push(`host:${value}`); });

        instance.dispose();

        expect(instance.disposed).toBe(true);
        // Plugin listener subscribed during setup, host listener after the build:
        // delivery follows that registration order.
        expect(heard).toEqual(['heard:from-cleanup', 'host:from-cleanup']);
        // The unsubscribes that outlive the dashboard are harmless no-ops.
        expect(hostUnsubscribe()).toBeUndefined();
        expect(hostUnsubscribe()).toBeUndefined();
        expect(failureOf(() => instance.emit('bye', 'late')).code).toBe('disposed');
    });

    it('lets a plugin subscribe at runtime, after its setup has returned', () => {
        let api!: DashboardPluginAPI;
        const capture: DashboardPlugin = {
            id: 'capture',
            setup: (received) => {
                api = received;
            },
        };
        const instance = dashboard({ plugins: [capture] });
        const log: string[] = [];

        // on/emit/execute/getService are runtime operations: unlike
        // state/service/command/slot they stay legal after setup (the host may
        // also use dashboard.on, which behaves identically).
        const unsubscribe = api.on<string>('late', (value) => { log.push(`late:${value}`); });
        instance.emit('late', 'now');
        unsubscribe();
        instance.emit('late', 'ignored');

        expect(log).toEqual(['late:now']);
    });

    it('rejects an empty event name and a non-function handler', () => {
        const instance = dashboard();
        expect(failureOf(() => instance.on('', () => undefined)).code).toBe('invalid-identifier');
        expect(failureOf(() => instance.emit('')).code).toBe('invalid-identifier');
        expect(failureOf(() => instance.on('named', 'shout' as never)).code).toBe('invalid-handler');
    });
});
