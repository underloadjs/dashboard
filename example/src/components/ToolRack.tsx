// Instrument rack: catalogue view + per-instrument toggle.
//
// The selection is core state (`tools.enabled`), read here through the
// `tools.api` service for the catalogue and through state for the live set.
// Toggling changes the wording of every subsequent simulated reply (the source
// plugin asks `tools.api.enabled()` when it composes a response), so this rack
// is a capability with an observable effect, not a decorative switch list.
import {
    TOOLS_API_SERVICE,
    TOOLS_RESET_COMMAND,
    TOOLS_STATE,
    TOOLS_TOGGLE_COMMAND,
    type ToolsApi
} from '../app/contract';
import { useDashboardService, useDashboardValue } from '../app/state-hooks';
import { useWorkbench } from '../app/workbench';

export function ToolRack() {
    const instance = useWorkbench();
    const enabled = useDashboardValue<readonly string[]>(TOOLS_STATE);
    const catalogue = useDashboardService<ToolsApi>(TOOLS_API_SERVICE).catalogue();

    return (
        <div className="rack">
            <ul className="rack__list" aria-label="Instrument catalogue">
                {catalogue.map((tool) => {
                    const live = enabled.includes(tool.id);
                    return (
                        <li key={tool.id} className="rack__entry" data-tool={tool.id}>
                            <button
                                type="button"
                                className={live ? 'rack__item is-live' : 'rack__item'}
                                // aria-pressed makes the on/off semantics available
                                // without colour, and gives the test an exact name.
                                aria-pressed={live}
                                aria-label={`${tool.label} instrument`}
                                onClick={() => instance.execute<string, boolean>(TOOLS_TOGGLE_COMMAND, tool.id)}
                            >
                                <span className="rack__name">{tool.label}</span>
                                <span className="rack__state">{live ? 'live' : 'off'}</span>
                            </button>
                            <p className="rack__detail">{tool.detail}</p>
                        </li>
                    );
                })}
            </ul>
            <button
                type="button"
                className="btn btn--ghost"
                aria-label="Restore default instruments"
                // void-input command: the argument is explicit so the call site
                // documents that this command takes no payload.
                onClick={() => instance.execute<void, readonly string[]>(TOOLS_RESET_COMMAND, undefined)}
            >
                Restore defaults
            </button>
        </div>
    );
}
