// Transport contract: the simulated response stream, start to finish.
//
// The manual clock makes every assertion an exact value: the number of chunks,
// the partial text at each tick, the event sequence, the ids, and the state of
// the log after a cancel. This is the file that pins "running vs completed" down
// as observable behaviour rather than a vibe.
//
// The overlap group is the D1 regression: `source.status` is keyed by session, so
// two jobs streaming at once keep separate phases, the older one may finish while
// the newer one is still running, and cancelling one never relabels the other.
import { describe, expect, it } from 'vitest';
import {
    SOURCE_API_SERVICE,
    SOURCE_CANCEL_COMMAND,
    SOURCE_CANCELLED_EVENT,
    SOURCE_COMPLETED_EVENT,
    SOURCE_DELTA_EVENT,
    SOURCE_SEND_COMMAND,
    SOURCE_STARTED_EVENT,
    SOURCE_STATUS_STATE,
    SOURCE_TRANSCRIPT_STATE,
    TOOLS_TOGGLE_COMMAND,
    type SourceApi,
    type SourceStatusMap,
    type TranscriptLog,
    type TranscriptMessage
} from '../app/contract';
import { createTestWorkbench } from '../testing/workbench';
import { splitChunks } from './source';

const SESSION = 'session-ops';
const OTHER = 'session-array';
const PROMPT = 'Check the coolant log';
// composeReply(0, PROMPT) with the default live instruments ('read' + 'pulse').
const REPLY = 'Log slice is consistent: Check the coolant log checked against read, pulse.';
// splitChunks(REPLY, 3) — asserted explicitly so a wording change in the
// fixture cannot silently move a chunk boundary.
const CHUNKS = ['Log slice is', 'consistent: Check the', 'coolant log checked', 'against read, pulse.'];

// Short prompt -> 3 chunks (seals at t+30). Long prompt -> 7 chunks (t+70), so a
// single advance(30) leaves the older job sealed and the newer one mid-stream.
const SHORT_PROMPT = 'Ping';
const SHORT_REPLY = 'Log slice is consistent: Ping checked against read, pulse.';
const LONG_PROMPT = 'A much longer prompt that will take more chunks to finish';
const LONG_PARTIAL_3 = 'Telemetry frame decoded without gaps: A much longer prompt';

type Instance = ReturnType<typeof createTestWorkbench>['instance'];

const sendTo = (instance: Instance, sessionId: string, text: string): string =>
    instance.execute<{ sessionId: string; text: string }, string>(SOURCE_SEND_COMMAND, { sessionId, text });

const logFor = (instance: Instance, sessionId: string = SESSION): readonly TranscriptMessage[] =>
    instance.state<TranscriptLog>(SOURCE_TRANSCRIPT_STATE).get()[sessionId] ?? [];

const statuses = (instance: Instance): SourceStatusMap => instance.state<SourceStatusMap>(SOURCE_STATUS_STATE).get();

const turn = (instance: Instance, sessionId: string = SESSION): TranscriptMessage => logFor(instance, sessionId)[1];

describe('source plugin (simulated transport)', () => {
    it('splits a reply into the exact word chunks the UI will stream', () => {
        // splitChunks is exported from the plugin precisely so this can be
        // asserted rather than inferred from tick counting.
        expect(splitChunks(REPLY, 3)).toEqual(CHUNKS);
        expect(splitChunks('one', 3)).toEqual(['one']);
        expect(splitChunks('a b c d', 2)).toEqual(['a b', 'c d']);
    });

    it('appends the operator turn, an empty running turn, and an instrument trace', () => {
        const { instance } = createTestWorkbench();

        expect(sendTo(instance, SESSION, PROMPT)).toBe('req-1');

        expect([...logFor(instance)]).toEqual([
            { id: 'msg-1', sessionId: SESSION, role: 'user', phase: 'complete', text: PROMPT, at: 0 },
            { id: 'msg-2', sessionId: SESSION, role: 'assistant', phase: 'running', text: '', at: 0 },
            { id: 'msg-3', sessionId: SESSION, role: 'tool', phase: 'complete', text: 'queued read, pulse', at: 0 }
        ] satisfies TranscriptMessage[]);

        // Status is a session-keyed map: only the sending session appears.
        expect(statuses(instance)).toEqual({ [SESSION]: { phase: 'running', requestId: 'req-1' } });
        expect(instance.service<SourceApi>(SOURCE_API_SERVICE).status(OTHER)).toEqual({
            phase: 'idle',
            requestId: ''
        });
    });

    it('streams one chunk per tick and seals the turn on the last one', () => {
        const { instance, clock } = createTestWorkbench();

        const events: string[] = [];
        instance.on<{ chunks: number }>(SOURCE_STARTED_EVENT, (payload) => {
            events.push(`started/${payload.chunks}`);
        });
        instance.on<{ delivered: number; chunks: number }>(SOURCE_DELTA_EVENT, (payload) => {
            events.push(`delta/${payload.delivered}-${payload.chunks}`);
        });
        instance.on<{ text: string }>(SOURCE_COMPLETED_EVENT, (payload) => {
            events.push(`completed/${payload.text}`);
        });

        expect(sendTo(instance, SESSION, PROMPT)).toBe('req-1');

        clock.advance(10);
        expect(turn(instance).text).toBe(CHUNKS[0]);
        expect(turn(instance).phase).toBe('running');

        clock.advance(10);
        expect(turn(instance).text).toBe(`${CHUNKS[0]} ${CHUNKS[1]}`);

        clock.advance(20);
        expect(turn(instance).text).toBe(REPLY);
        expect(turn(instance).phase).toBe('complete');
        expect(clock.pending()).toBe(0);

        expect(statuses(instance)).toEqual({ [SESSION]: { phase: 'completed', requestId: 'req-1' } });
        expect(instance.service<SourceApi>(SOURCE_API_SERVICE).running()).toEqual([]);

        expect(events).toEqual([
            'started/4',
            'delta/1-4',
            'delta/2-4',
            'delta/3-4',
            'delta/4-4',
            `completed/${REPLY}`
        ]);
    });

    it('cancels mid-stream and keeps the partial response visible', () => {
        const { instance, clock } = createTestWorkbench();

        const events: string[] = [];
        instance.on<{ text: string }>(SOURCE_CANCELLED_EVENT, (payload) => {
            events.push(`cancelled/${payload.text}`);
        });

        const requestId = sendTo(instance, SESSION, PROMPT);
        clock.advance(10);
        expect(instance.execute<string, boolean>(SOURCE_CANCEL_COMMAND, requestId)).toBe(true);

        const assistantTurn = turn(instance);
        expect(assistantTurn.phase).toBe('cancelled');
        expect(assistantTurn.text).toBe(`${CHUNKS[0]} (stopped)`);
        expect(statuses(instance)).toEqual({ [SESSION]: { phase: 'cancelled', requestId: 'req-1' } });
        // The pending chunk really is gone: advancing further changes nothing.
        expect(clock.pending()).toBe(0);
        clock.advance(500);
        expect(turn(instance)).toEqual(assistantTurn);

        expect(events).toEqual([`cancelled/${CHUNKS[0]} (stopped)`]);

        // A second cancel has nothing to stop.
        expect(instance.execute<string, boolean>(SOURCE_CANCEL_COMMAND, requestId)).toBe(false);
        expect(instance.execute<string, boolean>(SOURCE_CANCEL_COMMAND, 'req-404')).toBe(false);
    });

    it('rotates the fixture line per request and follows the instrument selection', () => {
        const { instance, clock } = createTestWorkbench();

        sendTo(instance, SESSION, PROMPT);
        clock.advance(500);
        sendTo(instance, SESSION, 'Audit the relay array');
        clock.advance(500);

        const sealed = logFor(instance).filter((message) => message.role === 'assistant');
        expect(sealed.map((message) => message.text)).toEqual([
            REPLY,
            'Telemetry frame decoded without gaps: Audit the relay array checked against read, pulse.'
        ]);
        // Same session, sequential requests: one status entry, the latest phase.
        expect(statuses(instance)).toEqual({ [SESSION]: { phase: 'completed', requestId: 'req-2' } });
    });

    it('names no instruments and emits no trace when the rack is silent', () => {
        const { instance, clock } = createTestWorkbench();

        // Both defaults off: the reply text proves the tools state really is
        // consulted, and the missing trace entry proves the branch is observable.
        instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, 'read');
        instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, 'pulse');

        sendTo(instance, SESSION, PROMPT);
        clock.advance(500);

        expect(logFor(instance).map((message) => message.role)).toEqual(['user', 'assistant']);
        expect(turn(instance).text).toBe('Log slice is consistent: Check the coolant log checked against no instruments.');
    });

    it('refuses an empty prompt', () => {
        const { instance } = createTestWorkbench();

        expect(() => sendTo(instance, SESSION, '   ')).toThrow('source.send needs a non-empty prompt');
        expect(instance.state<TranscriptLog>(SOURCE_TRANSCRIPT_STATE).get()).toEqual({});
    });

    describe('overlapping sessions (D1 regression)', () => {
        it('keeps one phase per session while both stream', () => {
            const { instance, clock } = createTestWorkbench();

            sendTo(instance, SESSION, SHORT_PROMPT);
            sendTo(instance, OTHER, LONG_PROMPT);
            clock.advance(10);

            // Two live requests, two independent status entries.
            expect(statuses(instance)).toEqual({
                [SESSION]: { phase: 'running', requestId: 'req-1' },
                [OTHER]: { phase: 'running', requestId: 'req-2' }
            });
            expect(instance.service<SourceApi>(SOURCE_API_SERVICE).running()).toEqual([SESSION, OTHER]);
            // Each session only ever sees its own text.
            expect(turn(instance, SESSION).text).toBe('Log slice is');
            expect(turn(instance, OTHER).text).toBe('Telemetry frame decoded');
            // Neither stream leaked into the other's log.
            expect(logFor(instance, OTHER).map((message) => message.text)).toEqual([
                LONG_PROMPT,
                'Telemetry frame decoded',
                'queued read, pulse'
            ]);
        });

        it('seals the older job while the newer one is still running', () => {
            const { instance, clock } = createTestWorkbench();

            sendTo(instance, SESSION, SHORT_PROMPT); // 3 chunks -> t+30
            sendTo(instance, OTHER, LONG_PROMPT); //   7 chunks -> t+70
            clock.advance(30);

            // The completion of req-1 must NOT overwrite req-2's running state —
            // this is the exact bug the single global status record produced.
            expect(statuses(instance)).toEqual({
                [SESSION]: { phase: 'completed', requestId: 'req-1' },
                [OTHER]: { phase: 'running', requestId: 'req-2' }
            });
            expect(instance.service<SourceApi>(SOURCE_API_SERVICE).running()).toEqual([OTHER]);
            expect(turn(instance, SESSION)).toEqual({
                id: 'msg-2',
                sessionId: SESSION,
                role: 'assistant',
                phase: 'complete',
                text: SHORT_REPLY,
                at: 0
            } satisfies TranscriptMessage);
            expect(turn(instance, OTHER).text).toBe(LONG_PARTIAL_3);
            expect(turn(instance, OTHER).phase).toBe('running');

            clock.advance(40);
            expect(statuses(instance)).toEqual({
                [SESSION]: { phase: 'completed', requestId: 'req-1' },
                [OTHER]: { phase: 'completed', requestId: 'req-2' }
            });
            expect(clock.pending()).toBe(0);
        });

        it('cancels the chosen session without relabelling the other', () => {
            const { instance, clock } = createTestWorkbench();

            sendTo(instance, SESSION, SHORT_PROMPT);
            sendTo(instance, OTHER, LONG_PROMPT);
            clock.advance(10);

            expect(instance.execute<string, boolean>(SOURCE_CANCEL_COMMAND, 'req-1')).toBe(true);

            expect(statuses(instance)).toEqual({
                [SESSION]: { phase: 'cancelled', requestId: 'req-1' },
                [OTHER]: { phase: 'running', requestId: 'req-2' }
            });
            expect(instance.service<SourceApi>(SOURCE_API_SERVICE).running()).toEqual([OTHER]);
            // Switching back and forth shows each session's own partial text.
            expect(turn(instance, SESSION).text).toBe('Log slice is (stopped)');
            expect(turn(instance, OTHER).text).toBe('Telemetry frame decoded');

            // The survivor still runs to completion on its own schedule.
            clock.advance(60);
            expect(statuses(instance)[OTHER]).toEqual({ phase: 'completed', requestId: 'req-2' });
            expect(statuses(instance)[SESSION]).toEqual({ phase: 'cancelled', requestId: 'req-1' });
        });

        it('enforces single-flight per session, not globally', () => {
            const { instance, clock } = createTestWorkbench();

            sendTo(instance, SESSION, SHORT_PROMPT);

            expect(() => sendTo(instance, SESSION, 'Second try')).toThrow(
                'source.send: session session-ops already has req-1 running'
            );
            // The rejected send appended nothing: still the original three turns.
            expect(logFor(instance).map((message) => message.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
            expect(statuses(instance)).toEqual({ [SESSION]: { phase: 'running', requestId: 'req-1' } });

            // A different session is free to start alongside it.
            expect(sendTo(instance, OTHER, SHORT_PROMPT)).toBe('req-2');
            expect(clock.pending()).toBe(2);

            // And once the first one seals, the session may send again.
            clock.advance(500);
            expect(sendTo(instance, SESSION, 'Second try')).toBe('req-3');
        });
    });
});
