// Layout plugin: declares the workspace shape and contributes the wordmark.
//
// It owns no state — the layout is configuration, not something the operator
// mutates at runtime — and publishes it as two services (`layout.brand`,
// `layout.regions`) plus one STATUS_SLOT contribution. The shell reads them and
// renders; that is the whole reason the shell has no feature list.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    BRAND_CHIP,
    LAYOUT_BRAND_SERVICE,
    LAYOUT_REGIONS_SERVICE,
    PLUGIN_IDS,
    STATUS_SLOT,
    type BrandSpec,
    type RegionSpec,
    type StatusValue
} from '../app/contract';
import { BrandChip } from '../components/StatusStrip';
import { DEMO_NOTICE } from '../data/fixtures';

// Rail, stage, aside — the three-region workstation. `order` is the visual order
// on wide screens; workstation.css re-orders them into a single column on
// narrow ones, so the declaration stays about meaning, not pixels.
const REGIONS: readonly RegionSpec[] = [
    { id: 'sidebar', label: 'Session rail', order: 10 },
    { id: 'stage', label: 'Work stage', order: 20 },
    { id: 'aside', label: 'Instrument aside', order: 30 }
];

const BRAND: BrandSpec = {
    name: 'Underload Workstation',
    tagline: 'Plugin-composed example — every panel below registered itself',
    notice: DEMO_NOTICE
};

export function createLayoutPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.layout,
        setup(api) {
            api.service<BrandSpec>(LAYOUT_BRAND_SERVICE, BRAND);
            api.service<readonly RegionSpec[]>(LAYOUT_REGIONS_SERVICE, REGIONS);
            api.slot<StatusValue>(STATUS_SLOT, {
                id: BRAND_CHIP,
                order: 10,
                value: { label: 'Brand', component: BrandChip }
            });
        }
    };
}
