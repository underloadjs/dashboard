// Mount/teardown seam for the example (extracted from main.tsx so the lifecycle
// is testable instead of only asserted by eye in a browser).
//
// The order inside cleanup() is the whole point:
//
//   1. root.unmount()   — React unsubscribes from every dashboard state first, so
//                         no listener can fire into a tree that is already gone;
//   2. instance.dispose() — only then does the core run the plugin disposers,
//                         which is what drops the transport's pending timers.
//
// Reversing the two leaves a window where a timer tick notifies an unmounted
// component (React warning, and in a bundler-hot-reload loop it accumulates
// orphaned streams). cleanup() is idempotent because HMR disposal and a manual
// teardown can both fire for the same handle.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Dashboard } from '@underload/dashboard';
import { createWorkstation, type WorkstationOptions } from './composition';
import { WorkstationShell } from './WorkstationShell';

export type StationHandle = {
    /** The composed dashboard, exposed so a test can drive commands directly. */
    instance: Dashboard;
    /** Unmount, then dispose. Safe to call more than once. */
    cleanup(): void;
};

export function mountStation(container: HTMLElement, options: WorkstationOptions = {}): StationHandle {
    const instance = createWorkstation(options);
    const root = createRoot(container);

    root.render(
        <StrictMode>
            <WorkstationShell instance={instance} />
        </StrictMode>
    );

    let closed = false;

    return {
        instance,
        cleanup: () => {
            if (closed) return;
            closed = true;
            root.unmount();
            instance.dispose();
        }
    };
}
