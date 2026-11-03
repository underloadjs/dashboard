// Scratch pad: local working notes for the station.
//
// Notes are core state (so they survive re-render, session switches and a
// future persistence adapter), while the uncommitted input text stays ordinary
// React state — the split is deliberate: only committed data belongs in the
// dashboard store.
import { useState } from 'react';
import {
    SCRATCH_ADD_COMMAND,
    SCRATCH_CLEAR_COMMAND,
    SCRATCH_REMOVE_COMMAND,
    SCRATCH_STATE,
    type ScratchNote
} from '../app/contract';
import { useDashboardValue } from '../app/state-hooks';
import { useWorkbench } from '../app/workbench';

export function ScratchPad() {
    const instance = useWorkbench();
    const notes = useDashboardValue<readonly ScratchNote[]>(SCRATCH_STATE);
    const [draft, setDraft] = useState('');

    const add = () => {
        const text = draft.trim();
        if (text.length === 0) return;
        instance.execute<string, string>(SCRATCH_ADD_COMMAND, text);
        setDraft('');
    };

    return (
        <div className="pad">
            <ul className="pad__list" aria-label="Scratch notes">
                {notes.length === 0 ? (
                    <li className="pad__empty">Nothing pinned. Add a note below.</li>
                ) : (
                    notes.map((note) => (
                        <li key={note.id} className="pad__entry" data-note={note.id}>
                            <span className="pad__text">{note.text}</span>
                            <button
                                type="button"
                                className="btn btn--ghost pad__remove"
                                aria-label={`Remove ${note.text}`}
                                onClick={() => instance.execute<string, boolean>(SCRATCH_REMOVE_COMMAND, note.id)}
                            >
                                Remove
                            </button>
                        </li>
                    ))
                )}
            </ul>
            <div className="pad__composer">
                <label className="pad__label" htmlFor="scratch-input">
                    Pin a note
                </label>
                <div className="pad__row">
                    <input
                        id="scratch-input"
                        className="pad__input"
                        type="text"
                        autoComplete="off"
                        value={draft}
                        placeholder="Something to keep in view"
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                // No form here, so Enter is wired by hand.
                                event.preventDefault();
                                add();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="btn btn--accent"
                        aria-label="Add note"
                        disabled={draft.trim().length === 0}
                        onClick={add}
                    >
                        Add
                    </button>
                </div>
            </div>
            <button
                type="button"
                className="btn btn--ghost"
                aria-label="Clear all notes"
                onClick={() => instance.execute<void, readonly ScratchNote[]>(SCRATCH_CLEAR_COMMAND, undefined)}
            >
                Clear pad
            </button>
        </div>
    );
}
