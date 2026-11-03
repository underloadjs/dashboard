// Capability contracts for the four state-only plugins (sessions, instruments,
// scratch, theme), asserted as exact values.
//
// These are the behaviours the DOM suite then exercises through real clicks; the
// split keeps each rule stated once, in the place that owns it.
import { describe, expect, it } from 'vitest';
import {
    SCRATCH_ADD_COMMAND,
    SCRATCH_CLEAR_COMMAND,
    SCRATCH_REMOVE_COMMAND,
    SCRATCH_STATE,
    SESSIONS_ACTIVE_STATE,
    SESSIONS_API_SERVICE,
    SESSIONS_CREATE_COMMAND,
    SESSIONS_SELECT_COMMAND,
    SESSIONS_STATE,
    THEME_DENSITY_STATE,
    THEME_MODE_STATE,
    THEME_MOTION_STATE,
    THEME_PALETTE_SERVICE,
    THEME_SET_DENSITY_COMMAND,
    THEME_SET_MOTION_COMMAND,
    THEME_SET_MODE_COMMAND,
    THEME_TOGGLE_MODE_COMMAND,
    TOOLS_API_SERVICE,
    TOOLS_RESET_COMMAND,
    TOOLS_STATE,
    TOOLS_TOGGLE_COMMAND,
    type ScratchNote,
    type SessionRecord,
    type SessionsApi,
    type ThemeMode,
    type ThemePaletteBook,
    type ToolsApi
} from '../app/contract';
import { createTestWorkbench } from '../testing/workbench';

describe('sessions capability', () => {
    it('opens on the seeded catalogue with the first job active', () => {
        const { instance } = createTestWorkbench();

        expect([...instance.state<SessionRecord[]>(SESSIONS_STATE).get()]).toEqual([
            { id: 'session-ops', title: 'Station ops · coolant loop', openedAt: 'opened 07:15' },
            { id: 'session-array', title: 'Field work · relay array', openedAt: 'opened 09:40' }
        ]);
        expect(instance.state<string>(SESSIONS_ACTIVE_STATE).get()).toBe('session-ops');
    });

    it('switches the active job and rejects an unknown one', () => {
        const { instance } = createTestWorkbench();

        const selected: string[] = [];
        instance.on<{ sessionId: string }>('sessions.selected', (payload) => {
            selected.push(payload.sessionId);
        });

        instance.execute<string>(SESSIONS_SELECT_COMMAND, 'session-array');
        expect(instance.state<string>(SESSIONS_ACTIVE_STATE).get()).toBe('session-array');

        expect(() => instance.execute<string>(SESSIONS_SELECT_COMMAND, 'session-ghost')).toThrow(
            'Unknown session: session-ghost'
        );
        // The failed select did not move the rail.
        expect(instance.state<string>(SESSIONS_ACTIVE_STATE).get()).toBe('session-array');

        // Re-selecting the active job still announces, which is how the
        // transcript gets its per-session reset.
        instance.execute<string>(SESSIONS_SELECT_COMMAND, 'session-array');
        expect(selected).toEqual(['session-array', 'session-array']);
    });

    it('creates and immediately activates a named job', () => {
        const { instance } = createTestWorkbench();
        const sessions = instance.service<SessionsApi>(SESSIONS_API_SERVICE);

        expect(instance.execute<string | undefined, string>(SESSIONS_CREATE_COMMAND, undefined)).toBe(
            'session-new-1'
        );
        expect(instance.execute<string | undefined, string>(SESSIONS_CREATE_COMMAND, '  Relay audit  ')).toBe(
            'session-new-2'
        );

        expect([...instance.state<SessionRecord[]>(SESSIONS_STATE).get()]).toEqual([
            { id: 'session-ops', title: 'Station ops · coolant loop', openedAt: 'opened 07:15' },
            { id: 'session-array', title: 'Field work · relay array', openedAt: 'opened 09:40' },
            { id: 'session-new-1', title: 'Untitled session 1', openedAt: 'opened just now' },
            { id: 'session-new-2', title: 'Relay audit', openedAt: 'opened just now' }
        ]);
        expect(sessions.active()).toBe('session-new-2');
        // Each dashboard instance keeps its own counter: a second composition
        // starts over at session-new-1.
        expect(createTestWorkbench().instance.service<SessionsApi>(SESSIONS_API_SERVICE).list().length).toBe(2);
    });
});

describe('instruments capability', () => {
    it('starts with the two default instruments live', () => {
        const { instance } = createTestWorkbench();

        expect([...instance.state<readonly string[]>(TOOLS_STATE).get()]).toEqual(['read', 'pulse']);
        expect(instance.service<ToolsApi>(TOOLS_API_SERVICE).catalogue().map((tool) => tool.id)).toEqual([
            'read',
            'pulse',
            'plot',
            'dispatch'
        ]);
    });

    it('keeps the enabled list in catalogue order however it was clicked', () => {
        const { instance } = createTestWorkbench();

        instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, 'dispatch');
        instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, 'plot');
        expect([...instance.state<readonly string[]>(TOOLS_STATE).get()]).toEqual([
            'read',
            'pulse',
            'plot',
            'dispatch'
        ]);

        // Toggling the first entry off leaves the rest in the same order.
        expect(instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, 'read')).toBe(false);
        expect([...instance.state<readonly string[]>(TOOLS_STATE).get()]).toEqual([
            'pulse',
            'plot',
            'dispatch'
        ]);

        expect(instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, 'read')).toBe(true);
        expect(instance.service<ToolsApi>(TOOLS_API_SERVICE).isEnabled('read')).toBe(true);
    });

    it('restores defaults and rejects an unknown instrument', () => {
        const { instance } = createTestWorkbench();

        instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, 'plot');
        expect([...instance.execute<void, readonly string[]>(TOOLS_RESET_COMMAND, undefined)]).toEqual([
            'read',
            'pulse'
        ]);

        expect(() => instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, 'teleport')).toThrow(
            'Unknown instrument: teleport'
        );
    });
});

describe('scratch capability', () => {
    it('pins, trims, removes and clears notes with generated ids', () => {
        const { instance } = createTestWorkbench();
        const notes = () => [...instance.state<readonly ScratchNote[]>(SCRATCH_STATE).get()];

        expect(notes()).toEqual([{ id: 'note-1', text: 'Recalibrate the amber warning threshold' }]);

        expect(instance.execute<string, string>(SCRATCH_ADD_COMMAND, 'Ship the checklist')).toBe('note-2');
        expect(instance.execute<string, string>(SCRATCH_ADD_COMMAND, '  Vent the loop  ')).toBe('note-3');
        expect(notes()).toEqual([
            { id: 'note-1', text: 'Recalibrate the amber warning threshold' },
            { id: 'note-2', text: 'Ship the checklist' },
            { id: 'note-3', text: 'Vent the loop' }
        ]);

        expect(instance.execute<string, boolean>(SCRATCH_REMOVE_COMMAND, 'note-2')).toBe(true);
        expect(instance.execute<string, boolean>(SCRATCH_REMOVE_COMMAND, 'note-2')).toBe(false);
        expect(instance.execute<void, readonly ScratchNote[]>(SCRATCH_CLEAR_COMMAND, undefined)).toEqual([]);
        expect(notes()).toEqual([]);

        // The id counter never reuses a removed id.
        expect(instance.execute<string, string>(SCRATCH_ADD_COMMAND, 'Again')).toBe('note-4');
    });

    it('refuses an empty note', () => {
        const { instance } = createTestWorkbench();

        expect(() => instance.execute<string, string>(SCRATCH_ADD_COMMAND, '   ')).toThrow(
            'Scratch note needs text'
        );
        expect(instance.state<readonly ScratchNote[]>(SCRATCH_STATE).get().length).toBe(1);
    });
});

describe('theme capability', () => {
    it('publishes the workstation palette as a service', () => {
        const { instance } = createTestWorkbench();
        const palettes = instance.service<ThemePaletteBook>(THEME_PALETTE_SERVICE);

        // Exact colours, independent of the fixture module, so a palette edit
        // that changes the deployed look has to be stated here too.
        expect(palettes.ink.accent).toBe('#2dd4bf');
        expect(palettes.ink.warn).toBe('#f59e0b');
        expect(palettes.ink.surface).toBe('#0b1418');
        expect(palettes.slate.accent).toBe('#0f766e');
        expect(palettes.slate.warn).toBe('#b45309');
        expect(palettes.slate.surface).toBe('#f2f6f7');
    });

    it('switches mode, density and motion through commands', () => {
        const { instance } = createTestWorkbench();

        expect(instance.state<ThemeMode>(THEME_MODE_STATE).get()).toBe('ink');

        expect(instance.execute<ThemeMode, { accent: string }>(THEME_SET_MODE_COMMAND, 'slate').accent).toBe(
            '#0f766e'
        );
        expect(instance.state<ThemeMode>(THEME_MODE_STATE).get()).toBe('slate');

        expect(instance.execute<void, ThemeMode>(THEME_TOGGLE_MODE_COMMAND, undefined)).toBe('ink');

        expect(() => instance.execute(THEME_SET_MODE_COMMAND, 'neon' as ThemeMode)).toThrow(
            'Unknown theme mode: neon'
        );
        expect(instance.state<ThemeMode>(THEME_MODE_STATE).get()).toBe('ink');

        instance.execute(THEME_SET_DENSITY_COMMAND, 'compact' as const);
        expect(instance.state<string>(THEME_DENSITY_STATE).get()).toBe('compact');

        instance.execute(THEME_SET_MOTION_COMMAND, 'reduced' as const);
        expect(instance.state<string>(THEME_MOTION_STATE).get()).toBe('reduced');
    });

    it('rejects unknown density and motion values the same way it rejects a mode', () => {
        const { instance } = createTestWorkbench();

        // Runtime validation matters because commands are reachable from untyped
        // callers (instance.execute), not only from the typed settings panel.
        expect(() => instance.execute(THEME_SET_DENSITY_COMMAND, 'roomy' as never)).toThrow(
            'Unknown theme density: roomy'
        );
        expect(() => instance.execute(THEME_SET_MOTION_COMMAND, 'slow' as never)).toThrow(
            'Unknown theme motion: slow'
        );
        // Nothing was written: the shell attributes keep their real values.
        expect(instance.state<string>(THEME_DENSITY_STATE).get()).toBe('comfort');
        expect(instance.state<string>(THEME_MOTION_STATE).get()).toBe('full');

        // The valid values still work after a rejection.
        expect(instance.execute(THEME_SET_DENSITY_COMMAND, 'compact' as const)).toBe('compact');
        expect(instance.execute(THEME_SET_MOTION_COMMAND, 'reduced' as const)).toBe('reduced');
    });
});
