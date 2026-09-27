/**
 * Where a popup opened at the caret goes: the slash menu, and the document
 * link and tag pickers.
 *
 * Below the caret, where it reads naturally, unless there is not room for it
 * there and there is more above. They always opened below, and with a phone's
 * keyboard up that was out of sight: the editor keeps the caret in view while
 * typing, which then puts it at the bottom of what can be seen, so the menu
 * opened under the keyboard, along with the filter showing what was typed.
 *
 * Starting where the caret is, unless that would take it past the right edge,
 * and then moved left just far enough to fit. A phone is not much wider than
 * the popup, so one opened at a caret near the right edge ran off the screen
 * with only its icons showing.
 */

/** Between the caret and the popup. */
const GAP = 8;
/** Kept clear between the popup and the edge of what can be seen. */
const MARGIN = 8;
/** The tallest a popup is drawn, when there is room for it. */
export const POPUP_MAX_HEIGHT = 320;
/** The widest a popup is drawn, when there is room for it. */
export const POPUP_MAX_WIDTH = 400;

export interface Placement {
    /** From the top of the viewport, for a popup below the caret. */
    top: number | null;
    /**
     * From the bottom of the viewport, for a popup above the caret. Anchored
     * by its bottom edge, it grows upwards when its list does, rather than
     * down over the line being typed.
     */
    bottom: number | null;
    /** As tall as it can be without leaving what can be seen. */
    maxHeight: number;
    /** From the left of the viewport: where the caret is, clear of the edge. */
    left: number;
    /**
     * How far right of `left` the popup can reach and still be seen. One
     * wider than this is moved left by the difference, which only its own
     * width decides (see placePopup).
     */
    roomRight: number;
    /** As wide as it can be without leaving what can be seen. */
    maxWidth: number;
}

/** What can be seen of the viewport, in the coordinates the caret is measured in. */
export interface VisibleArea {
    top: number;
    bottom: number;
    left: number;
    right: number;
    /** The viewport's whole height, which a CSS `bottom` is measured from. */
    viewportHeight: number;
}

export interface CaretRect {
    top: number;
    bottom: number;
    left: number;
}

export function placeBesideCaret(caret: CaretRect, area: VisibleArea): Placement {
    const left = Math.max(caret.left, area.left + MARGIN);
    const across = {
        left,
        roomRight: area.right - MARGIN - left,
        maxWidth: fit(area.right - area.left - 2 * MARGIN, POPUP_MAX_WIDTH),
    };

    const roomBelow = area.bottom - MARGIN - (caret.bottom + GAP);
    const roomAbove = caret.top - GAP - (area.top + MARGIN);
    if (roomBelow >= POPUP_MAX_HEIGHT || roomBelow >= roomAbove) {
        return {
            top: caret.bottom + GAP,
            bottom: null,
            maxHeight: fit(roomBelow, POPUP_MAX_HEIGHT),
            ...across,
        };
    }
    return {
        top: null,
        bottom: area.viewportHeight - (caret.top - GAP),
        maxHeight: fit(roomAbove, POPUP_MAX_HEIGHT),
        ...across,
    };
}

function fit(room: number, most: number): number {
    return Math.max(0, Math.min(most, room));
}

/** Places a `position: fixed` popup beside the caret, in what can be seen now. */
export function placePopup(host: HTMLElement, caret: CaretRect): void {
    const p = placeBesideCaret(caret, visibleArea());
    host.style.top = p.top === null ? 'auto' : `${p.top}px`;
    host.style.bottom = p.bottom === null ? 'auto' : `${p.bottom}px`;
    host.style.left = `${p.left}px`;
    // Moved left by however much wider it is than the room to its right. Its
    // width changes as its list is filtered, and a percentage in a transform
    // is of the element's own width, so the browser works the move out afresh
    // whenever it lays the popup out.
    host.style.transform = `translateX(min(0px, calc(${p.roomRight}px - 100%)))`;
    host.style.setProperty('--popup-max-height', `${p.maxHeight}px`);
    host.style.setProperty('--popup-max-width', `${p.maxWidth}px`);
}

function visibleArea(): VisibleArea {
    const root = document.documentElement;
    const viewportHeight = root.clientHeight;
    // The part of the viewport actually on screen. Less than all of it when
    // something covers the page without resizing it, as iOS's keyboard does,
    // and as zooming in does.
    const vv = window.visualViewport;
    if (!vv) {
        return { top: 0, bottom: viewportHeight, left: 0, right: root.clientWidth, viewportHeight };
    }
    return {
        top: vv.offsetTop,
        bottom: vv.offsetTop + vv.height,
        left: vv.offsetLeft,
        right: vv.offsetLeft + vv.width,
        viewportHeight,
    };
}
