// Station settings: theme mode, density and motion, plus the live palette.
//
// Two things are proven here at once:
//
//   1. A view can render data that only exists as a SERVICE (`theme.palettes`),
//      i.e. non-observable capability surface, not just observable state.
//   2. User preference state drives the shell's data-* attributes, and the
//      stylesheet reacts — no inline styling, no class juggling in JS.
//
// The swatch colour itself is the one genuinely dynamic value in the example
// (it comes from the palette data), so it is the only inline style used.
import {
    THEME_DENSITY_STATE,
    THEME_MOTION_STATE,
    THEME_MODE_STATE,
    THEME_PALETTE_SERVICE,
    THEME_SET_DENSITY_COMMAND,
    THEME_SET_MOTION_COMMAND,
    THEME_SET_MODE_COMMAND,
    type ThemeDensity,
    type ThemeMode,
    type ThemeMotion,
    type ThemePalette,
    type ThemePaletteBook
} from '../app/contract';
import { useDashboardService, useDashboardValue } from '../app/state-hooks';
import { useWorkbench } from '../app/workbench';

// Order of the swatch rows is fixed so the rendered palette is assertable.
const PALETTE_KEYS = [
    'surface',
    'raised',
    'line',
    'text',
    'muted',
    'accent',
    'warn'
] as const satisfies readonly (keyof ThemePalette)[];

const MODES: readonly { id: ThemeMode; label: string }[] = [
    { id: 'ink', label: 'Ink' },
    { id: 'slate', label: 'Slate' }
];

export function StationSettings() {
    const instance = useWorkbench();
    const mode = useDashboardValue<ThemeMode>(THEME_MODE_STATE);
    const density = useDashboardValue<ThemeDensity>(THEME_DENSITY_STATE);
    const motion = useDashboardValue<ThemeMotion>(THEME_MOTION_STATE);
    const palettes = useDashboardService<ThemePaletteBook>(THEME_PALETTE_SERVICE);
    const palette = palettes[mode];
    const compact = density === 'compact';
    const reduced = motion === 'reduced';

    return (
        <div className="settings">
            <div className="settings__group" role="group" aria-label="Theme mode">
                {MODES.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        className={mode === entry.id ? 'btn is-active' : 'btn'}
                        aria-pressed={mode === entry.id}
                        onClick={() => instance.execute<ThemeMode>(THEME_SET_MODE_COMMAND, entry.id)}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>
            <div className="settings__group settings__group--toggles">
                <button
                    type="button"
                    className="btn btn--ghost"
                    aria-pressed={compact}
                    onClick={() =>
                        instance.execute<ThemeDensity>(THEME_SET_DENSITY_COMMAND, compact ? 'comfort' : 'compact')
                    }
                >
                    Compact spacing
                </button>
                <button
                    type="button"
                    className="btn btn--ghost"
                    aria-pressed={reduced}
                    onClick={() => instance.execute<ThemeMotion>(THEME_SET_MOTION_COMMAND, reduced ? 'full' : 'reduced')}
                >
                    Reduce motion
                </button>
            </div>
            <ul className="swatches" aria-label={`${mode} palette`}>
                {PALETTE_KEYS.map((key) => (
                    <li key={key} className="swatches__row">
                        <span
                            className="swatches__chip"
                            aria-hidden="true"
                            style={{ background: palette[key] }}
                        />
                        <span className="swatches__name">{key}</span>
                        <code className="swatches__value">{palette[key]}</code>
                    </li>
                ))}
            </ul>
        </div>
    );
}
