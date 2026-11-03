import { describe, expect, it } from 'vitest';

describe('probe', () => {
    it('reveals module url facts via a deliberate string mismatch', () => {
        const g = globalThis as unknown as Record<string, unknown>;
        expect(
            JSON.stringify({
                url: import.meta.url,
                cwd: process.cwd(),
                filename: String(g['__filename']),
            })
        ).toBe('');
    });
});
