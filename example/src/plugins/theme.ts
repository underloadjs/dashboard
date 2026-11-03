// Theme plugin: operator preferences plus the semantic palette service.
//
// Three independent states (mode / density / motion) so a consumer can honour
// one without the others; the shell projects them onto data-* attributes and
// the stylesheet does the rest. `theme.palettes` is a SERVICE because the
// colours are static capability data (a consumer may render its own surfaces
// from them), not observable state.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    PANEL_SLOT,
    PLUGIN_IDS,
    SETTINGS_PANEL,
    THEME_DENSITY_STATE,
    THEME_MODE_STATE,
    THEME_MOTION_STATE,
    THEME_PALETTE_SERVICE,
    THEME_SET_DENSITY_COMMAND,
    THEME_SET_MOTION_COMMAND,
    THEME_SET_MODE_COMMAND,
    THEME_TOGGLE_MODE_COMMAND,
    type PanelValue,
    type ThemeDensity,
    type ThemeMode,
    type ThemeMotion,
    type ThemePalette,
    type ThemePaletteBook
} from '../app/contract';
import { StationSettings } from '../components/StationSettings';
import { THEME_PALETTES } from '../data/fixtures';

// The accepted value sets, declared as data so the runtime guards below and any
// future settings UI stay in sync (the TS unions are the compile-time half).
const DENSITIES: readonly ThemeDensity[] = ['comfort', 'compact'];
const MOTIONS: readonly ThemeMotion[] = ['full', 'reduced'];

export function createThemePlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.theme,
        setup(api) {
            // 'ink' is the default: the example is meant to read as a dark
            // workstation, distinct from the harness UI.
            const mode = api.state<ThemeMode>(THEME_MODE_STATE, 'ink');
            const density = api.state<ThemeDensity>(THEME_DENSITY_STATE, 'comfort');
            const motion = api.state<ThemeMotion>(THEME_MOTION_STATE, 'full');

            api.service<ThemePaletteBook>(THEME_PALETTE_SERVICE, THEME_PALETTES);

            api.command<ThemeMode, ThemePalette>(THEME_SET_MODE_COMMAND, (next) => {
                // Commands are callable through instance.execute(), i.e. from
                // untyped callers too, so the mode is validated at runtime.
                const palette: ThemePalette | undefined = THEME_PALETTES[next];
                if (palette === undefined) {
                    throw new Error(`Unknown theme mode: ${String(next)}`);
                }
                mode.set(next);
                return palette;
            });

            api.command<void, ThemeMode>(THEME_TOGGLE_MODE_COMMAND, () => {
                const next: ThemeMode = mode.get() === 'ink' ? 'slate' : 'ink';
                mode.set(next);
                return next;
            });

            api.command<ThemeDensity, ThemeDensity>(THEME_SET_DENSITY_COMMAND, (next) => {
                // Same runtime contract as setMode: commands are reachable from
                // untyped callers, so every accepted value is validated.
                if (!DENSITIES.includes(next)) {
                    throw new Error(`Unknown theme density: ${String(next)}`);
                }
                density.set(next);
                return next;
            });

            api.command<ThemeMotion, ThemeMotion>(THEME_SET_MOTION_COMMAND, (next) => {
                if (!MOTIONS.includes(next)) {
                    throw new Error(`Unknown theme motion: ${String(next)}`);
                }
                motion.set(next);
                return next;
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: SETTINGS_PANEL,
                order: 30,
                value: {
                    title: 'Settings',
                    region: 'aside',
                    hint: 'local only',
                    component: StationSettings
                }
            });
        }
    };
}
