// Composer contract: per-session drafts and the send/cancel bridge.
//
// The composer is where three capabilities meet (rail + transport + view), so
// these assertions are mostly about the seams: the draft must follow the session
// that is on screen, sending must go through the transport's own engine, and
// cancelling must never touch another job's stream.
import { describe, expect, it } from 'vitest';
import {
    COMPOSER_CANCEL_COMMAND,
    COMPOSER_DRAFTS_STATE,
    COMPOSER_SEND_COMMAND,
    COMPOSER_SENT_EVENT,
    COMPOSER_UPDATE_COMMAND,
    SESSIONS_SELECT_COMMAND,
    SOURCE_STATUS_STATE,
    SOURCE_TRANSCRIPT_STATE,
    type SourceStatusMap,
    type TranscriptLog
} from '../app/contract';
import { SEED_DRAFT_TEXT } from '../data/fixtures';
import { createTestWorkbench, expectedReply } from '../testing/workbench';

const logFor = (instance: ReturnType<typeof createTestWorkbench>['instance'], sessionId: string) =>
    instance.state<TranscriptLog>(SOURCE_TRANSCRIPT_STATE).get()[sessionId] ?? [];

describe('composer capability', () => {
    it('opens with one seeded draft and none for the other job', () => {
        const { instance } = createTestWorkbench();

        expect(instance.state<Record<string, string>>(COMPOSER_DRAFTS_STATE).get()).toEqual({
            'session-ops': SEED_DRAFT_TEXT
        });
    });

    it('keeps a draft per session across a switch', () => {
        const { instance } = createTestWorkbench();

        instance.execute(COMPOSER_UPDATE_COMMAND, { sessionId: 'session-array', text: 'Relay audit' });
        instance.execute<string>(SESSIONS_SELECT_COMMAND, 'session-array');

        expect(instance.state<Record<string, string>>(COMPOSER_DRAFTS_STATE).get()).toEqual({
            'session-ops': SEED_DRAFT_TEXT,
            'session-array': 'Relay audit'
        });

        instance.execute(COMPOSER_UPDATE_COMMAND, { sessionId: 'session-array', text: '' });
        expect(instance.state<Record<string, string>>(COMPOSER_DRAFTS_STATE).get()['session-array']).toBe('');
    });

    it('sends the active session by default, then clears only that draft', () => {
        const { instance } = createTestWorkbench();

        const sent: { requestId: string; sessionId: string }[] = [];
        instance.on<{ requestId: string; sessionId: string }>(COMPOSER_SENT_EVENT, (payload) => {
            sent.push({ requestId: payload.requestId, sessionId: payload.sessionId });
        });

        expect(instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, undefined)).toBe('req-1');

        expect(instance.state<Record<string, string>>(COMPOSER_DRAFTS_STATE).get()).toEqual({
            'session-ops': ''
        });
        expect(sent).toEqual([{ requestId: 'req-1', sessionId: 'session-ops' }]);
        expect(logFor(instance, 'session-ops')[0].text).toBe(SEED_DRAFT_TEXT);
        expect(instance.state<SourceStatusMap>(SOURCE_STATUS_STATE).get()).toEqual({
            'session-ops': { phase: 'running', requestId: 'req-1' }
        });
    });

    it('refuses an empty draft and leaves the store untouched', () => {
        const { instance } = createTestWorkbench();

        expect(() => instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-array')).toThrow(
            'Composer is empty'
        );
        expect(instance.state<TranscriptLog>(SOURCE_TRANSCRIPT_STATE).get()).toEqual({});
    });

    it('cancels only the running request of the requested session', () => {
        const { instance, clock } = createTestWorkbench();

        // Nothing in flight at all.
        expect(instance.execute<string | undefined, boolean>(COMPOSER_CANCEL_COMMAND, 'session-ops')).toBe(false);

        instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-ops');
        clock.advance(10);

        // A different job's cancel must not disturb this stream — and its own
        // status stays idle, which is what keeps the other deck's Cancel disabled.
        expect(instance.execute<string | undefined, boolean>(COMPOSER_CANCEL_COMMAND, 'session-array')).toBe(false);
        // Only sessions that actually ran an request appear in the map; a
        // session that never sent reads as idle (asserted in source.test.ts).
        expect(instance.state<SourceStatusMap>(SOURCE_STATUS_STATE).get()).toEqual({
            'session-ops': { phase: 'running', requestId: 'req-1' }
        });

        expect(instance.execute<string | undefined, boolean>(COMPOSER_CANCEL_COMMAND, 'session-ops')).toBe(true);
        expect(instance.state<SourceStatusMap>(SOURCE_STATUS_STATE).get()['session-ops']).toEqual({
            phase: 'cancelled',
            requestId: 'req-1'
        });
        expect(logFor(instance, 'session-ops')[1].phase).toBe('cancelled');

        clock.advance(500);
        expect(logFor(instance, 'session-ops')[1].text).toBe(
            // chunkWords 3, one chunk delivered before the stop.
            'Log slice is (stopped)'
        );
        expect(logFor(instance, 'session-ops')[1].text).not.toBe(expectedReply(SEED_DRAFT_TEXT, ['read', 'pulse']));
    });

    it('runs two sessions concurrently and cancels only the chosen one', () => {
        const { instance, clock } = createTestWorkbench();

        // session-ops streams its seeded draft; session-array gets its own draft.
        instance.execute(COMPOSER_UPDATE_COMMAND, { sessionId: 'session-array', text: 'Relay sweep' });
        expect(instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-ops')).toBe('req-1');
        expect(instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-array')).toBe('req-2');
        clock.advance(10);

        expect(instance.state<SourceStatusMap>(SOURCE_STATUS_STATE).get()).toEqual({
            'session-ops': { phase: 'running', requestId: 'req-1' },
            'session-array': { phase: 'running', requestId: 'req-2' }
        });

        // Cancelling one job leaves the other armed and running.
        expect(instance.execute<string | undefined, boolean>(COMPOSER_CANCEL_COMMAND, 'session-array')).toBe(true);
        expect(instance.state<SourceStatusMap>(SOURCE_STATUS_STATE).get()).toEqual({
            'session-ops': { phase: 'running', requestId: 'req-1' },
            'session-array': { phase: 'cancelled', requestId: 'req-2' }
        });

        // Both partial texts are exactly what each session had streamed so far.
        expect(logFor(instance, 'session-ops')[1].phase).toBe('running');
        expect(logFor(instance, 'session-ops')[1].text).toBe('Log slice is');
        expect(logFor(instance, 'session-array')[1].phase).toBe('cancelled');
        // Second request -> the second fixture line, so its own partial text.
        expect(logFor(instance, 'session-array')[1].text).toBe('Telemetry frame decoded (stopped)');

        // A third send into a session that is still running is refused by the
        // transport, and the refusal happens before the draft is cleared (a
        // retyped message is never swallowed by a rejected send).
        instance.execute(COMPOSER_UPDATE_COMMAND, { sessionId: 'session-ops', text: 'Second try' });
        expect(() => instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-ops')).toThrow(
            'source.send: session session-ops already has req-1 running'
        );
        expect(instance.state<Record<string, string>>(COMPOSER_DRAFTS_STATE).get()['session-ops']).toBe('Second try');
        expect(instance.execute<string | undefined, boolean>(COMPOSER_CANCEL_COMMAND, 'session-ops')).toBe(true);
        // Once the session is free again the same draft goes through.
        expect(instance.execute<string | undefined, string>(COMPOSER_SEND_COMMAND, 'session-ops')).toBe('req-3');
        expect(instance.state<Record<string, string>>(COMPOSER_DRAFTS_STATE).get()['session-ops']).toBe('');
    });
});
