// Static fixtures for the example workstation.
//
// This is the whole "backend": plain data in the bundle. The example talks to
// no server, opens no socket, and imports nothing from the underload harness —
// the DEMO_NOTICE string is what the shell footer renders so the simulation is
// labelled, never implied to be real.
import type { SessionRecord, ThemePaletteBook, ToolSpec } from '../app/contract';

// Shown in the shell footer and in the panel hints.
export const DEMO_NOTICE =
    'Static fixture transport — no backend, no network, no harness runtime. Every response below is simulated.';

// Two seeded sessions so the station opens with something to switch between.
// `openedAt` is a fixed label (not a timestamp) so assertions stay exact.
export const SEED_SESSIONS: readonly SessionRecord[] = [
    { id: 'session-ops', title: 'Station ops · coolant loop', openedAt: 'opened 07:15' },
    { id: 'session-array', title: 'Field work · relay array', openedAt: 'opened 09:40' }
];

// The pre-filled draft makes the first Send interaction obvious without typing.
// Exported as a name as well, because the tests state it as an exact expected
// value rather than re-deriving it from the object it lands in.
export const SEED_DRAFT_TEXT = 'Cross-check the coolant pressure log against the noon readings';

export const SEED_DRAFTS: Record<string, string> = {
    'session-ops': SEED_DRAFT_TEXT
};

// One seeded scratch note so the pad is not empty on first load.
export const SEED_NOTES = [{ id: 'note-1', text: 'Recalibrate the amber warning threshold' }];

// Instrument catalogue. Toggling these changes the text of every simulated
// reply, which is what makes the catalogue a real capability rather than
// decoration (see plugins/source.ts -> composeReply).
export const TOOL_CATALOGUE: readonly ToolSpec[] = [
    {
        id: 'read',
        label: 'Read',
        detail: 'Open a log slice and quote the lines around a timestamp.',
        enabledByDefault: true
    },
    {
        id: 'pulse',
        label: 'Pulse',
        detail: 'Poll the station telemetry bus for the next frame.',
        enabledByDefault: true
    },
    {
        id: 'plot',
        label: 'Plot',
        detail: 'Render a series from a numeric column.',
        enabledByDefault: false
    },
    {
        id: 'dispatch',
        label: 'Dispatch',
        detail: 'Queue a maintenance ticket for the next shift.',
        enabledByDefault: false
    }
];

// Canned opening lines, consumed round-robin (request index % length) so the
// Nth response is fully predictable in tests and varied in the browser.
export const SIMULATED_REPLIES: readonly string[] = [
    'Log slice is consistent',
    'Telemetry frame decoded without gaps',
    'Series looks flat within tolerance',
    'Cross-reference finished with one flagged row'
];

// Palettes are DATA here; the stylesheet carries the same colours keyed off
// [data-theme], and the settings panel renders these exact strings as swatches
// so the service surface is visible (and testable) in the UI.
export const THEME_PALETTES: ThemePaletteBook = {
    ink: {
        surface: '#0b1418',
        raised: '#12212a',
        line: '#1e3440',
        text: '#dcebee',
        muted: '#7fa0aa',
        accent: '#2dd4bf',
        warn: '#f59e0b'
    },
    slate: {
        surface: '#f2f6f7',
        raised: '#ffffff',
        line: '#d3e0e3',
        text: '#12262c',
        muted: '#5b7680',
        accent: '#0f766e',
        warn: '#b45309'
    }
};
