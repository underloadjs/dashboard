// Composition root for the example: one dashboard() call, eight plugins.
//
// This is the "every part is a plugin" claim made visible — the shell is
// feature-blind and every capability (layout, theme, transport/source, sessions,
// transcript, composer, instruments, scratch) arrives through the same
// DashboardPlugin contract.
//
// ORDER MATTERS (documented because a future contributor will hit it):
//
//   tools    before  source     source.setup() takes the `tools.api` service
//   sessions+source before composer  composer.setup() takes both facades
//
// Every plugin also declares `requires`, so the core rejects a bad order rather
// than letting a service lookup return undefined. Listing them in an already
// valid order is deliberate: it behaves the same whether the core topologically
// sorts by `requires` or merely validates the given order.
//
// The `clock` option is the test seam. Browser runs use realClock (word chunks
// arrive over time); tests pass a manual clock, so "streamed" output becomes a
// deterministic, exactly-countable sequence instead of a waitFor().
import { dashboard, type Dashboard, type DashboardPlugin } from '@underload/dashboard';
import type { Clock } from '../support/clock';
import { createComposerPlugin } from '../plugins/composer';
import { createLayoutPlugin } from '../plugins/layout';
import { createScratchPlugin } from '../plugins/scratch';
import { createSessionsPlugin } from '../plugins/sessions';
import { createSourcePlugin } from '../plugins/source';
import { createThemePlugin } from '../plugins/theme';
import { createToolsPlugin } from '../plugins/tools';
import { createTranscriptPlugin } from '../plugins/transcript';

export type WorkstationOptions = {
    /** Timer seam for the simulated transport (default: realClock). */
    clock?: Clock;
    /** ms between streamed word chunks; smaller makes the demo snappier. */
    sourceChunkDelayMs?: number;
    /** words delivered per chunk. */
    sourceChunkWords?: number;
    /**
     * Capability add-ons appended after the eight built-ins. The shell test uses
     * it to prove the shell really is feature-blind: a panel from a plugin the
     * shell has never heard of still renders, in slot order, with no edit here.
     */
    extraPlugins?: readonly DashboardPlugin[];
};

export function createWorkstation(options: WorkstationOptions = {}): Dashboard {
    // A mutable array satisfies both a `DashboardPlugin[]` and a
    // `readonly DashboardPlugin[]` parameter, so the call site cannot break on
    // that detail of the core's input type.
    const plugins: DashboardPlugin[] = [
        createLayoutPlugin(),
        createThemePlugin(),
        createToolsPlugin(),
        createSourcePlugin({
            clock: options.clock,
            chunkDelayMs: options.sourceChunkDelayMs,
            chunkWords: options.sourceChunkWords
        }),
        createSessionsPlugin(),
        createTranscriptPlugin(),
        createComposerPlugin(),
        createScratchPlugin(),
        // Add-ons come last: they can depend on every built-in capability, and
        // no built-in can depend on them.
        ...(options.extraPlugins ?? [])
    ];

    return dashboard({ plugins });
}
