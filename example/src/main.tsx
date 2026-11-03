// Example entry point: find the mount point, mount, and wire hot reload.
//
// Everything with behaviour lives in app/entry.tsx (mountStation) so the
// lifecycle — including the unmount-before-dispose teardown order and the timer
// release — is covered by a test (app/entry.test.tsx) rather than only visible
// in a browser.
import { mountStation } from './app/entry';
import './styles/workstation.css';

const container = document.getElementById('root');
if (container === null) {
    // example/index.html is part of this app, so a missing #root is a broken
    // build rather than a runtime condition to degrade around.
    throw new Error('example/index.html is missing the #root element');
}

// Real timers here: the browser demo streams word chunks over time.
const station = mountStation(container);

// Vite HMR: the incoming module replaces this one, so the outgoing app must be
// torn down first (React, then the core) or every reload leaks a dashboard with
// its own pending chunk timers.
if (import.meta.hot) {
    import.meta.hot.dispose(() => station.cleanup());
}
