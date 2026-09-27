/**
 * Where a popup opened at the caret goes: the slash menu, and the document
 * link and tag pickers.
 *
 * Below the caret, where it reads naturally, unless there is not room for it
 * there and there is more above. They always opened below, and with a phone's
 * keyboard up that was out of sight: the editor keeps the caret in view while
 * typing, which then puts it at the bottom of what can be seen, so the menu
 * opened under the keyboard, along with the filter showing what was typed.
 */

/** Between the caret and the popup. */
const GAP = 8;
/** Kept clear between the popup and the edge of what can be seen. */
const MARGIN = 8;
/** The tallest a popup is drawn, when there is room for it. */
export const POPUP_MAX_HEIGHT = 320;

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
}

/** What can be seen of the viewport, in the coordinates the caret is measured in. */
export interface VisibleArea {
    top: number;
    bottom: number;
    /** The viewport's whole height, which a CSS `bottom` is measured from. */
    viewportHeight: number;
}

export function placeBesideCaret(
    caret: { top: number; bottom: number },
    area: VisibleArea,
): Placement {
    const roomBelow = area.bottom - MARGIN - (caret.bottom + GAP);
    const roomAbove = caret.top - GAP - (area.top + MARGIN);
    if (roomBelow >= POPUP_MAX_HEIGHT || roomBelow >= roomAbove) {
        return { top: caret.bottom + GAP, bottom: null, maxHeight: fit(roomBelow) };
    }
    return {
        top: null,
        bottom: area.viewportHeight - (caret.top - GAP),
        maxHeight: fit(roomAbove),
    };
}

function fit(room: number): number {
    return Math.max(0, Math.min(POPUP_MAX_HEIGHT, room));
}

/** Places a `position: fixed` popup beside the caret, in what can be seen now. */
export function placePopup(host: HTMLElement, caret: { top: number; bottom: number }): void {
    const { top, bottom, maxHeight } = placeBesideCaret(caret, visibleArea());
    host.style.top = top === null ? 'auto' : `${top}px`;
    host.style.bottom = bottom === null ? 'auto' : `${bottom}px`;
    host.style.setProperty('--popup-max-height', `${maxHeight}px`);
}

function visibleArea(): VisibleArea {
    const viewportHeight = document.documentElement.clientHeight;
    // The part of the viewport actually on screen. Less than all of it when
    // something covers the page without resizing it, as iOS's keyboard does,
    // and as zooming in does.
    const vv = window.visualViewport;
    if (!vv) return { top: 0, bottom: viewportHeight, viewportHeight };
    return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height, viewportHeight };
}
