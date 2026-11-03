// Composer plugin: draft text plus the send/cancel bridge.
//
// Drafts are kept per session in core state, so switching jobs keeps each
// unfinished message — state that a component-local useState could not provide
// across a session switch.
//
// This plugin is the clearest demonstration of the dependency story: it depends
// on BOTH the session rail and the transport, declares `requires`, and reaches
// them through their service facades. It never touches the instance, and it
// never renders — the deck it registers is just a contribution.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    COMPOSER_CANCEL_COMMAND,
    COMPOSER_DRAFTS_STATE,
    COMPOSER_PANEL,
    COMPOSER_SEND_COMMAND,
    COMPOSER_SENT_EVENT,
    COMPOSER_UPDATE_COMMAND,
    PANEL_SLOT,
    PLUGIN_IDS,
    SESSIONS_API_SERVICE,
    SOURCE_API_SERVICE,
    type ComposerSentEvent,
    type PanelValue,
    type SessionsApi,
    type SourceApi
} from '../app/contract';
import { ComposerDeck } from '../components/ComposerDeck';
import { SEED_DRAFTS } from '../data/fixtures';

export function createComposerPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.composer,
        requires: [PLUGIN_IDS.sessions, PLUGIN_IDS.source],
        setup(api) {
            const drafts = api.state<Record<string, string>>(COMPOSER_DRAFTS_STATE, { ...SEED_DRAFTS });
            const sessions = api.getService<SessionsApi>(SESSIONS_API_SERVICE);
            const source = api.getService<SourceApi>(SOURCE_API_SERVICE);

            // A caller may omit the session id to mean "the one on screen".
            const resolveSession = (sessionId?: string): string =>
                typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : sessions.active();

            api.command<{ sessionId: string; text: string }, void>(COMPOSER_UPDATE_COMMAND, ({ sessionId, text }) => {
                drafts.set((previous) => ({ ...previous, [sessionId]: text }));
            });

            api.command<string | undefined, string>(COMPOSER_SEND_COMMAND, (rawSessionId) => {
                const sessionId = resolveSession(rawSessionId);
                const text = (drafts.get()[sessionId] ?? '').trim();
                if (text.length === 0) {
                    // Guarded so a stray Enter cannot append an empty turn.
                    throw new Error('Composer is empty');
                }

                const requestId = source.send({ sessionId, text });
                // The draft clears only once the transport accepted the prompt.
                drafts.set((previous) => ({ ...previous, [sessionId]: '' }));
                const sent: ComposerSentEvent = { sessionId, requestId };
                api.emit(COMPOSER_SENT_EVENT, sent);
                return requestId;
            });

            api.command<string | undefined, boolean>(COMPOSER_CANCEL_COMMAND, (rawSessionId) => {
                const sessionId = resolveSession(rawSessionId);
                // Per-session lookup: this session's own stream is the only one a
                // cancel can touch, regardless of what another session is doing.
                const status = source.status(sessionId);
                if (status.phase !== 'running') {
                    return false;
                }
                return source.cancel(status.requestId);
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: COMPOSER_PANEL,
                order: 20,
                value: {
                    title: 'Composer',
                    region: 'stage',
                    hint: 'fixture transport',
                    component: ComposerDeck
                }
            });
        }
    };
}
