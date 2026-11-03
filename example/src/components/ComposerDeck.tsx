// Composer deck: draft text plus the send/cancel controls.
//
// The draft lives in core state (per session), so switching sessions keeps each
// unfinished message — visible proof that cross-session state is real state,
// not component-local memory. Sending and cancelling go through commands, and
// Cancel is only enabled while this session has a request in flight, which is
// how the UI expresses the transport lifecycle.
import {
    COMPOSER_CANCEL_COMMAND,
    COMPOSER_DRAFTS_STATE,
    COMPOSER_SEND_COMMAND,
    COMPOSER_UPDATE_COMMAND,
    SESSIONS_ACTIVE_STATE,
    SOURCE_IDLE_STATUS,
    SOURCE_STATUS_STATE,
    type SourceStatusMap
} from '../app/contract';
import { useDashboardValue } from '../app/state-hooks';
import { useWorkbench } from '../app/workbench';

export function ComposerDeck() {
    const instance = useWorkbench();
    const sessionId = useDashboardValue<string>(SESSIONS_ACTIVE_STATE);
    const drafts = useDashboardValue<Record<string, string>>(COMPOSER_DRAFTS_STATE);
    const statuses = useDashboardValue<SourceStatusMap>(SOURCE_STATUS_STATE);

    const draft = drafts[sessionId] ?? '';
    // Per-session transport state: another job streaming in the background must
    // not disarm this session's Send, and must not arm its Cancel.
    const status = statuses[sessionId] ?? SOURCE_IDLE_STATUS;
    const runningHere = status.phase === 'running';
    const canSend = draft.trim().length > 0 && !runningHere;

    const send = () => {
        if (!canSend) return;
        instance.execute<string, string>(COMPOSER_SEND_COMMAND, sessionId);
    };

    return (
        <form
            className="composer"
            onSubmit={(event) => {
                // The page never navigates: the form is only a keyboard affordance.
                event.preventDefault();
                send();
            }}
        >
            <label className="composer__label" htmlFor="composer-input">
                Message the station
            </label>
            <div className="composer__row">
                <input
                    id="composer-input"
                    className="composer__input"
                    type="text"
                    autoComplete="off"
                    value={draft}
                    placeholder="Ask the station for a reading"
                    aria-describedby="composer-help"
                    onChange={(event) =>
                        instance.execute(COMPOSER_UPDATE_COMMAND, { sessionId, text: event.target.value })
                    }
                />
                <div className="composer__actions">
                    <button type="submit" className="btn btn--accent" disabled={!canSend}>
                        Send
                    </button>
                    <button
                        type="button"
                        className="btn btn--warn"
                        aria-label="Cancel running request"
                        disabled={!runningHere}
                        onClick={() => instance.execute<string, boolean>(COMPOSER_CANCEL_COMMAND, sessionId)}
                    >
                        Cancel
                    </button>
                </div>
            </div>
            <p className="composer__help" id="composer-help">
                {runningHere
                    ? `Streaming ${status.requestId} — Cancel drops the remaining chunks`
                    : 'Send runs composer.send against the fixture transport'}
            </p>
        </form>
    );
}
