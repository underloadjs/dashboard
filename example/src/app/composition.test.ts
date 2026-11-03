// Composition contract for the example workstation.
//
// Pins down the registration surface the shell depends on, with exact values:
//
//   1. instance.plugins — the eight capabilities, in setup order.
//   2. the layout services (regions + brand, including the demo notice).
//   3. PANEL_SLOT / STATUS_SLOT contributions — ids, orders and regions, i.e.
//      the placement rules that decide the rendered layout.
//   4. slot ordering itself (stable, by `order`).
//   5. the feature-blindness claim: an unknown plugin's panel renders too.
//   6. dispose() releases the transport's pending stream timer.
//
// Nothing here touches the DOM; the DOM side lives in WorkstationShell.test.tsx.
import { describe, expect, it } from 'vitest';
import {
    LAYOUT_BRAND_SERVICE,
    LAYOUT_REGIONS_SERVICE,
    PANEL_SLOT,
    SOURCE_SEND_COMMAND,
    STATUS_SLOT,
    type BrandSpec,
    type PanelValue,
    type RegionSpec,
    type StatusValue
} from './contract';
import { createTestWorkbench } from '../testing/workbench';
import { DEMO_NOTICE } from '../data/fixtures';
import type { DashboardPlugin } from '@underload/dashboard';

describe('example composition', () => {
    it('registers exactly the eight capabilities, in setup order', () => {
        const { instance } = createTestWorkbench();

        // `requires` (tools -> source, sessions+source -> composer) is satisfied
        // by this order, so the list below is also the dependency-safe order.
        expect([...instance.plugins]).toEqual([
            'layout',
            'theme',
            'tools',
            'source',
            'sessions',
            'transcript',
            'composer',
            'scratch'
        ]);
    });

    it('publishes the three regions and the brand through layout services', () => {
        const { instance } = createTestWorkbench();

        const regions = instance.service<readonly RegionSpec[]>(LAYOUT_REGIONS_SERVICE);
        expect([...regions]).toEqual([
            { id: 'sidebar', label: 'Session rail', order: 10 },
            { id: 'stage', label: 'Work stage', order: 20 },
            { id: 'aside', label: 'Instrument aside', order: 30 }
        ]);

        const brand = instance.service<BrandSpec>(LAYOUT_BRAND_SERVICE);
        expect(brand).toEqual({
            name: 'Underload Workstation',
            tagline: 'Plugin-composed example — every panel below registered itself',
            notice: DEMO_NOTICE
        });
    });

    it('places every panel through the slot, in stable order', () => {
        const { instance } = createTestWorkbench();

        const panels = instance.slot<PanelValue>(PANEL_SLOT);
        // Flat slot order is (order, registration index): three panels claim
        // order 10, so registration order breaks the tie.
        expect(
            panels.map((contribution) => ({
                id: contribution.id,
                order: contribution.order,
                region: contribution.value.region,
                title: contribution.value.title
            }))
        ).toEqual([
            { id: 'tools', order: 10, region: 'aside', title: 'Instruments' },
            { id: 'sessions', order: 10, region: 'sidebar', title: 'Sessions' },
            { id: 'transcript', order: 10, region: 'stage', title: 'Transcript' },
            { id: 'composer', order: 20, region: 'stage', title: 'Composer' },
            { id: 'scratch', order: 20, region: 'aside', title: 'Scratch' },
            { id: 'settings', order: 30, region: 'aside', title: 'Settings' }
        ]);

        // What the shell then renders per column (grouping preserves slot order).
        const byRegion = (region: string) =>
            panels.filter((contribution) => contribution.value.region === region).map((c) => c.id);
        expect(byRegion('sidebar')).toEqual(['sessions']);
        expect(byRegion('stage')).toEqual(['transcript', 'composer']);
        expect(byRegion('aside')).toEqual(['tools', 'scratch', 'settings']);
    });

    it('stacks the status chips brand, job, instruments, transport', () => {
        const { instance } = createTestWorkbench();

        const chips = instance.slot<StatusValue>(STATUS_SLOT);
        expect(chips.map((contribution) => [contribution.id, contribution.order])).toEqual([
            ['layout.brand', 10],
            ['sessions.active', 15],
            ['tools.count', 20],
            ['source.phase', 30]
        ]);
    });

    it('renders a panel from a plugin the shell has never heard of', () => {
        // The versatility claim, stated as a test: adding a capability requires
        // no shell edit and no edit to any other plugin.
        const annex: DashboardPlugin = {
            id: 'annex',
            setup(api) {
                api.slot<PanelValue>(PANEL_SLOT, {
                    id: 'annex',
                    order: 5,
                    value: {
                        title: 'Annex',
                        region: 'sidebar',
                        component: () => null
                    }
                });
            }
        };

        const { instance } = createTestWorkbench({ extraPlugins: [annex] });

        expect(instance.slot<PanelValue>(PANEL_SLOT).map((contribution) => contribution.id)).toEqual([
            'annex',
            'tools',
            'sessions',
            'transcript',
            'composer',
            'scratch',
            'settings'
        ]);
    });

    it('drops the pending stream timer when the dashboard is disposed', () => {
        const { instance, clock } = createTestWorkbench();
        instance.execute<{ sessionId: string; text: string }, string>(SOURCE_SEND_COMMAND, {
            sessionId: 'session-ops',
            text: 'Ping'
        });
        expect(clock.pending()).toBe(1);

        instance.dispose();

        // The source plugin's returned disposer ran: nothing is left scheduled.
        expect(clock.pending()).toBe(0);
    });
});
