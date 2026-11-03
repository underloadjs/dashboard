// Instruments plugin: catalogue + live selection.
//
// The catalogue is fixture data published through the `tools.api` service; the
// selection is observable state (`tools.enabled`). Two rules keep behaviour
// predictable instead of incidental:
//
//   - the enabled list is always stored in CATALOGUE order, so a streamed
//     line like "queued read, pulse" reads identically however the operator
//     clicked;
//   - an unknown instrument id throws, so a typo surfaces instead of quietly
//     doing nothing.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    PANEL_SLOT,
    PLUGIN_IDS,
    STATUS_SLOT,
    TOOLS_API_SERVICE,
    TOOLS_CHIP,
    TOOLS_PANEL,
    TOOLS_RESET_COMMAND,
    TOOLS_STATE,
    TOOLS_TOGGLED_EVENT,
    TOOLS_TOGGLE_COMMAND,
    type PanelValue,
    type StatusValue,
    type ToolSpec,
    type ToolsApi
} from '../app/contract';
import { ToolRack } from '../components/ToolRack';
import { ToolsChip } from '../components/StatusStrip';
import { TOOL_CATALOGUE } from '../data/fixtures';

// Derived once from the fixture data: 'read' and 'pulse' start live.
const DEFAULT_ENABLED: readonly string[] = TOOL_CATALOGUE.filter((tool) => tool.enabledByDefault).map(
    (tool) => tool.id
);

// Re-sorts any selection into catalogue order (the rule documented above).
const inCatalogueOrder = (ids: readonly string[]): string[] =>
    TOOL_CATALOGUE.filter((tool) => ids.includes(tool.id)).map((tool) => tool.id);

const findTool = (id: string): ToolSpec => {
    const tool = TOOL_CATALOGUE.find((entry) => entry.id === id);
    if (tool === undefined) {
        throw new Error(`Unknown instrument: ${id}`);
    }
    return tool;
};

export function createToolsPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.tools,
        setup(api) {
            const enabled = api.state<readonly string[]>(TOOLS_STATE, [...DEFAULT_ENABLED]);

            // The facade closes over `enabled`, so callers always read the live
            // selection — including the source plugin, which composes every
            // simulated reply from it.
            api.service<ToolsApi>(TOOLS_API_SERVICE, {
                catalogue: () => TOOL_CATALOGUE,
                enabled: () => enabled.get(),
                isEnabled: (id) => enabled.get().includes(id)
            });

            api.command<string, boolean>(TOOLS_TOGGLE_COMMAND, (id) => {
                findTool(id);
                const previous = enabled.get();
                const live = !previous.includes(id);
                enabled.set(inCatalogueOrder(live ? [...previous, id] : previous.filter((entry) => entry !== id)));
                api.emit(TOOLS_TOGGLED_EVENT, { id, enabled: live });
                return live;
            });

            api.command<void, readonly string[]>(TOOLS_RESET_COMMAND, () => {
                enabled.set([...DEFAULT_ENABLED]);
                return enabled.get();
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: TOOLS_PANEL,
                order: 10,
                value: {
                    title: 'Instruments',
                    region: 'aside',
                    hint: `${TOOL_CATALOGUE.length} simulated`,
                    component: ToolRack
                }
            });

            api.slot<StatusValue>(STATUS_SLOT, {
                id: TOOLS_CHIP,
                order: 20,
                value: { label: 'Instruments', component: ToolsChip }
            });
        }
    };
}
