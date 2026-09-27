import { describe, it, expect } from 'vitest';
import { placeBesideCaret, POPUP_MAX_HEIGHT, POPUP_MAX_WIDTH } from './popupPlacement';

// A phone in portrait: 375px wide and 812px tall. The caret is one line high
// and, unless a test says otherwise, at the start of a line of the editor.
const WHOLE = { top: 0, bottom: 812, left: 0, right: 375, viewportHeight: 812 };
const at = (top: number, left = 24) => ({ top, bottom: top + 20, left });

describe('placeBesideCaret, up and down', () => {
    it('opens below the caret when it fits there', () => {
        expect(placeBesideCaret(at(200), WHOLE)).toMatchObject({
            top: 228,
            bottom: null,
            maxHeight: POPUP_MAX_HEIGHT,
        });
    });

    // The keyboard up, and the caret kept in view at the bottom of what is
    // left: 476px on Android, where the WebView ends at the keyboard.
    it('opens above the caret when the space below is too short', () => {
        const aboveKeyboard = { ...WHOLE, bottom: 476, viewportHeight: 476 };

        expect(placeBesideCaret(at(450), aboveKeyboard)).toMatchObject({
            top: null,
            bottom: 476 - 442,
            maxHeight: POPUP_MAX_HEIGHT,
        });
    });

    it('stays below while it fits there, even with more room above', () => {
        const placement = placeBesideCaret(at(450), WHOLE);

        expect(placement.top).toBe(478);
        expect(placement.maxHeight).toBe(POPUP_MAX_HEIGHT);
    });

    // A phone in landscape with the keyboard up has room for neither.
    it('takes the roomier side and is no taller than the room there', () => {
        const short = { ...WHOLE, bottom: 180, viewportHeight: 180 };

        expect(placeBesideCaret(at(100), short)).toMatchObject({
            top: null,
            bottom: 180 - 92,
            maxHeight: 84,
        });
        expect(placeBesideCaret(at(40), short)).toMatchObject({
            top: 68,
            bottom: null,
            maxHeight: 104,
        });
    });

    // iOS draws its keyboard over the viewport without shrinking it: only the
    // visual viewport knows the bottom 336px cannot be seen.
    it('goes by what can be seen, and measures bottom from the whole viewport', () => {
        const coveredBelow = { ...WHOLE, bottom: 476 };

        expect(placeBesideCaret(at(450), coveredBelow)).toMatchObject({
            top: null,
            bottom: 812 - 442,
            maxHeight: POPUP_MAX_HEIGHT,
        });
    });

    // Zoomed in, or scrolled by the keyboard, the part on screen does not
    // start at the top of the viewport.
    it('does not count room above that is scrolled out of sight', () => {
        const scrolled = { ...WHOLE, top: 300, bottom: 776 };

        expect(placeBesideCaret(at(560), scrolled)).toMatchObject({
            top: null,
            bottom: 812 - 552,
            maxHeight: 552 - 308,
        });
    });
});

describe('placeBesideCaret, side to side', () => {
    it('starts where the caret is', () => {
        expect(placeBesideCaret(at(200), WHOLE)).toMatchObject({
            left: 24,
            roomRight: 375 - 8 - 24,
        });
    });

    // The popup is at least 280px wide, and a caret at 334px left it 33px
    // before the edge. Moving it left is the browser's to do, by however much
    // wider than that it turns out to be, so this only has to say how far.
    it('says how little room there is right of a caret near the edge', () => {
        expect(placeBesideCaret(at(200, 334), WHOLE)).toMatchObject({
            left: 334,
            roomRight: 33,
        });
    });

    it('is no wider than can be seen', () => {
        expect(placeBesideCaret(at(200), WHOLE).maxWidth).toBe(375 - 16);
        expect(placeBesideCaret(at(200), { ...WHOLE, right: 320 }).maxWidth).toBe(320 - 16);
        expect(placeBesideCaret(at(200), { ...WHOLE, right: 1024 }).maxWidth).toBe(POPUP_MAX_WIDTH);
    });

    it('keeps clear of the left edge', () => {
        expect(placeBesideCaret(at(200, 2), WHOLE).left).toBe(8);
    });

    // Zoomed in, the part on screen does not start at the left of the viewport.
    it('goes by what can be seen across as well', () => {
        const zoomed = { ...WHOLE, left: 100, right: 287 };

        expect(placeBesideCaret(at(200, 250), zoomed)).toMatchObject({
            left: 250,
            roomRight: 287 - 8 - 250,
            maxWidth: 187 - 16,
        });
        expect(placeBesideCaret(at(200, 50), zoomed).left).toBe(108);
    });
});
