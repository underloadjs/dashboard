// The shell: the only piece of React that knows what a "workspace" looks like,
// and it contains no feature list at all.
//
// Everything on screen comes out of the composed instance:
//
//   brand text   <- `layout.brand` service
//   columns      <- `layout.regions` service (order + accessible labels)
//   cards        <- PANEL_SLOT contributions (region + title + component)
//   status chips <- STATUS_SLOT contributions
//   skin         <- theme state projected onto data-* attributes
//
// Registering a ninth capability adds a panel with no edit to this file, which
// is the property the shell test pins down.
import type { Dashboard } from '@underload/dashboard';
import {
    LAYOUT_BRAND_SERVICE,
    LAYOUT_REGIONS_SERVICE,
    PANEL_SLOT,
    STATUS_SLOT,
    THEME_DENSITY_STATE,
    THEME_MODE_STATE,
    THEME_MOTION_STATE,
    type BrandSpec,
    type Contribution,
    type PanelValue,
    type RegionId,
    type RegionSpec,
    type StatusValue,
    type ThemeDensity,
    type ThemeMode,
    type ThemeMotion
} from './contract';
import { useDashboardService, useDashboardSlot, useDashboardValue } from './state-hooks';
import { WorkbenchProvider } from './workbench';

export function WorkstationShell({ instance }: { instance: Dashboard }) {
    return (
        <WorkbenchProvider instance={instance}>
            <ShellFrame />
        </WorkbenchProvider>
    );
}

function ShellFrame() {
    const brand = useDashboardService<BrandSpec>(LAYOUT_BRAND_SERVICE);
    const regions = useDashboardService<readonly RegionSpec[]>(LAYOUT_REGIONS_SERVICE);
    const panels = useDashboardSlot<PanelValue>(PANEL_SLOT);
    const statuses = useDashboardSlot<StatusValue>(STATUS_SLOT);

    const mode = useDashboardValue<ThemeMode>(THEME_MODE_STATE);
    const density = useDashboardValue<ThemeDensity>(THEME_DENSITY_STATE);
    const motion = useDashboardValue<ThemeMotion>(THEME_MOTION_STATE);

    // Slot order is already (order, registration index) stable, so grouping
    // preserves it and the plugins alone decide placement.
    const grouped = new Map<RegionId, readonly Contribution<PanelValue>[]>();
    for (const contribution of panels) {
        const existing = grouped.get(contribution.value.region) ?? [];
        grouped.set(contribution.value.region, [...existing, contribution]);
    }

    const declared = [...regions].sort((left, right) => left.order - right.order);
    const declaredIds: readonly RegionId[] = declared.map((spec) => spec.id);
    // A plugin may name a region layout never declared; it still gets rendered
    // (at the end) instead of vanishing, so a typo is visible rather than silent.
    const overflow: readonly RegionId[] = [...grouped.keys()].filter((id) => !declaredIds.includes(id));
    const columns: readonly { id: RegionId; label: string }[] = [
        ...declared.map((spec) => ({ id: spec.id, label: spec.label })),
        ...overflow.map((id) => ({ id, label: `${id} overflow` }))
    ];

    return (
        <div
            className="station"
            // The three theme states are the only styling switch the shell
            // touches; workstation.css owns every colour and metric.
            data-theme={mode}
            data-density={density}
            data-motion={motion}
        >
            <header className="station__bar">
                <h1 className="station__brand">{brand.name}</h1>
                <p className="station__tagline">{brand.tagline}</p>
                <div className="station__chips" role="group" aria-label="Station signal">
                    {statuses.map((contribution) => {
                        const Chip = contribution.value.component;
                        return <Chip key={contribution.id} />;
                    })}
                </div>
            </header>

            <div className="station__grid">
                {columns.map((column) => {
                    const columnPanels = grouped.get(column.id) ?? [];
                    return (
                        <section key={column.id} className={`station__region station__region--${column.id}`} aria-label={column.label}>
                            {columnPanels.map((contribution) => {
                                const Panel = contribution.value.component;
                                const titleId = `panel-${contribution.id}-title`;
                                return (
                                    <article
                                        key={contribution.id}
                                        className="panel"
                                        data-panel={contribution.id}
                                        aria-labelledby={titleId}
                                    >
                                        <header className="panel__head">
                                            <h2 className="panel__title" id={titleId}>
                                                {contribution.value.title}
                                            </h2>
                                            {contribution.value.hint ? (
                                                <span className="panel__hint">{contribution.value.hint}</span>
                                            ) : null}
                                        </header>
                                        <div className="panel__body">
                                            <Panel />
                                        </div>
                                    </article>
                                );
                            })}
                        </section>
                    );
                })}
            </div>

            <footer className="station__note">{brand.notice}</footer>
        </div>
    );
}
