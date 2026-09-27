import { describe, it, expect } from 'vitest';
import { placeBesideCaret, POPUP_MAX_HEIGHT } from './popupPlacement';

// A phone in portrait: 812px tall, the caret one line high.
const WHOLE = { top: 0, bottom: 812, viewportHeight: 812 };
const line = (top: number) => ({ top, bottom: top + 20 });

describe('placeBesideCaret', () => {
    it('opens below the caret when it fits there', () => {
        expect(placeBesideCaret(line(200), WHOLE)).toEqual({
            top: 228,
            bottom: null,
            maxHeight: POPUP_MAX_HEIGHT,
        });
    });

    // The keyboard up, and the caret kept in view at the bottom of what is
    // left: 476px on Android, where the WebView ends at the keyboard.
    it('opens above the caret when the space below is too short', () => {
        const aboveKeyboard = { top: 0, bottom: 476, viewportHeight: 476 };

        expect(placeBesideCaret(line(450), aboveKeyboard)).toEqual({
            top: null,
            bottom: 476 - 442,
            maxHeight: POPUP_MAX_HEIGHT,
        });
    });

    it('stays below while it fits there, even with more room above', () => {
        const placement = placeBesideCaret(line(450), WHOLE);

        expect(placement.top).toBe(478);
        expect(placement.maxHeight).toBe(POPUP_MAX_HEIGHT);
    });

    // A phone in landscape with the keyboard up has room for neither.
    it('takes the roomier side and is no taller than the room there', () => {
        const short = { top: 0, bottom: 180, viewportHeight: 180 };

        expect(placeBesideCaret(line(100), short)).toEqual({
            top: null,
            bottom: 180 - 92,
            maxHeight: 84,
        });
        expect(placeBesideCaret(line(40), short)).toEqual({
            top: 68,
            bottom: null,
            maxHeight: 104,
        });
    });

    // iOS draws its keyboard over the viewport without shrinking it: only the
    // visual viewport knows the bottom 336px cannot be seen.
    it('goes by what can be seen, and measures bottom from the whole viewport', () => {
        const coveredBelow = { top: 0, bottom: 476, viewportHeight: 812 };

        expect(placeBesideCaret(line(450), coveredBelow)).toEqual({
            top: null,
            bottom: 812 - 442,
            maxHeight: POPUP_MAX_HEIGHT,
        });
    });

    // Zoomed in, or scrolled by the keyboard, the part on screen does not
    // start at the top of the viewport.
    it('does not count room above that is scrolled out of sight', () => {
        const scrolled = { top: 300, bottom: 776, viewportHeight: 812 };

        expect(placeBesideCaret(line(560), scrolled)).toEqual({
            top: null,
            bottom: 812 - 552,
            maxHeight: 552 - 308,
        });
    });
});
