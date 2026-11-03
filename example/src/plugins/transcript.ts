// Transcript plugin: view state over the source's log.
//
// It never renders and never writes the log itself (that is `source`); it owns
// what a reader controls — which instrument traces are open, whether the view
// follows output, and how many responses were sealed per session.
//
// The two event subscriptions are the interesting part of the contract demo:
//
//   sessions.selected  -> traces collapse (per-session view state, no import of
//                         the sessions plugin)
//   source.completed   -> the seal counter for that session goes up
//
// Both are runtime listeners registered during setup, matching the core rule
// that registration happens at setup while events fire later.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    PANEL_SLOT,
    PLUGIN_IDS,
    SESSIONS_SELECTED_EVENT,
    SOURCE_COMPLETED_EVENT,
    TRANSCRIPT_AUTOSCROLL_COMMAND,
    TRANSCRIPT_AUTOSCROLL_STATE,
    TRANSCRIPT_EXPANDED_STATE,
    TRANSCRIPT_MARKS_STATE,
    TRANSCRIPT_PANEL,
    TRANSCRIPT_TOGGLE_COMMAND,
    type PanelValue,
    type SessionSelectedEvent,
    type SourceCompletedEvent
} from '../app/contract';
import { TranscriptStream } from '../components/TranscriptStream';

export function createTranscriptPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.transcript,
        setup(api) {
            const expanded = api.state<Record<string, boolean>>(TRANSCRIPT_EXPANDED_STATE, {});
            const marks = api.state<Record<string, number>>(TRANSCRIPT_MARKS_STATE, {});
            const autoscroll = api.state<boolean>(TRANSCRIPT_AUTOSCROLL_STATE, true);

            api.command<string, boolean>(TRANSCRIPT_TOGGLE_COMMAND, (messageId) => {
                const open = expanded.get()[messageId] !== true;
                expanded.set((previous) => ({ ...previous, [messageId]: open }));
                return open;
            });

            api.command<boolean, boolean>(TRANSCRIPT_AUTOSCROLL_COMMAND, (next) => {
                autoscroll.set(next);
                return next;
            });

            api.on<SessionSelectedEvent>(SESSIONS_SELECTED_EVENT, () => {
                expanded.set({});
            });

            api.on<SourceCompletedEvent>(SOURCE_COMPLETED_EVENT, ({ sessionId }) => {
                marks.set((previous) => ({ ...previous, [sessionId]: (previous[sessionId] ?? 0) + 1 }));
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: TRANSCRIPT_PANEL,
                order: 10,
                value: {
                    title: 'Transcript',
                    region: 'stage',
                    hint: 'station log',
                    component: TranscriptStream
                }
            });
        }
    };
}
