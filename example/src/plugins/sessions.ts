// Sessions plugin: the job rail (switch + create).
//
// Catalogue and active id are two separate states so a view can watch one
// without the other (the rail needs both, the composer only needs the active
// id). Selecting and creating emit events the transcript plugin listens to —
// that is how a per-session view reset happens without either plugin importing
// the other.
//
// `openedAt` on a created session is a fixed label rather than a timestamp: the
// example never reads wall-clock time, so every rendered string stays exact.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    PANEL_SLOT,
    PLUGIN_IDS,
    SESSIONS_ACTIVE_STATE,
    SESSIONS_API_SERVICE,
    SESSION_CHIP,
    SESSIONS_CREATED_EVENT,
    SESSIONS_CREATE_COMMAND,
    SESSIONS_PANEL,
    SESSIONS_SELECT_COMMAND,
    SESSIONS_SELECTED_EVENT,
    SESSIONS_STATE,
    STATUS_SLOT,
    type PanelValue,
    type SessionCreatedEvent,
    type SessionRecord,
    type SessionSelectedEvent,
    type SessionsApi,
    type StatusValue
} from '../app/contract';
import { SessionsBoard } from '../components/SessionsBoard';
import { SessionChip } from '../components/StatusStrip';
import { SEED_SESSIONS } from '../data/fixtures';

export function createSessionsPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.sessions,
        setup(api) {
            const catalog = api.state<SessionRecord[]>(SESSIONS_STATE, SEED_SESSIONS.map((session) => ({ ...session })));
            const active = api.state<string>(SESSIONS_ACTIVE_STATE, SEED_SESSIONS[0].id);

            // Counters drive "session-new-1" / "Untitled session 1" — again so
            // the created records are exactly assertable.
            let created = 0;

            const select = (id: string): void => {
                if (!catalog.get().some((session) => session.id === id)) {
                    throw new Error(`Unknown session: ${id}`);
                }
                if (active.get() !== id) {
                    active.set(id);
                }
                // Always announced, even when it was already active: the
                // transcript uses this to reset its per-session view state.
                const event: SessionSelectedEvent = { sessionId: id };
                api.emit(SESSIONS_SELECTED_EVENT, event);
            };

            const create = (title?: string): string => {
                created += 1;
                const trimmed = typeof title === 'string' ? title.trim() : '';
                const session: SessionRecord = {
                    id: `session-new-${created}`,
                    title: trimmed.length > 0 ? trimmed : `Untitled session ${created}`,
                    openedAt: 'opened just now'
                };
                catalog.set((previous) => [...previous, session]);
                active.set(session.id);
                const createdEvent: SessionCreatedEvent = { sessionId: session.id, title: session.title };
                api.emit(SESSIONS_CREATED_EVENT, createdEvent);
                const selectedEvent: SessionSelectedEvent = { sessionId: session.id };
                api.emit(SESSIONS_SELECTED_EVENT, selectedEvent);
                return session.id;
            };

            api.service<SessionsApi>(SESSIONS_API_SERVICE, {
                list: () => catalog.get(),
                active: () => active.get(),
                select,
                create
            });

            api.command<string, void>(SESSIONS_SELECT_COMMAND, (id) => {
                select(id);
            });
            api.command<string | undefined, string>(SESSIONS_CREATE_COMMAND, (title) => create(title));

            api.slot<PanelValue>(PANEL_SLOT, {
                id: SESSIONS_PANEL,
                order: 10,
                value: {
                    title: 'Sessions',
                    region: 'sidebar',
                    hint: 'simulated',
                    component: SessionsBoard
                }
            });

            api.slot<StatusValue>(STATUS_SLOT, {
                id: SESSION_CHIP,
                order: 15,
                value: { label: 'Active session', component: SessionChip }
            });
        }
    };
}
