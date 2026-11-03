// Scratch plugin: pinned working notes.
//
// The simplest capability in the example (add / remove / clear) and the one
// that proves the contract is enough on its own: a state record, three commands,
// one panel — no other plugin needs to know it exists.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    PANEL_SLOT,
    PLUGIN_IDS,
    SCRATCH_ADD_COMMAND,
    SCRATCH_CLEAR_COMMAND,
    SCRATCH_PANEL,
    SCRATCH_REMOVE_COMMAND,
    SCRATCH_STATE,
    type PanelValue,
    type ScratchNote
} from '../app/contract';
import { ScratchPad } from '../components/ScratchPad';
import { SEED_NOTES } from '../data/fixtures';

export function createScratchPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.scratch,
        setup(api) {
            const notes = api.state<readonly ScratchNote[]>(SCRATCH_STATE, SEED_NOTES.map((note) => ({ ...note })));

            // Continues the seeded sequence (note-1 exists, so the first
            // addition is note-2) instead of colliding with fixture ids.
            let sequence = SEED_NOTES.length;

            api.command<string, string>(SCRATCH_ADD_COMMAND, (text) => {
                const trimmed = text.trim();
                if (trimmed.length === 0) {
                    throw new Error('Scratch note needs text');
                }
                sequence += 1;
                const note: ScratchNote = { id: `note-${sequence}`, text: trimmed };
                notes.set((previous) => [...previous, note]);
                return note.id;
            });

            api.command<string, boolean>(SCRATCH_REMOVE_COMMAND, (id) => {
                const previous = notes.get();
                const kept = previous.filter((note) => note.id !== id);
                notes.set(kept);
                return kept.length !== previous.length;
            });

            api.command<void, readonly ScratchNote[]>(SCRATCH_CLEAR_COMMAND, () => {
                notes.set([]);
                return notes.get();
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: SCRATCH_PANEL,
                order: 20,
                value: {
                    title: 'Scratch',
                    region: 'aside',
                    hint: 'pinned notes',
                    component: ScratchPad
                }
            });
        }
    };
}
