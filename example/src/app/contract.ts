// Shared contract for the example workstation.
//
// Everything a plugin registers (state ids, service ids, command ids, event ids,
// slot names) and everything a view reads back lives here, in ONE module with no
// imports from plugins or components. That is deliberate:
//
//   - plugins import the ids and register against them;
//   - components import the same ids to read state/services and execute commands;
//   - tests import the same ids to assert exact values.
//
// A single id module avoids plugin<->component import cycles (each plugin imports
// its component, which would otherwise import the plugin back) and makes a rename
// a one-line change that every consumer typechecks.
//
// The core contract itself (dashboard(), Dashboard, DashboardPlugin,
// DashboardState) comes from '@underload/dashboard' and is imported wherever it
// is used; this file only adds the example's own vocabulary on top of it.
import type { ComponentType } from 'react';

// ——— Slot names ——————————————————————————————————————————————————————————————
// Two slots are enough to prove the framework: the shell maps over both and
// renders whatever is registered, so a new capability needs no shell change.

/** Every panel (a titled region card) the shell renders. */
export const PANEL_SLOT = 'workspace.panels';

/** Small live chips rendered in the top status strip. */
export const STATUS_SLOT = 'workspace.status';

/** Shape of one slot contribution as returned by `instance.slot<T>(name)`. */
export type Contribution<T> = { id: string; order: number; value: T };

// ——— Regions (layout vocabulary) ——————————————————————————————————————————————

/** The three workspace columns: sessions rail, centre stage, instrument aside. */
export type RegionId = 'sidebar' | 'stage' | 'aside';

/** Region metadata published by the layout plugin (`layout.regions` service). */
export type RegionSpec = { id: RegionId; label: string; order: number };

/** Brand metadata published by the layout plugin (`layout.brand` service). */
export type BrandSpec = { name: string; tagline: string; notice: string };

/** Value registered in PANEL_SLOT: what the shell must render and where. */
export type PanelValue = {
    title: string;
    region: RegionId;
    /** Short right-aligned caption in the panel header (e.g. "simulated"). */
    hint?: string;
    component: ComponentType;
};

/** Value registered in STATUS_SLOT: one live chip in the status strip. */
export type StatusValue = { label: string; component: ComponentType };

// ——— Domain model (simulated workstation data) ——————————————————————————————

/** One entry of the station log. `phase` drives the streaming/cancelled UI. */
export type MessageRole = 'user' | 'assistant' | 'tool';
export type MessagePhase = 'running' | 'complete' | 'cancelled';

export type TranscriptMessage = {
    id: string;
    sessionId: string;
    role: MessageRole;
    phase: MessagePhase;
    text: string;
    /** Virtual clock timestamp (see support/clock.ts), never wall-clock-only. */
    at: number;
};

/** Transcript log keyed by session id; missing key means "no messages yet". */
export type TranscriptLog = Record<string, readonly TranscriptMessage[]>;

/** Lifecycle of one simulated response. */
export type SourcePhase = 'idle' | 'running' | 'completed' | 'cancelled';

/**
 * Transport state of ONE session.
 *
 * Deliberately per-session (D1): two jobs can stream at the same time, and a
 * single global "last known" record let a completion in one session overwrite the
 * running state of another, which then disarmed the Cancel button incorrectly.
 */
export type SourceStatus = { phase: SourcePhase; requestId: string };

/** `source.status` state: session id -> that session's transport state. */
export type SourceStatusMap = Record<string, SourceStatus>;

/**
 * Shared idle value. A const so the plugin, the chip and the tests all describe
 * "this session has never sent" the same way instead of each inventing one.
 */
export const SOURCE_IDLE_STATUS: SourceStatus = { phase: 'idle', requestId: '' };

/** One entry of the sessions rail. */
export type SessionRecord = { id: string; title: string; openedAt: string };

/** One instrument in the catalogue (toggling changes simulated replies). */
export type ToolSpec = {
    id: string;
    label: string;
    detail: string;
    enabledByDefault: boolean;
};

/** One scratch note. */
export type ScratchNote = { id: string; text: string };

// ——— Theme vocabulary —————————————————————————————————————————————————————————

/** 'ink' is the dark teal/amber workstation look, 'slate' the light variant. */
export type ThemeMode = 'ink' | 'slate';
export type ThemeDensity = 'comfort' | 'compact';
export type ThemeMotion = 'full' | 'reduced';

/** Semantic palette the theme service publishes (rendered as swatches). */
export type ThemePalette = {
    surface: string;
    raised: string;
    line: string;
    text: string;
    muted: string;
    accent: string;
    warn: string;
};

/** Value of the `theme.palettes` service: exact colours per mode. */
export type ThemePaletteBook = Record<ThemeMode, ThemePalette>;

// ——— Service facades (cross-plugin dependency surface) ——————————————————————
// Plugins talk to each other through these, never through the instance: the
// instance is only handed to the React layer. `requires` guarantees the
// dependency is registered before the dependent plugin's setup runs.

/** `tools.api` — read the live instrument selection. */
export type ToolsApi = {
    catalogue(): readonly ToolSpec[];
    enabled(): readonly string[];
    isEnabled(id: string): boolean;
};

/** `sessions.api` — read/switch/create sessions. */
export type SessionsApi = {
    list(): readonly SessionRecord[];
    active(): string;
    select(id: string): void;
    create(title?: string): string;
};

/** `source.api` - the simulated response engine. */
export type SourceApi = {
    /** Appends the user turn and starts streaming; returns the request id. */
    send(input: { sessionId: string; text: string }): string;
    /** Drops the pending stream chunks; false when nothing is in flight. */
    cancel(requestId: string): boolean;
    messages(sessionId: string): readonly TranscriptMessage[];
    /** Transport state of ONE session (idle when that session never sent). */
    status(sessionId: string): SourceStatus;
    /** Session ids that currently have a stream in flight, in request order. */
    running(): readonly string[];
};

// ——— State ids ————————————————————————————————————————————————————————————————

export const THEME_MODE_STATE = 'theme.mode';
export const THEME_DENSITY_STATE = 'theme.density';
export const THEME_MOTION_STATE = 'theme.motion';

export const TOOLS_STATE = 'tools.enabled';

export const SOURCE_TRANSCRIPT_STATE = 'source.transcript';
export const SOURCE_STATUS_STATE = 'source.status';

export const SESSIONS_STATE = 'sessions.catalog';
export const SESSIONS_ACTIVE_STATE = 'sessions.active';

export const TRANSCRIPT_EXPANDED_STATE = 'transcript.expanded';
export const TRANSCRIPT_MARKS_STATE = 'transcript.marks';
export const TRANSCRIPT_AUTOSCROLL_STATE = 'transcript.autoscroll';

export const COMPOSER_DRAFTS_STATE = 'composer.drafts';

export const SCRATCH_STATE = 'scratch.notes';

// ——— Service ids ———————————————————————————————————————————————————————————————

export const LAYOUT_BRAND_SERVICE = 'layout.brand';
export const LAYOUT_REGIONS_SERVICE = 'layout.regions';
export const THEME_PALETTE_SERVICE = 'theme.palettes';
export const TOOLS_API_SERVICE = 'tools.api';
export const SESSIONS_API_SERVICE = 'sessions.api';
export const SOURCE_API_SERVICE = 'source.api';

// ——— Command ids ———————————————————————————————————————————————————————————————

export const THEME_SET_MODE_COMMAND = 'theme.setMode';
export const THEME_TOGGLE_MODE_COMMAND = 'theme.toggleMode';
export const THEME_SET_DENSITY_COMMAND = 'theme.setDensity';
export const THEME_SET_MOTION_COMMAND = 'theme.setMotion';

export const TOOLS_TOGGLE_COMMAND = 'tools.toggle';
export const TOOLS_RESET_COMMAND = 'tools.reset';

export const SOURCE_SEND_COMMAND = 'source.send';
export const SOURCE_CANCEL_COMMAND = 'source.cancel';

export const SESSIONS_SELECT_COMMAND = 'sessions.select';
export const SESSIONS_CREATE_COMMAND = 'sessions.create';

export const TRANSCRIPT_TOGGLE_COMMAND = 'transcript.toggleDetails';
export const TRANSCRIPT_AUTOSCROLL_COMMAND = 'transcript.setAutoscroll';

export const COMPOSER_UPDATE_COMMAND = 'composer.update';
export const COMPOSER_SEND_COMMAND = 'composer.send';
export const COMPOSER_CANCEL_COMMAND = 'composer.cancel';

export const SCRATCH_ADD_COMMAND = 'scratch.add';
export const SCRATCH_REMOVE_COMMAND = 'scratch.remove';
export const SCRATCH_CLEAR_COMMAND = 'scratch.clear';

// ——— Event ids —————————————————————————————————————————————————————————————————

export const SESSIONS_SELECTED_EVENT = 'sessions.selected';
export const SESSIONS_CREATED_EVENT = 'sessions.created';
export const TOOLS_TOGGLED_EVENT = 'tools.toggled';
export const SOURCE_STARTED_EVENT = 'source.started';
export const SOURCE_DELTA_EVENT = 'source.delta';
export const SOURCE_COMPLETED_EVENT = 'source.completed';
export const SOURCE_CANCELLED_EVENT = 'source.cancelled';
export const COMPOSER_SENT_EVENT = 'composer.sent';

// ——— Event payload types ————————————————————————————————————————————————————————

export type SessionSelectedEvent = { sessionId: string };
export type SessionCreatedEvent = { sessionId: string; title: string };
export type ToolsToggledEvent = { id: string; enabled: boolean };
export type SourceStartedEvent = { requestId: string; sessionId: string; chunks: number };
export type SourceDeltaEvent = { requestId: string; sessionId: string; delivered: number; chunks: number };
export type SourceCompletedEvent = { requestId: string; sessionId: string; text: string };
export type SourceCancelledEvent = { requestId: string; sessionId: string; text: string };
export type ComposerSentEvent = { sessionId: string; requestId: string };

// ——— Panel ids (the render order of the three regions) ————————————————————————
// `slot()` sorts contributions by `order` (stable), so these numbers are the
// only thing that decides placement — the shell has no feature list.

export const SESSIONS_PANEL = 'sessions';
export const TRANSCRIPT_PANEL = 'transcript';
export const COMPOSER_PANEL = 'composer';
export const TOOLS_PANEL = 'tools';
export const SCRATCH_PANEL = 'scratch';
export const SETTINGS_PANEL = 'settings';

export const BRAND_CHIP = 'layout.brand';
export const SESSION_CHIP = 'sessions.active';
export const TOOLS_CHIP = 'tools.count';
export const SOURCE_CHIP = 'source.phase';

/** Plugin ids, also the expected value of `instance.plugins`. */
export const PLUGIN_IDS = {
    layout: 'layout',
    theme: 'theme',
    tools: 'tools',
    source: 'source',
    sessions: 'sessions',
    transcript: 'transcript',
    composer: 'composer',
    scratch: 'scratch'
} as const;
