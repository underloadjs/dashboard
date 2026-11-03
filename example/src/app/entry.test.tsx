// Mount/teardown contract for the example entry (app/entry.tsx).
//
// Two things are pinned here, both of them things a browser shows you only once
// per hot reload:
//
//   1. cleanup() releases the transport's pending chunk timers — no stream keeps
//      running against a dashboard nobody can see;
//   2. cleanup() is idempotent, and the React tree is gone before the core is
//      disposed (unmount first, dispose second), so nothing notifies an
//      unmounted subscriber and nothing re-runs the disposers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { mountStation, type StationHandle } from './entry';
import {
    COMPOSER_SEND_COMMAND,
    COMPOSER_UPDATE_COMMAND,
    SESSIONS_CREATE_COMMAND,
    SOURCE_STATUS_STATE,
    type SourceStatusMap
} from './contract';
import { createManualClock } from '../support/clock';

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    container.id = 'root';
    document.body.append(container);
});

afterEach(() => {
    cleanup();
    container.remove();
});

// createRoot().render() is concurrent: the tree is committed inside act(), not
// synchronously at the call site, so mounting outside act() would leave the
// container empty and make every DOM assertion below meaningless.
const openEntry = (options: { clock?: ReturnType<typeof createManualClock> } = {}) => {
    const clock = options.clock ?? createManualClock(0);
    let handle!: StationHandle;
    act(() => {
        handle = mountStation(container, { clock, sourceChunkDelayMs: 10, sourceChunkWords: 3 });
    });
    return { clock, handle };
};

describe('example entry lifecycle', () => {
    it('mounts the station into the given element', () => {
        const { handle } = openEntry();

        expect(container.querySelector('.station')).not.toBeNull();
        expect(container.querySelectorAll('[data-panel]').length).toBe(6);
        expect([...handle.instance.plugins].length).toBe(8);

        act(() => {
            handle.cleanup();
        });
    });

    it('releases every pending stream timer on cleanup and stays idempotent', () => {
        const { clock, handle } = openEntry();

        // Two overlapping jobs, one in each of two sessions. Wrapped in act():
        // each command notifies the mounted tree.
        act(() => {
            handle.instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-ops');
            handle.instance.execute<string | undefined, string>(SESSIONS_CREATE_COMMAND, 'Overlap');
            handle.instance.execute(COMPOSER_UPDATE_COMMAND, { sessionId: 'session-new-1', text: 'Relay sweep' });
            handle.instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-new-1');
        });

        // Two live streams = two scheduled chunks.
        expect(clock.pending()).toBe(2);
        expect(handle.instance.state<SourceStatusMap>(SOURCE_STATUS_STATE).get()).toEqual({
            'session-ops': { phase: 'running', requestId: 'req-1' },
            'session-new-1': { phase: 'running', requestId: 'req-2' }
        });

        act(() => {
            handle.cleanup();
        });

        // Core disposal ran the transport disposer: nothing is left scheduled.
        expect(clock.pending()).toBe(0);
        // And React unmounted first: the DOM it owned is empty, so a stray timer
        // could not have notified a detached tree.
        expect(container.querySelector('.station')).toBeNull();
        expect(container.childElementCount).toBe(0);

        // HMR + a manual teardown can both fire for the same handle.
        expect(() => handle.cleanup()).not.toThrow();
        expect(clock.pending()).toBe(0);
    });

    it('lets a fresh mount start clean after the previous one was torn down', () => {
        const first = openEntry();
        act(() => {
            first.handle.instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-ops');
        });
        act(() => {
            first.handle.cleanup();
        });
        expect(first.clock.pending()).toBe(0);

        const second = openEntry();
        act(() => {
            // A new dashboard, new ids, no leaked in-flight state from the old one.
            expect(
                second.handle.instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-ops')
            ).toBe('req-1');
        });
        expect(container.querySelectorAll('[data-panel]').length).toBe(6);

        act(() => {
            second.handle.cleanup();
        });
    });
});
