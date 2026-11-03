// Status strip chips, one per capability that owns live signal.
//
// Each chip is a separate slot contribution, so the strip grows by plugin
// registration rather than by editing the shell: layout contributes the brand,
// sessions the active job, tools the instrument count, source the request phase.
import {
    LAYOUT_BRAND_SERVICE,
    SESSIONS_ACTIVE_STATE,
    SESSIONS_STATE,
    SOURCE_IDLE_STATUS,
    SOURCE_STATUS_STATE,
    TOOLS_STATE,
    type BrandSpec,
    type SessionRecord,
    type SourcePhase,
    type SourceStatusMap
} from '../app/contract';
import { useDashboardService, useDashboardValue } from '../app/state-hooks';

/** Fixed wording for the transport phase, kept here so tests can pin it. */
export const PHASE_LABELS: Record<SourcePhase, string> = {
    idle: 'IDLE',
    running: 'RUNNING',
    completed: 'SEALED',
    cancelled: 'CANCELLED'
};

/** Wordmark contributed by the layout plugin (order 10).
 * Slot components are rendered without props, so the brand text is read back
 * from the layout service rather than passed in.
 */
export function BrandChip() {
    const brand = useDashboardService<BrandSpec>(LAYOUT_BRAND_SERVICE);
    return (
        <span className="chip chip--brand" data-chip="brand">
            {brand.name}
        </span>
    );
}

/** Active session name (order 15). */
export function SessionChip() {
    const sessions = useDashboardValue<SessionRecord[]>(SESSIONS_STATE);
    const activeId = useDashboardValue<string>(SESSIONS_ACTIVE_STATE);
    const active = sessions.find((session) => session.id === activeId);
    return (
        <span className="chip" data-chip="session">
            <span className="chip__key">Job</span>
            <span className="chip__value">{active ? active.title : 'none'}</span>
        </span>
    );
}

/** Instrument tally, the visible consequence of toggling the rack (order 20). */
export function ToolsChip() {
    const enabled = useDashboardValue<readonly string[]>(TOOLS_STATE);
    return (
        <span className="chip" data-chip="tools">
            <span className="chip__key">Instruments</span>
            <span className="chip__value">{`${enabled.length} live`}</span>
        </span>
    );
}

/** Transport phase of the session on screen, plus how many jobs stream at once
 * (order 30).
 *
 * No aria-live here: the transcript `<ol role="log">` is the single announced
 * region, and a second live region repeating "RUNNING/SEALED" made screen
 * readers announce the same change twice. The phase is still in the accessible
 * tree as text; it is just not pushy about announcing.
 */
export function SourceChip() {
    const statuses = useDashboardValue<SourceStatusMap>(SOURCE_STATUS_STATE);
    const sessionId = useDashboardValue<string>(SESSIONS_ACTIVE_STATE);
    const status = statuses[sessionId] ?? SOURCE_IDLE_STATUS;
    const streams = Object.values(statuses).filter((entry) => entry.phase === 'running').length;
    return (
        <span
            className="chip"
            data-chip="phase"
            data-phase={status.phase}
            data-streams={streams}
            aria-label={`Transport for session ${sessionId}: ${PHASE_LABELS[status.phase]}`}
        >
            <span className="chip__key">Transport</span>
            <span className="chip__value">{PHASE_LABELS[status.phase]}</span>
            {status.requestId ? <span className="chip__ref">{status.requestId}</span> : null}
            {/* Only shown when overlap is real, so the normal case stays quiet. */}
            {streams > 1 ? <span className="chip__ref">{`${streams} jobs`}</span> : null}
        </span>
    );
}
