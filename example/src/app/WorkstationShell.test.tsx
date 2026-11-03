// End-to-end interaction tests for the example workstation.
//
// These are user-visible checks: real DOM clicks, real typing, real streamed
// text, asserted as exact strings. The clock seam (../testing/workbench.ts) is
// what turns "wait for the stream" into a deterministic `advance()` inside
// act(), so nothing here polls and nothing here is flaky by construction.
//
// No jest-dom matchers: assertions stay on plain DOM properties (value,
// disabled, aria-*, dataset) so the suite needs no extra dependency.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkstationShell } from './WorkstationShell';
import { createTestWorkbench } from '../testing/workbench';
import { DEMO_NOTICE, SEED_DRAFT_TEXT } from '../data/fixtures';

// Exact text the fixture transport produces for the seeded draft (default
// instruments 'read' + 'pulse'), written out here instead of rebuilt from the
// plugin's template.
const SEEDED_REPLY =
    'Log slice is consistent: Cross-check the coolant pressure log against the noon readings checked against read, pulse.';
const SEEDED_REPLY_WITH_PLOT =
    'Log slice is consistent: Cross-check the coolant pressure log against the noon readings checked against read, pulse, plot.';

// One chunk (3 words, the test chunk size) — what is on screen after advance(10).
const FIRST_CHUNK = 'Log slice is';

const openStation = () => {
    const workbench = createTestWorkbench();
    const view = render(<WorkstationShell instance={workbench.instance} />);
    return { ...workbench, ...view };
};

const stationElement = (container: HTMLElement) => container.querySelector<HTMLElement>('.station') as HTMLElement;
const phaseChip = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-chip="phase"]') as HTMLElement;
const composerInput = () => screen.getByLabelText('Message the station') as HTMLInputElement;
const transcriptList = (sessionId: string) => screen.getByRole('log', { name: `Transcript for session ${sessionId}` });
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
const selectSession = (title: string) =>
    fireEvent.click(screen.getByRole('button', { name: `Open session ${title}` }));

afterEach(() => {
    cleanup();
});

describe('workstation shell', () => {
    it('renders the composed layout, the status strip, and the demo notice', () => {
        const { clock, container } = openStation();

        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Underload Workstation');
        expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
            'Session rail',
            'Work stage',
            'Instrument aside'
        ]);

        // Placement is produced by the slot data, not by a shell list.
        const panelsIn = (label: string) =>
            Array.from(
                screen
                    .getAllByRole('region')
                    .find((region) => region.getAttribute('aria-label') === label)
                    ?.querySelectorAll<HTMLElement>('[data-panel]') ?? []
            ).map((panel) => panel.dataset.panel as string);

        expect(panelsIn('Session rail')).toEqual(['sessions']);
        expect(panelsIn('Work stage')).toEqual(['transcript', 'composer']);
        expect(panelsIn('Instrument aside')).toEqual(['tools', 'scratch', 'settings']);

        // Panel headings follow the shell's render order: region by region in
        // layout-service order, panels in slot order inside each region.
        expect(Array.from(container.querySelectorAll('h2')).map((heading) => heading.textContent)).toEqual([
            'Sessions',
            'Transcript',
            'Composer',
            'Instruments',
            'Scratch',
            'Settings'
        ]);

        expect(
            Array.from(container.querySelectorAll<HTMLElement>('[data-chip]')).map((chip) => chip.dataset.chip)
        ).toEqual([
            'brand',
            'session',
            'tools',
            'phase'
        ]);
        expect(container.querySelector('[data-chip="brand"]')?.textContent).toBe('Underload Workstation');
        expect(container.querySelector('[data-chip="tools"]')?.textContent).toContain('2 live');
        expect(container.querySelector('[data-chip="session"]')?.textContent).toContain(
            'Station ops · coolant loop'
        );
        expect(phaseChip(container).dataset.phase).toBe('idle');
        expect(phaseChip(container).dataset.streams).toBe('0');
        expect(phaseChip(container).textContent).toContain('IDLE');

        // The chips are a labelled group, not a bare aria-labelled div (a name on
        // a plain div carries no role and is ignored by assistive tech).
        const signal = screen.getByRole('group', { name: 'Station signal' });
        expect(Array.from(signal.querySelectorAll('[data-chip]')).length).toBe(4);

        // The transcript announces from mount, before any content exists: role,
        // aria-live and atomicity are all declared on the empty list.
        const log = transcriptList('session-ops');
        expect(log.getAttribute('aria-live')).toBe('polite');
        expect(log.getAttribute('aria-atomic')).toBe('false');
        expect(log.getAttribute('aria-relevant')).toBe('additions text');
        // …and unchanged once a stream starts, so nothing is re-announced.
        fireEvent.click(sendButton());
        act(() => {
            clock.advance(10);
        });
        const streamingLog = transcriptList('session-ops');
        expect(streamingLog.getAttribute('aria-live')).toBe('polite');
        expect(streamingLog.getAttribute('aria-atomic')).toBe('false');
        expect(streamingLog).toBe(log);

        // The simulation is labelled, never implied.
        expect(container.querySelector('.station__note')?.textContent).toBe(DEMO_NOTICE);
        expect(container.querySelector('[data-panel="tools"]')?.textContent).toContain('4 simulated');

        const station = stationElement(container);
        expect(station.dataset.theme).toBe('ink');
        expect(station.dataset.density).toBe('comfort');
        expect(station.dataset.motion).toBe('full');
    });

    it('keeps a per-session draft while switching jobs', () => {
        const { instance } = openStation();

        expect(composerInput().value).toBe(SEED_DRAFT_TEXT);
        expect(transcriptList('session-ops').textContent).toContain('No traffic yet');
        expect(sendButton().disabled).toBe(false);

        selectSession('Field work · relay array');

        expect(instance.state<string>('sessions.active').get()).toBe('session-array');
        expect(composerInput().value).toBe('');
        expect(sendButton().disabled).toBe(true);
        expect(transcriptList('session-array').textContent).toContain('No traffic yet');
        expect(
            screen.getByRole('button', { name: 'Open session Field work · relay array' }).getAttribute('aria-current')
        ).toBe('true');
    });

    it('sends, streams word-by-word, and seals the response', () => {
        const { clock, container } = openStation();

        fireEvent.click(sendButton());

        expect(composerInput().value).toBe('');
        expect(phaseChip(container).dataset.phase).toBe('running');
        expect(phaseChip(container).textContent).toContain('RUNNING');
        expect(transcriptList('session-ops').textContent).toContain(SEED_DRAFT_TEXT);
        expect(transcriptList('session-ops').textContent).not.toContain(FIRST_CHUNK);
        expect(screen.getByText('Operator').textContent).toBe('Operator');
        // Cancel is armed for exactly this session's in-flight request.
        expect(screen.getByRole('button', { name: 'Cancel running request' }).hasAttribute('disabled')).toBe(false);

        act(() => {
            clock.advance(10);
        });
        expect(transcriptList('session-ops').textContent).toContain(FIRST_CHUNK);

        act(() => {
            clock.advance(1000);
        });
        expect(transcriptList('session-ops').textContent).toContain(SEEDED_REPLY);
        expect(phaseChip(container).dataset.phase).toBe('completed');
        expect(phaseChip(container).textContent).toContain('SEALED');
        expect(screen.getByText('sealed 1')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Follow output' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'Cancel running request' }).hasAttribute('disabled')).toBe(true);
    });

    it('cancels a running response and keeps the partial text', () => {
        const { clock, container } = openStation();

        fireEvent.click(sendButton());
        act(() => {
            clock.advance(10);
        });

        const cancel = screen.getByRole('button', { name: 'Cancel running request' }) as HTMLButtonElement;
        expect(cancel.disabled).toBe(false);
        fireEvent.click(cancel);

        expect(phaseChip(container).dataset.phase).toBe('cancelled');
        expect(phaseChip(container).textContent).toContain('CANCELLED');
        expect(transcriptList('session-ops').textContent).toContain(`${FIRST_CHUNK} (stopped)`);

        act(() => {
            clock.advance(1000);
        });
        // Nothing resumed behind the scenes.
        expect(transcriptList('session-ops').textContent).toContain(`${FIRST_CHUNK} (stopped)`);
        expect(transcriptList('session-ops').textContent).not.toContain(SEEDED_REPLY);
        expect(screen.getByRole('button', { name: 'Cancel running request' }).hasAttribute('disabled')).toBe(true);
        // A cancelled stream still counts as traffic, not as a sealed response.
        expect(screen.getByText('sealed 0')).toBeDefined();
    });

    it('makes the instrument selection change what the station replies', () => {
        const { clock, container } = openStation();

        const plot = screen.getByRole('button', { name: 'Plot instrument' });
        expect(plot.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(plot);

        expect(plot.getAttribute('aria-pressed')).toBe('true');
        expect(container.querySelector('[data-chip="tools"]')?.textContent).toContain('3 live');

        fireEvent.click(sendButton());
        act(() => {
            clock.advance(1000);
        });

        expect(transcriptList('session-ops').textContent).toContain(SEEDED_REPLY_WITH_PLOT);
        expect(transcriptList('session-ops').textContent).toContain('queued read, pulse, plot');

        fireEvent.click(screen.getByRole('button', { name: 'Restore default instruments' }));
        expect(container.querySelector('[data-chip="tools"]')?.textContent).toContain('2 live');
        expect(screen.getByRole('button', { name: 'Plot instrument' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('collapses and re-expands an instrument trace', () => {
        const { clock, container } = openStation();

        fireEvent.click(sendButton());
        act(() => {
            clock.advance(1000);
        });

        const toggle = screen.getByRole('button', { name: 'Trace details' });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');

        const detail = container.querySelector<HTMLElement>('#trace-msg-3');
        expect(detail?.hidden).toBe(false);
        expect(detail?.textContent).toBe(
            'Simulated trace msg-3 · session session-ops · t+0ms · queued read, pulse'
        );

        // A session switch resets the view state, and switching back proves it.
        selectSession('Field work · relay array');
        selectSession('Station ops · coolant loop');
        expect(screen.getByRole('button', { name: 'Trace details' }).getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector<HTMLElement>('#trace-msg-3')?.hidden).toBe(true);
    });

    it('pins and removes scratch notes', () => {
        openStation();

        const pad = () => screen.getByRole('list', { name: 'Scratch notes' });
        expect(pad().textContent).toContain('Recalibrate the amber warning threshold');

        fireEvent.change(screen.getByLabelText('Pin a note'), { target: { value: 'Ship the checklist' } });
        expect((screen.getByLabelText('Pin a note') as HTMLInputElement).value).toBe('Ship the checklist');
        fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

        expect(pad().textContent).toContain('Ship the checklist');
        expect((screen.getByLabelText('Pin a note') as HTMLInputElement).value).toBe('');

        fireEvent.click(screen.getByRole('button', { name: 'Remove Ship the checklist' }));
        expect(pad().textContent).not.toContain('Ship the checklist');
        expect(pad().textContent).toContain('Recalibrate the amber warning threshold');

        fireEvent.click(screen.getByRole('button', { name: 'Clear all notes' }));
        expect(pad().textContent).toContain('Nothing pinned');
    });

    it('re-skins the station from the settings panel', () => {
        const { container } = openStation();

        expect(container.querySelector('.swatches__value')?.textContent).toBe('#0b1418');

        fireEvent.click(screen.getByRole('button', { name: 'Slate' }));
        expect(stationElement(container).dataset.theme).toBe('slate');
        expect(container.querySelector('.swatches__value')?.textContent).toBe('#f2f6f7');
        expect(screen.getByRole('list', { name: 'slate palette' })).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: 'Compact spacing' }));
        expect(stationElement(container).dataset.density).toBe('compact');

        fireEvent.click(screen.getByRole('button', { name: 'Reduce motion' }));
        expect(stationElement(container).dataset.motion).toBe('reduced');
        // 'Ink' returns the station to the default workstation skin.
        fireEvent.click(screen.getByRole('button', { name: 'Ink' }));
        expect(stationElement(container).dataset.theme).toBe('ink');
    });

    it('gives every rendered control an accessible name', () => {
        const { container } = openStation();

        // 18 controls: 2 sessions + New session | Follow output | Send + Cancel |
        // 4 instruments + Restore defaults | Remove + Add + Clear pad |
        // Ink + Slate + Compact spacing + Reduce motion.
        const buttons = Array.from(container.querySelectorAll('button'));
        expect(buttons.length).toBe(18);

        const unnamed = buttons
            .map((button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim())
            .filter((name) => name.length === 0);
        expect(unnamed).toEqual([]);

        // Inputs carry real labels, not placeholder-only affordances.
        expect(screen.getByLabelText('Message the station')).toBeDefined();
        expect(screen.getByLabelText('Pin a note')).toBeDefined();
        expect(container.querySelector('.swatches')).toBeDefined();
    });

    it('runs two jobs at once and keeps every session control honest (D1)', () => {
        const { clock, container } = openStation();

        // Job 1: the seeded session, left streaming.
        fireEvent.click(sendButton());
        act(() => {
            clock.advance(10);
        });

        // Job 2: a brand new session, sent while job 1 is still running.
        fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
        fireEvent.change(composerInput(), { target: { value: 'Relay sweep' } });
        // The new deck is idle even though another job streams: this used to be
        // disarmed by the other session's running record.
        expect(sendButton().disabled).toBe(false);
        fireEvent.click(sendButton());
        act(() => {
            clock.advance(10);
        });

        // The chip follows the session on screen, and says how many jobs stream.
        expect(phaseChip(container).dataset.phase).toBe('running');
        expect(phaseChip(container).dataset.streams).toBe('2');
        expect(phaseChip(container).textContent).toContain('req-2');
        expect(phaseChip(container).textContent).toContain('2 jobs');
        expect(screen.getByRole('button', { name: 'Cancel running request' }).hasAttribute('disabled')).toBe(false);
        expect(transcriptList('session-new-1').textContent).toContain('Telemetry frame decoded');
        // The new session sealed nothing yet, and the old one's tally is separate.
        expect(screen.getByText('sealed 0')).toBeDefined();

        // Switch back to job 1: its own state, its own partial text.
        selectSession('Station ops · coolant loop');
        expect(phaseChip(container).dataset.phase).toBe('running');
        expect(transcriptList('session-ops').textContent).toContain('Log slice is');
        expect(transcriptList('session-ops').textContent).not.toContain('Telemetry frame decoded');
        // Send is armed here (the draft refilled by typing is empty, but the
        // session itself is running, so Send stays disabled while it streams).
        expect(sendButton().disabled).toBe(true);

        // Cancelling job 1 must leave job 2 running. Two chunks had been
        // delivered to job 1 by now (one per advance), so that is the partial
        // text that stays behind.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel running request' }));
        expect(phaseChip(container).dataset.phase).toBe('cancelled');
        expect(phaseChip(container).dataset.streams).toBe('1');
        expect(transcriptList('session-ops').textContent).toContain(
            'Log slice is consistent: Cross-check the (stopped)'
        );

        selectSession('Untitled session 1');
        expect(phaseChip(container).dataset.phase).toBe('running');
        expect(transcriptList('session-new-1').textContent).toContain('Telemetry frame decoded');

        // The surviving job seals while the cancelled one stays cancelled.
        act(() => {
            clock.advance(1000);
        });
        expect(phaseChip(container).dataset.phase).toBe('completed');
        expect(phaseChip(container).dataset.streams).toBe('0');

        selectSession('Station ops · coolant loop');
        expect(phaseChip(container).dataset.phase).toBe('cancelled');
        expect(transcriptList('session-ops').textContent).toContain(
            'Log slice is consistent: Cross-check the (stopped)'
        );
        // Job 1's composer is re-armed for the next message.
        expect(sendButton().disabled).toBe(true); // draft empty
        fireEvent.change(composerInput(), { target: { value: 'Second try' } });
        expect(sendButton().disabled).toBe(false);
        fireEvent.click(sendButton());
        expect(phaseChip(container).dataset.phase).toBe('running');
        expect(phaseChip(container).textContent).toContain('req-3');
    });
});
