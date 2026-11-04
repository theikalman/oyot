import { describe, it, expect } from 'vitest';
import { dropIndex, edgeScroll, rowOffset } from './reorder';

describe('dropIndex', () => {
    // Four rows 30px apart.
    const centers = [15, 45, 75, 105];

    it('stays put until the row passes the middle of the next one', () => {
        expect(dropIndex(centers, 1, 44)).toBe(1);
        expect(dropIndex(centers, 1, 74)).toBe(1);
        expect(dropIndex(centers, 1, 76)).toBe(2);
    });

    it('moves up past the middle of the row above', () => {
        expect(dropIndex(centers, 2, 46)).toBe(2);
        expect(dropIndex(centers, 2, 44)).toBe(1);
    });

    it('reaches both ends', () => {
        expect(dropIndex(centers, 2, -50)).toBe(0);
        expect(dropIndex(centers, 1, 500)).toBe(3);
    });

    it('does not count the row against itself', () => {
        expect(dropIndex(centers, 0, 15)).toBe(0);
        expect(dropIndex(centers, 3, 105)).toBe(3);
    });
});

describe('rowOffset', () => {
    it('moves the rows a row passed going down up a place', () => {
        const offsets = [0, 1, 2, 3].map((i) => rowOffset(i, 0, 2, 30));

        expect(offsets).toEqual([0, -30, -30, 0]);
    });

    it('moves the rows a row passed going up down a place', () => {
        const offsets = [0, 1, 2, 3].map((i) => rowOffset(i, 3, 1, 30));

        expect(offsets).toEqual([0, 30, 30, 0]);
    });

    it('moves nothing for a row that has not gone anywhere', () => {
        const offsets = [0, 1, 2].map((i) => rowOffset(i, 1, 1, 30));

        expect(offsets).toEqual([0, 0, 0]);
    });
});

describe('edgeScroll', () => {
    const FRAME = 16;

    it('leaves the middle of the list alone', () => {
        expect(edgeScroll(300, 0, 600, FRAME)).toBe(0);
    });

    it('scrolls up near the top and down near the bottom', () => {
        expect(edgeScroll(10, 0, 600, FRAME)).toBeLessThan(0);
        expect(edgeScroll(590, 0, 600, FRAME)).toBeGreaterThan(0);
    });

    it('goes faster nearer the edge', () => {
        expect(edgeScroll(595, 0, 600, FRAME)).toBeGreaterThan(edgeScroll(560, 0, 600, FRAME));
    });

    // A finger can leave the sidebar with the row still up.
    it('goes no faster than its limit past the edge', () => {
        expect(edgeScroll(5000, 0, 600, FRAME)).toBe(edgeScroll(600, 0, 600, FRAME));
        expect(edgeScroll(-5000, 0, 600, FRAME)).toBe(edgeScroll(0, 0, 600, FRAME));
    });

    // A tablet at 120Hz gets twice the frames of a laptop at 60Hz.
    it('covers about the same ground at any refresh rate', () => {
        const overASecond = (hz: number) => hz * edgeScroll(600, 0, 600, 1000 / hz);

        expect(Math.abs(overASecond(120) - overASecond(60))).toBeLessThan(overASecond(60) * 0.15);
    });

    it('always moves at least a pixel, which could otherwise be rounded away', () => {
        expect(edgeScroll(557, 0, 600, 1)).toBe(1);
        expect(edgeScroll(43, 0, 600, 1)).toBe(-1);
    });
});
