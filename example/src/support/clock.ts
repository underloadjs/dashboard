// Virtual clock seam for the example's simulated transport.
//
// The source plugin never calls setTimeout directly: it schedules through a
// `Clock` service-shaped seam, so the SAME engine is
//
//   - live in the browser (realClock: word chunks arrive every N ms, which is
//     what makes the station feel like a running job), and
//   - deterministic in tests (createManualClock: nothing moves until the test
//     advances it, so assertions are exact rather than waitFor/poll-based).
//
// This is an example-local seam, not part of the published core: the core stays
// free of timers, DOM, and network.
export type Clock = {
    /** Current virtual time in ms (used for message timestamps). */
    now(): number;
    /** Runs `task` after `delayMs`; returns a cancel function (idempotent). */
    schedule(task: () => void, delayMs: number): () => void;
};

// Real time: browser/dev-server behaviour, straight from the host timers.
export const realClock: Clock = {
    now: () => Date.now(),
    schedule: (task, delayMs) => {
        const timer = setTimeout(task, delayMs);
        return () => clearTimeout(timer);
    }
};

// A clock a test drives by hand.
export type ManualClock = Clock & {
    /** Runs every due task in chronological order, then moves time to now+ms. */
    advance(ms: number): void;
    /** Tasks still waiting (lets a test assert "the stream really stopped"). */
    pending(): number;
    /** Drops all waiting tasks without running them. */
    cancelAll(): void;
};

// Guard against a self-rescheduling task looping forever inside one advance().
// The source engine reschedules with a fixed positive delay, so its next due
// time is always beyond the current advance target; hitting this bound means a
// future plugin scheduled with delay 0 and would otherwise hang the suite.
const MAX_TASKS_PER_ADVANCE = 1000;

type PendingTask = { id: number; due: number; task: () => void };

export function createManualClock(startMs = 0): ManualClock {
    let time = startMs;
    let sequence = 0;
    const queue: PendingTask[] = [];

    // Insertion keeps due-time order, breaking ties by submission order, which
    // is what makes the streamed chunks arrive in a stable sequence.
    const insert = (entry: PendingTask): void => {
        queue.push(entry);
        queue.sort((a, b) => a.due - b.due || a.id - b.id);
    };

    return {
        now: () => time,
        schedule: (task, delayMs) => {
            sequence += 1;
            const id = sequence;
            insert({ id, due: time + Math.max(0, delayMs), task });
            return () => {
                const index = queue.findIndex((entry) => entry.id === id);
                if (index >= 0) queue.splice(index, 1);
            };
        },
        advance: (ms) => {
            const target = time + Math.max(0, ms);
            let executed = 0;
            while (queue.length > 0 && queue[0].due <= target) {
                const next = queue.shift() as PendingTask;
                // Time only moves forward, to the moment the task was due.
                time = Math.max(time, next.due);
                next.task();
                executed += 1;
                if (executed >= MAX_TASKS_PER_ADVANCE) {
                    throw new Error(
                        `Manual clock ran ${MAX_TASKS_PER_ADVANCE} tasks in a single advance() — a task is rescheduling with no delay`
                    );
                }
            }
            time = target;
        },
        pending: () => queue.length,
        cancelAll: () => {
            queue.length = 0;
        }
    };
}
