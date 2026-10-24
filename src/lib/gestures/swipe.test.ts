import { describe, expect, it } from 'vitest';
import { swipeDirection } from './swipe';
import { pinchDirection } from './pinch';

describe('swipeDirection', () => {
    it('reads a quick sideways stroke as a swipe', () => {
        expect(swipeDirection(300, 400, 120, 410, 200)).toBe('left');
        expect(swipeDirection(40, 400, 260, 380, 200)).toBe('right');
    });

    it('leaves a short stroke alone, which is a tap or a slip', () => {
        expect(swipeDirection(200, 400, 160, 400, 100)).toBeNull();
    });

    it('leaves a scroll alone, even one that drifts sideways', () => {
        expect(swipeDirection(200, 600, 120, 300, 250)).toBeNull();
    });

    it('leaves a slow drag alone', () => {
        expect(swipeDirection(300, 400, 100, 400, 1200)).toBeNull();
    });
});

describe('pinchDirection', () => {
    it('reads fingers spreading as out and closing as in', () => {
        expect(pinchDirection(100, 140)).toBe('out');
        expect(pinchDirection(100, 70)).toBe('in');
    });

    it('waits until the fingers have moved enough', () => {
        expect(pinchDirection(100, 110)).toBeNull();
        expect(pinchDirection(0, 50)).toBeNull();
    });
});
