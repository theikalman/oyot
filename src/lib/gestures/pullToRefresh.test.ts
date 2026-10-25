import { describe, it, expect } from 'vitest';
import { damp, PULL_THRESHOLD } from './pullToRefresh';

describe('damp', () => {
    it('moves the list half as far as the finger, and no further than a stop', () => {
        expect(damp(-20)).toBe(0);
        expect(damp(100)).toBe(50);
        expect(damp(1000)).toBe(120);
    });

    it('needs a deliberate pull to count', () => {
        expect(damp(100)).toBeLessThan(PULL_THRESHOLD);
        expect(damp(160)).toBeGreaterThanOrEqual(PULL_THRESHOLD);
    });
});
