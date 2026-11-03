// Transcript view-state contract, including the two event subscriptions.
//
// The interesting assertions are the cross-capability ones: the transcript
// collapses its traces when the rail announces a selection, and it counts sealed
// responses when the transport announces completion — with no import between the
// two plugins and no polling.
import { describe, expect, it } from 'vitest';
import {
    COMPOSER_SEND_COMMAND,
    SESSIONS_SELECT_COMMAND,
    SOURCE_CANCEL_COMMAND,
    SOURCE_SEND_COMMAND,
    SOURCE_TRANSCRIPT_STATE,
    TRANSCRIPT_AUTOSCROLL_COMMAND,
    TRANSCRIPT_AUTOSCROLL_STATE,
    TRANSCRIPT_EXPANDED_STATE,
    TRANSCRIPT_MARKS_STATE,
    TRANSCRIPT_TOGGLE_COMMAND,
    type TranscriptLog
} from '../app/contract';
import { createTestWorkbench } from '../testing/workbench';

const expandAll = (instance: ReturnType<typeof createTestWorkbench>['instance'], ids: readonly string[]) => {
    for (const id of ids) {
        instance.execute<string, boolean>(TRANSCRIPT_TOGGLE_COMMAND, id);
    }
};

describe('transcript view state', () => {
    it('toggles a trace open and closed', () => {
        const { instance } = createTestWorkbench();

        // msg-3 is the instrument trace entry the transport appends on send.
        instance.execute<{ sessionId: string; text: string }, string>(SOURCE_SEND_COMMAND, {
            sessionId: 'session-ops',
            text: 'Ping'
        });

        expect(instance.execute<string, boolean>(TRANSCRIPT_TOGGLE_COMMAND, 'msg-3')).toBe(true);
        expect(instance.state<Record<string, boolean>>(TRANSCRIPT_EXPANDED_STATE).get()).toEqual({
            'msg-3': true
        });

        expect(instance.execute<string, boolean>(TRANSCRIPT_TOGGLE_COMMAND, 'msg-3')).toBe(false);
        expect(instance.state<Record<string, boolean>>(TRANSCRIPT_EXPANDED_STATE).get()).toEqual({
            'msg-3': false
        });
    });

    it('follows output by default and can be turned off', () => {
        const { instance } = createTestWorkbench();

        expect(instance.state<boolean>(TRANSCRIPT_AUTOSCROLL_STATE).get()).toBe(true);
        expect(instance.execute<boolean, boolean>(TRANSCRIPT_AUTOSCROLL_COMMAND, false)).toBe(false);
        expect(instance.state<boolean>(TRANSCRIPT_AUTOSCROLL_STATE).get()).toBe(false);
    });

    it('counts sealed responses per session and ignores cancelled ones', () => {
        const { instance, clock } = createTestWorkbench();

        // Completed (chunk ticks exhausted) in session-ops...
        instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-ops');
        clock.advance(500);
        expect(instance.state<Record<string, number>>(TRANSCRIPT_MARKS_STATE).get()).toEqual({
            'session-ops': 1
        });

        instance.execute<{ sessionId: string; text: string }, string>(SOURCE_SEND_COMMAND, {
            sessionId: 'session-array',
            text: 'Relay sweep'
        });
        clock.advance(500);
        expect(instance.state<Record<string, number>>(TRANSCRIPT_MARKS_STATE).get()).toEqual({
            'session-ops': 1,
            'session-array': 1
        });

        // Cancelled in a third session: no seal.
        const requestId = instance.execute<{ sessionId: string; text: string }, string>(SOURCE_SEND_COMMAND, {
            sessionId: 'session-new-1',
            text: 'Abort test'
        });
        clock.advance(10);
        instance.execute<string, boolean>(SOURCE_CANCEL_COMMAND, requestId);
        clock.advance(500);

        expect(instance.state<Record<string, number>>(TRANSCRIPT_MARKS_STATE).get()).toEqual({
            'session-ops': 1,
            'session-array': 1
        });
        // The aborted session still keeps its half-finished turns.
        expect(
            (instance.state<TranscriptLog>(SOURCE_TRANSCRIPT_STATE).get()['session-new-1'] ?? []).map(
                (message) => message.phase
            )
        ).toEqual(['complete', 'cancelled', 'complete']);
    });

    it('collapses traces when the rail announces a selection', () => {
        const { instance, clock } = createTestWorkbench();

        instance.execute<{ sessionId: string; text: string }, string>(SOURCE_SEND_COMMAND, {
            sessionId: 'session-ops',
            text: 'Ping'
        });
        expandAll(instance, ['msg-3']);
        expect(instance.state<Record<string, boolean>>(TRANSCRIPT_EXPANDED_STATE).get()).toEqual({
            'msg-3': true
        });

        // Re-selecting the SAME session is enough: the event, not the change,
        // drives the reset.
        instance.execute<string>(SESSIONS_SELECT_COMMAND, 'session-ops');
        expect(instance.state<Record<string, boolean>>(TRANSCRIPT_EXPANDED_STATE).get()).toEqual({});

        // Seals survive the reset (they are per-session history, not view noise).
        clock.advance(500);
        expect(instance.state<Record<string, number>>(TRANSCRIPT_MARKS_STATE).get()).toEqual({
            'session-ops': 1
        });
    });
});
