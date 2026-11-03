// Source plugin: the simulated transport (the example's only "backend").
//
// It owns the station log and the request lifecycle, and nothing else:
//
//   send()   appends the operator turn, a 'Station' turn that starts empty, and
//            (when instruments are live) one 'Instrument' trace entry, then
//            streams the composed reply word-by-word through a Clock.
//   cancel() drops the pending chunk timer and marks the partial turn
//            cancelled, so a half-finished response stays visible on screen.
//
// STATUS IS PER SESSION (`source.status` is a session id -> status map). Session
// switching is a feature, so two jobs may stream at once and each one's phase
// must stay addressable: with one global "last known" record, a completion in
// session A used to overwrite session B's running state, which disarmed B's
// Cancel button while B was still streaming (review D1). The coherent rule this
// model enforces is single-flight PER SESSION: a session already streaming
// rejects a second send, while other sessions are free to run alongside it.
//
// Everything the UI shows about "running" vs "completed" comes from that map
// plus the emitted events; the transcript and composer views never touch timers,
// which is exactly why the same code is testable with the manual clock in
// support/clock.ts (no waitFor, no flakiness).
//
// No network, no harness import, no eval, no innerHTML: the reply is built from
// fixture strings plus the operator's own text and rendered as React text.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    PLUGIN_IDS,
    SOURCE_API_SERVICE,
    SOURCE_CANCEL_COMMAND,
    SOURCE_CANCELLED_EVENT,
    SOURCE_CHIP,
    SOURCE_COMPLETED_EVENT,
    SOURCE_DELTA_EVENT,
    SOURCE_IDLE_STATUS,
    SOURCE_SEND_COMMAND,
    SOURCE_STARTED_EVENT,
    SOURCE_STATUS_STATE,
    SOURCE_TRANSCRIPT_STATE,
    STATUS_SLOT,
    TOOLS_API_SERVICE,
    type SourceApi,
    type SourceCancelledEvent,
    type SourceCompletedEvent,
    type SourceDeltaEvent,
    type SourceStartedEvent,
    type SourceStatus,
    type SourceStatusMap,
    type StatusValue,
    type TranscriptLog,
    type TranscriptMessage,
    type ToolsApi
} from '../app/contract';
import { SourceChip } from '../components/StatusStrip';
import { SIMULATED_REPLIES } from '../data/fixtures';
import { realClock, type Clock } from '../support/clock';

// Defaults chosen so the browser demo streams visibly (~3 words per 40 ms)
// while still being overridable by tests and by createWorkstation options.
export const DEFAULT_CHUNK_DELAY_MS = 40;
export const DEFAULT_CHUNK_WORDS = 3;

export type SourcePluginOptions = {
    clock?: Clock;
    chunkDelayMs?: number;
    chunkWords?: number;
};

// Stable empty list for `messages()` so repeated reads of an unseen session do
// not hand out a new array identity each call.
const NO_MESSAGES: readonly TranscriptMessage[] = [];

// One in-flight stream: the cancel handle plus what has to be rewritten when
// the operator stops it.
type Inflight = {
    stop: () => void;
    sessionId: string;
    messageId: string;
};

/**
 * Splits a reply into word chunks. Exported because the tests assert the exact
 * chunk sequence (and therefore the exact partial text at every tick) instead of
 * approximating the stream.
 */
export function splitChunks(text: string, wordsPerChunk: number): string[] {
    const size = Math.max(1, Math.trunc(wordsPerChunk));
    const words = text.split(' ');
    const chunks: string[] = [];
    for (let index = 0; index < words.length; index += size) {
        chunks.push(words.slice(index, index + size).join(' '));
    }
    return chunks;
}

export function createSourcePlugin(options: SourcePluginOptions = {}): DashboardPlugin {
    const clock = options.clock ?? realClock;
    const chunkDelayMs = options.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS;
    const chunkWords = options.chunkWords ?? DEFAULT_CHUNK_WORDS;

    return {
        id: PLUGIN_IDS.source,
        // The reply text names the live instruments, so the tools facade must
        // already be registered when this setup runs.
        requires: [PLUGIN_IDS.tools],
        setup(api) {
            const transcript = api.state<TranscriptLog>(SOURCE_TRANSCRIPT_STATE, {});
            // Session id -> that session's transport phase. Starts empty: an
            // unseen session reads as SOURCE_IDLE_STATUS rather than being
            // pre-seeded for every session in the rail.
            const status = api.state<SourceStatusMap>(SOURCE_STATUS_STATE, {});
            const tools = api.getService<ToolsApi>(TOOLS_API_SERVICE);

            // Per-instance counters: ids are deterministic (req-1, msg-1, ...)
            // which is what lets the tests assert exact ids.
            let requestSequence = 0;
            let messageSequence = 0;
            const inflight = new Map<string, Inflight>();

            const statusOf = (sessionId: string): SourceStatus => status.get()[sessionId] ?? SOURCE_IDLE_STATUS;

            const setStatus = (sessionId: string, next: SourceStatus): void => {
                status.set((previous) => ({ ...previous, [sessionId]: next }));
            };

            const nextMessageId = (): string => {
                messageSequence += 1;
                return `msg-${messageSequence}`;
            };

            const append = (message: TranscriptMessage): void => {
                transcript.set((previous) => ({
                    ...previous,
                    [message.sessionId]: [...(previous[message.sessionId] ?? []), message]
                }));
            };

            const rewrite = (
                messageId: string,
                sessionId: string,
                patch: (message: TranscriptMessage) => TranscriptMessage
            ): void => {
                transcript.set((previous) => {
                    const list = previous[sessionId] ?? [];
                    return {
                        ...previous,
                        [sessionId]: list.map((message) => (message.id === messageId ? patch(message) : message))
                    };
                });
            };

            // Deterministic reply: fixed opening line (round-robin by request
            // index) + the operator's prompt + the live instrument list.
            const composeReply = (requestIndex: number, prompt: string): string => {
                const line = SIMULATED_REPLIES[requestIndex % SIMULATED_REPLIES.length];
                const live = tools.enabled();
                const instruments = live.length > 0 ? live.join(', ') : 'no instruments';
                return `${line}: ${prompt} checked against ${instruments}.`;
            };

            const send: SourceApi['send'] = ({ sessionId, text }) => {
                const prompt = text.trim();
                if (prompt.length === 0) {
                    throw new Error('source.send needs a non-empty prompt');
                }

                // Single-flight per session (see the header): a session that is
                // already streaming rejects a second send, while a DIFFERENT
                // session may start its own stream alongside it.
                const previous = statusOf(sessionId);
                if (previous.phase === 'running') {
                    throw new Error(
                        `source.send: session ${sessionId} already has ${previous.requestId} running`
                    );
                }

                requestSequence += 1;
                const requestId = `req-${requestSequence}`;
                const at = clock.now();
                const reply = composeReply(requestSequence - 1, prompt);
                const live = tools.enabled();

                // Ids are allocated up front, in the order the entries appear on
                // screen (msg-1 = operator, msg-2 = station, msg-3 = trace), so a
                // test can assert the whole transcript by exact id.
                const userMessageId = nextMessageId();
                const assistantMessageId = nextMessageId();
                const traceMessageId = live.length > 0 ? nextMessageId() : undefined;

                append({ id: userMessageId, sessionId, role: 'user', phase: 'complete', text: prompt, at });
                // The assistant turn starts empty and grows: the streamed text
                // is real state, so a late subscriber (or a session switch and
                // back) sees exactly the same partial response.
                append({ id: assistantMessageId, sessionId, role: 'assistant', phase: 'running', text: '', at });
                if (traceMessageId !== undefined) {
                    append({
                        id: traceMessageId,
                        sessionId,
                        role: 'tool',
                        phase: 'complete',
                        text: `queued ${live.join(', ')}`,
                        at
                    });
                }

                // Only this session's slot moves; other sessions keep their own
                // phase, which is the whole point of the per-session map.
                setStatus(sessionId, { phase: 'running', requestId });

                const chunks = splitChunks(reply, chunkWords);
                const started: SourceStartedEvent = { requestId, sessionId, chunks: chunks.length };
                api.emit(SOURCE_STARTED_EVENT, started);

                const entry: Inflight = { stop: () => undefined, sessionId, messageId: assistantMessageId };
                inflight.set(requestId, entry);

                let delivered = 0;
                const scheduleChunk = (): void => {
                    // Each tick publishes one more chunk, then schedules the next.
                    // The cancel handle is stored on the entry so cancel() always
                    // stops the timer that is pending right now.
                    entry.stop = clock.schedule(() => {
                        delivered += 1;
                        const partial = chunks.slice(0, delivered).join(' ');
                        rewrite(assistantMessageId, sessionId, (message) => ({ ...message, text: partial }));
                        const delta: SourceDeltaEvent = {
                            requestId,
                            sessionId,
                            delivered,
                            chunks: chunks.length
                        };
                        api.emit(SOURCE_DELTA_EVENT, delta);

                        if (delivered >= chunks.length) {
                            rewrite(assistantMessageId, sessionId, (message) => ({
                                ...message,
                                phase: 'complete'
                            }));
                            inflight.delete(requestId);
                            setStatus(sessionId, { phase: 'completed', requestId });
                            const completed: SourceCompletedEvent = {
                                requestId,
                                sessionId,
                                text: partial
                            };
                            api.emit(SOURCE_COMPLETED_EVENT, completed);
                            return;
                        }
                        scheduleChunk();
                    }, chunkDelayMs);
                };
                scheduleChunk();

                return requestId;
            };

            const cancel: SourceApi['cancel'] = (requestId) => {
                const entry = inflight.get(requestId);
                if (entry === undefined) {
                    // Nothing pending: an already-sealed or unknown request.
                    return false;
                }

                entry.stop();
                inflight.delete(requestId);

                let sealed = '';
                rewrite(entry.messageId, entry.sessionId, (message) => {
                    sealed = `${message.text} (stopped)`;
                    return { ...message, phase: 'cancelled', text: sealed };
                });

                // The status map is keyed by session, so this writes exactly the
                // cancelled request's session - no "is this still the newest
                // request?" guard needed (that guard only existed because the old
                // single global record could not tell two sessions apart).
                setStatus(entry.sessionId, { phase: 'cancelled', requestId });

                const cancelled: SourceCancelledEvent = {
                    requestId,
                    sessionId: entry.sessionId,
                    text: sealed
                };
                api.emit(SOURCE_CANCELLED_EVENT, cancelled);
                return true;
            };

            api.service<SourceApi>(SOURCE_API_SERVICE, {
                send,
                cancel,
                messages: (sessionId) => transcript.get()[sessionId] ?? NO_MESSAGES,
                status: (sessionId) => statusOf(sessionId),
                // Map insertion order == request order, so concurrent jobs are
                // listed in the order they started.
                running: () => [...new Set([...inflight.values()].map((entry) => entry.sessionId))]
            });

            api.command<{ sessionId: string; text: string }, string>(SOURCE_SEND_COMMAND, (input) => send(input));
            api.command<string, boolean>(SOURCE_CANCEL_COMMAND, (requestId) => cancel(requestId));

            api.slot<StatusValue>(STATUS_SLOT, {
                id: SOURCE_CHIP,
                order: 30,
                value: { label: 'Transport', component: SourceChip }
            });

            // Returning a disposer drops every pending chunk timer when the
            // dashboard is disposed (hot reload, teardown in tests).
            return () => {
                for (const entry of inflight.values()) {
                    entry.stop();
                }
                inflight.clear();
            };
        }
    };
}
