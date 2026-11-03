// Test harness for the example suite.
//
// Every test composes the REAL example (createWorkstation -> dashboard() with the
// eight plugins) and only swaps the transport's timer seam for a manual clock.
// That is the whole determinism story for this suite: nothing polls, nothing
// waits, and every streamed chunk boundary is a value the test chose.
import type { Dashboard } from '@underload/dashboard';
import { createWorkstation, type WorkstationOptions } from '../app/composition';
import { createManualClock, type ManualClock } from '../support/clock';

// Deliberately different from the browser defaults (40ms) so a test that
// forgets to advance the clock cannot accidentally pass on real timers.
export const TEST_CHUNK_DELAY_MS = 10;
export const TEST_CHUNK_WORDS = 3;

export type TestWorkbench = {
    instance: Dashboard;
    clock: ManualClock;
};

export function createTestWorkbench(options: Omit<WorkstationOptions, 'clock'> = {}): TestWorkbench {
    const clock = createManualClock(0);
    const instance = createWorkstation({
        sourceChunkDelayMs: TEST_CHUNK_DELAY_MS,
        sourceChunkWords: TEST_CHUNK_WORDS,
        ...options,
        // `clock` is applied after the spread so no caller can lose the seam.
        clock
    });
    return { instance, clock };
}

/** The exact text a fixture reply takes for a given prompt and instrument set. */
export const expectedReply = (prompt: string, instruments: readonly string[]): string =>
    `Log slice is consistent: ${prompt} checked against ${instruments.join(', ')}.`;
