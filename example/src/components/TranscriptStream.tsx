// Transcript stream: the station log for the active session.
//
// The panel is a pure read of two states joined in the view (log + active id,
// through useDashboardPair) plus its own view states (which tool traces are
// expanded, how many responses were sealed, whether the view follows output).
// Nothing here writes the transcript itself — that is the source plugin's job —
// which is why the streaming/cancelled text shows up without this component
// knowing anything about timers.
import { useEffect, useRef } from 'react';
import {
    SESSIONS_ACTIVE_STATE,
    SOURCE_TRANSCRIPT_STATE,
    TRANSCRIPT_AUTOSCROLL_COMMAND,
    TRANSCRIPT_AUTOSCROLL_STATE,
    TRANSCRIPT_EXPANDED_STATE,
    TRANSCRIPT_MARKS_STATE,
    TRANSCRIPT_TOGGLE_COMMAND,
    type TranscriptLog,
    type TranscriptMessage
} from '../app/contract';
import { useDashboardPair, useDashboardValue } from '../app/state-hooks';
import { useWorkbench } from '../app/workbench';

// Stable empty list: useDashboardPair caches on reference equality, and a fresh
// [] on every read would defeat that (React would re-render forever).
const NO_MESSAGES: readonly TranscriptMessage[] = [];

const ROLE_LABELS: Record<TranscriptMessage['role'], string> = {
    user: 'Operator',
    assistant: 'Station',
    tool: 'Instrument'
};

/** Deterministic body of the collapsible tool trace. */
const traceDetail = (message: TranscriptMessage): string =>
    `Simulated trace ${message.id} · session ${message.sessionId} · t+${message.at}ms · ${message.text}`;

export function TranscriptStream() {
    const instance = useWorkbench();
    const messages = useDashboardPair<TranscriptLog, string, readonly TranscriptMessage[]>(
        SOURCE_TRANSCRIPT_STATE,
        SESSIONS_ACTIVE_STATE,
        (log, sessionId) => log[sessionId] ?? NO_MESSAGES
    );
    const sessionId = useDashboardValue<string>(SESSIONS_ACTIVE_STATE);
    const expanded = useDashboardValue<Record<string, boolean>>(TRANSCRIPT_EXPANDED_STATE);
    const marks = useDashboardValue<Record<string, number>>(TRANSCRIPT_MARKS_STATE);
    const autoscroll = useDashboardValue<boolean>(TRANSCRIPT_AUTOSCROLL_STATE);

    const listRef = useRef<HTMLOListElement | null>(null);

    // Follow the output while it streams, but only when the operator asked for
    // it; the toggle is here so reading history while a job runs stays possible.
    useEffect(() => {
        const list = listRef.current;
        if (autoscroll && list !== null) {
            list.scrollTop = list.scrollHeight;
        }
    }, [messages, autoscroll]);

    return (
        <div className="stream">
            <p className="stream__meta">
                <span>{`${messages.length} entries`}</span>
                <span>{`sealed ${marks[sessionId] ?? 0}`}</span>
                <button
                    type="button"
                    className="btn btn--ghost"
                    aria-pressed={autoscroll}
                    onClick={() => instance.execute<boolean, boolean>(TRANSCRIPT_AUTOSCROLL_COMMAND, !autoscroll)}
                >
                    Follow output
                </button>
            </p>
            <ol
                className="stream__list"
                ref={listRef}
                aria-label={`Transcript for session ${sessionId}`}
                // Persistent live region: `role="log"` + aria-live are declared at
                // mount, before any streamed text appears, and stay put for the
                // whole life of the panel. Toggling aria-live when a run starts
                // made the browser treat the whole list as newly-live and
                // re-announce existing entries (review: duplicate announcements).
                // aria-atomic="false" announces only the changed lines.
                role="log"
                aria-live="polite"
                aria-atomic="false"
                aria-relevant="additions text"
            >
                {messages.length === 0 ? (
                    <li className="stream__empty">No traffic yet. Send a request from the composer.</li>
                ) : (
                    messages.map((message) => {
                        const isTrace = message.role === 'tool';
                        const isOpen = expanded[message.id] === true;
                        return (
                            <li
                                key={message.id}
                                className={`msg msg--${message.role}`}
                                data-phase={message.phase}
                            >
                                <span className="msg__role">{ROLE_LABELS[message.role]}</span>
                                <p className="msg__text">{message.text}</p>
                                <span className="msg__stamp">{`t+${message.at}ms`}</span>
                                {isTrace ? (
                                    <div className="msg__trace">
                                        <button
                                            type="button"
                                            className="btn btn--ghost"
                                            aria-expanded={isOpen}
                                            aria-controls={`trace-${message.id}`}
                                            onClick={() =>
                                                instance.execute<string, boolean>(TRANSCRIPT_TOGGLE_COMMAND, message.id)
                                            }
                                        >
                                            Trace details
                                        </button>
                                        <p id={`trace-${message.id}`} className="msg__detail" hidden={!isOpen}>
                                            {traceDetail(message)}
                                        </p>
                                    </div>
                                ) : null}
                            </li>
                        );
                    })
                )}
            </ol>
        </div>
    );
}
