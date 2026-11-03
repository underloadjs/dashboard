// Sessions rail: the left region's only panel.
//
// Reads the session catalogue and the active id through the React bridge, and
// mutates through commands only (never by writing state directly) — the same
// rule every view follows, which is what keeps the core's "registrations during
// setup, mutation through commands" model observable in the UI.
import {
    SESSIONS_ACTIVE_STATE,
    SESSIONS_CREATE_COMMAND,
    SESSIONS_SELECT_COMMAND,
    SESSIONS_STATE,
    type SessionRecord
} from '../app/contract';
import { useDashboardValue } from '../app/state-hooks';
import { useWorkbench } from '../app/workbench';

export function SessionsBoard() {
    const instance = useWorkbench();
    const sessions = useDashboardValue<SessionRecord[]>(SESSIONS_STATE);
    const activeId = useDashboardValue<string>(SESSIONS_ACTIVE_STATE);
    const active = sessions.find((session) => session.id === activeId);

    return (
        <div className="rail">
            <nav className="rail__nav" aria-label="Sessions">
                <ul className="rail__list">
                    {sessions.map((session) => {
                        const isActive = session.id === activeId;
                        return (
                            <li key={session.id} className="rail__entry">
                                <button
                                    type="button"
                                    className={isActive ? 'rail__item is-active' : 'rail__item'}
                                    // aria-current marks the selected entry for assistive tech
                                    // without relying on colour alone.
                                    aria-current={isActive ? 'true' : undefined}
                                    aria-label={`Open session ${session.title}`}
                                    onClick={() => instance.execute<string>(SESSIONS_SELECT_COMMAND, session.id)}
                                >
                                    <span className="rail__title">{session.title}</span>
                                    <span className="rail__meta">{session.openedAt}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </nav>
            <div className="rail__footer">
                <button
                    type="button"
                    className="btn btn--accent"
                    aria-label="Create session"
                    onClick={() =>
                        // `create` takes an optional title; passing undefined uses
                        // the generated "Untitled session N" name.
                        instance.execute<string | undefined, string>(SESSIONS_CREATE_COMMAND, undefined)
                    }
                >
                    New session
                </button>
                <p className="rail__active">
                    Active: <strong>{active ? active.title : 'none'}</strong>
                </p>
            </div>
        </div>
    );
}
