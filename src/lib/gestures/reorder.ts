// Picking a row of a list up and putting it down in another place, with a
// mouse or a finger.
//
// Written on pointer and touch events rather than the browser's own drag and
// drop, which touch screens do not have at all. A mouse lifts a row by moving
// it a little. A finger has to hold still first, because a finger moving on a
// list is a scroll: lifting on the move would make the list impossible to
// scroll by its rows, and most of a sidebar on a phone is rows.
//
// The rows stay where they are in the page until the drop. They only look as
// if they have moved, by a transform, so nothing has to survive being
// re-rendered in the middle of a gesture.

/** How long a finger has to rest on a row, in ms. */
const HOLD_MS = 400;
/** How far a finger may wander while resting, in px. Further is a scroll. */
const SLOP_PX = 10;
/** How far a mouse moves a row before it counts as lifted, in px. */
const DRAG_PX = 4;
/** How close to the edge of the scrolling area starts scrolling it, in px. */
const EDGE_PX = 44;
/** The fastest that scrolls, in px per ms. */
const MAX_SCROLL_SPEED = 0.55;
/** The longest frame to catch up on, so a stall is not one big jump. */
const MAX_FRAME_MS = 100;

/**
 * Where the row lifted from `from` belongs with its middle at `y`, given where
 * the middle of every row rests: after each of the others above it.
 */
export function dropIndex(centers: number[], from: number, y: number): number {
    return centers.filter((center, i) => i !== from && center < y).length;
}

/** How far the row at `index` steps aside for a row going from `from` to `to`. */
export function rowOffset(index: number, from: number, to: number, pitch: number): number {
    if (index > from && index <= to) return -pitch;
    if (index < from && index >= to) return pitch;
    return 0;
}

/**
 * How far to scroll for a frame of `ms` with the pointer at `y`, in a scrolling
 * area from `top` to `bottom`: faster the nearer the edge, and past it at full
 * speed. By the clock rather than by the frame, or a 120Hz tablet would scroll
 * twice as fast as a 60Hz laptop. Always a whole pixel at least, since a
 * fraction of one can be rounded away and the list would never move.
 */
export function edgeScroll(y: number, top: number, bottom: number, ms: number): number {
    const distance = (depth: number) =>
        Math.ceil(Math.min(depth / EDGE_PX, 1) * MAX_SCROLL_SPEED * ms);
    if (y < top + EDGE_PX) return -distance(top + EDGE_PX - y);
    if (y > bottom - EDGE_PX) return distance(y - (bottom - EDGE_PX));
    return 0;
}

export interface ReorderOptions {
    /** The row with this `data-row-id` was let go at this index. */
    onMove: (id: string, to: number) => void;
    /** A row was picked up, so anything open on the list is in the way. */
    onLift?: () => void;
    /** What cannot be used to pick a row up, such as a button of its own. */
    ignore?: string;
}

interface Drag {
    row: HTMLElement;
    rows: HTMLElement[];
    from: number;
    to: number;
    /** Where the middle of every row rested when this began. */
    centers: number[];
    /** How far a row moves to make room for another. */
    pitch: number;
    /** How far up and down the row can go and stay in the list. */
    min: number;
    max: number;
    /** Where the pointer was when this began, and is now. */
    startY: number;
    y: number;
    scroller: HTMLElement | null;
    startScroll: number;
    /** The animation frame asked for, and when the last one ran. */
    frame: number;
    frameAt: number;
}

function scrollParent(node: HTMLElement): HTMLElement | null {
    for (let el = node.parentElement; el; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === 'auto' || overflowY === 'scroll') return el;
    }
    return null;
}

/**
 * A Svelte action for a list whose rows, its direct children, can be put in
 * another order. Each row says which it is with `data-row-id`. While a row is
 * up the list has the class `reordering` and the row the class `lifted`.
 */
export function reorderable(node: HTMLElement, options: ReorderOptions) {
    let current = options;
    let drag: Drag | null = null;
    // Pressed on a row, and not yet lifted.
    let press: { row: HTMLElement; x: number; y: number } | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    // Letting a row go ends in a click on it, which is not a request to open it.
    let swallowClick = false;

    function rowAt(target: EventTarget | null): HTMLElement | null {
        if (!(target instanceof Element)) return null;
        if (current.ignore && target.closest(current.ignore)) return null;
        const row = target.closest<HTMLElement>('[data-row-id]');
        return row?.parentElement === node ? row : null;
    }

    function lift(row: HTMLElement, y: number): boolean {
        const rows = Array.from(node.children) as HTMLElement[];
        const from = rows.indexOf(row);
        if (from === -1 || rows.length < 2) return false;

        const rects = rows.map((r) => r.getBoundingClientRect());
        const scroller = scrollParent(node);
        drag = {
            row,
            rows,
            from,
            to: from,
            centers: rects.map((r) => r.top + r.height / 2),
            pitch: rects[1].top - rects[0].top,
            min: rects[0].top - rects[from].top,
            max: rects[rects.length - 1].bottom - rects[from].bottom,
            startY: y,
            y,
            scroller,
            startScroll: scroller?.scrollTop ?? 0,
            frame: requestAnimationFrame(scrollAtEdge),
            frameAt: performance.now(),
        };
        node.classList.add('reordering');
        row.classList.add('lifted');
        current.onLift?.();
        return true;
    }

    function follow(y: number) {
        if (!drag) return;
        drag.y = y;
        // The list moving under the pointer carries the row as far as the
        // pointer moving does.
        const scrolled = (drag.scroller?.scrollTop ?? 0) - drag.startScroll;
        const offset = Math.min(Math.max(y - drag.startY + scrolled, drag.min), drag.max);
        drag.row.style.transform = `translateY(${offset}px)`;

        const to = dropIndex(drag.centers, drag.from, drag.centers[drag.from] + offset);
        if (to === drag.to) return;
        drag.to = to;
        drag.rows.forEach((row, index) => {
            if (index === drag?.from) return;
            const shift = rowOffset(index, drag!.from, to, drag!.pitch);
            row.style.transform = shift ? `translateY(${shift}px)` : '';
        });
    }

    // A list longer than the sidebar has places that cannot be reached
    // without it scrolling, and the scrollbar cannot be used with the row up.
    function scrollAtEdge(now: number) {
        if (!drag) return;
        const elapsed = Math.min(now - drag.frameAt, MAX_FRAME_MS);
        drag.frameAt = now;
        if (drag.scroller) {
            const { top, bottom } = drag.scroller.getBoundingClientRect();
            const by = edgeScroll(drag.y, top, bottom, elapsed);
            if (by !== 0) {
                drag.scroller.scrollTop += by;
                follow(drag.y);
            }
        }
        drag.frame = requestAnimationFrame(scrollAtEdge);
    }

    function settle(commit: boolean) {
        if (!drag) return;
        const { row, rows, from, to, frame } = drag;
        drag = null;
        cancelAnimationFrame(frame);
        for (const r of rows) r.style.transform = '';
        row.classList.remove('lifted');
        node.classList.remove('reordering');
        const id = row.dataset.rowId;
        if (commit && to !== from && id !== undefined) current.onMove(id, to);
    }

    function release() {
        press = null;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = null;
        window.removeEventListener('pointermove', mouseMove);
        window.removeEventListener('pointerup', mouseUp);
        window.removeEventListener('pointercancel', mouseCancel);
        window.removeEventListener('keydown', keydown, true);
    }

    // --- a mouse ------------------------------------------------------------

    function mouseDown(event: PointerEvent) {
        swallowClick = false;
        // Touch comes through the touch events below. Control and a click is
        // how a Mac asks for a context menu.
        if (event.pointerType !== 'mouse' || event.button !== 0 || event.ctrlKey) return;
        const row = rowAt(event.target);
        if (!row) return;
        press = { row, x: event.clientX, y: event.clientY };
        window.addEventListener('pointermove', mouseMove);
        window.addEventListener('pointerup', mouseUp);
        window.addEventListener('pointercancel', mouseCancel);
        window.addEventListener('keydown', keydown, true);
    }

    function mouseMove(event: PointerEvent) {
        // The button came up somewhere this could not hear it.
        if (event.buttons === 0) return mouseCancel();
        if (press && !drag) {
            const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
            if (moved < DRAG_PX) return;
            // From where it was pressed, so the row stays under the pointer
            // rather than trailing it by what it took to lift it.
            if (!lift(press.row, press.y)) return release();
            // So the row can be let go outside the window and still land.
            node.setPointerCapture(event.pointerId);
        }
        follow(event.clientY);
    }

    function mouseUp() {
        swallowClick = drag !== null;
        settle(true);
        release();
    }

    function mouseCancel() {
        settle(false);
        release();
    }

    function keydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !drag) return;
        event.stopPropagation();
        // The button is still down, and coming up will click the row.
        swallowClick = true;
        mouseCancel();
    }

    // --- a finger -----------------------------------------------------------

    function touchStart(event: TouchEvent) {
        swallowClick = false;
        if (drag) return;
        release();
        if (event.touches.length !== 1) return;
        const row = rowAt(event.target);
        if (!row) return;
        const { clientX: x, clientY: y } = event.touches[0];
        press = { row, x, y };
        holdTimer = setTimeout(() => {
            holdTimer = null;
            if (press && lift(press.row, press.y)) navigator.vibrate?.(10);
            press = null;
        }, HOLD_MS);
    }

    function touchMove(event: TouchEvent) {
        const touch = event.touches[0];
        if (drag) {
            // Only a row already lifted stops the list scrolling, which is
            // why this listener cannot be passive.
            if (event.cancelable) event.preventDefault();
            follow(touch.clientY);
        } else if (press) {
            const moved = Math.hypot(touch.clientX - press.x, touch.clientY - press.y);
            if (moved > SLOP_PX) release();
        }
    }

    function touchEnd(event: TouchEvent) {
        release();
        if (!drag) return;
        // The drawer closes on a swipe, and this finger's travel is not one.
        event.stopPropagation();
        swallowClick = true;
        settle(true);
    }

    function touchCancel() {
        release();
        settle(false);
    }

    function click(event: MouseEvent) {
        if (!swallowClick) return;
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
    }

    // The platform's own menu would open over a row being held.
    function contextmenu(event: Event) {
        if (drag || holdTimer) event.preventDefault();
    }

    node.addEventListener('pointerdown', mouseDown);
    node.addEventListener('touchstart', touchStart, { passive: true });
    node.addEventListener('touchmove', touchMove, { passive: false });
    node.addEventListener('touchend', touchEnd);
    node.addEventListener('touchcancel', touchCancel);
    node.addEventListener('click', click, true);
    node.addEventListener('contextmenu', contextmenu);

    return {
        update(next: ReorderOptions) {
            current = next;
        },
        destroy() {
            settle(false);
            release();
            node.removeEventListener('pointerdown', mouseDown);
            node.removeEventListener('touchstart', touchStart);
            node.removeEventListener('touchmove', touchMove);
            node.removeEventListener('touchend', touchEnd);
            node.removeEventListener('touchcancel', touchCancel);
            node.removeEventListener('click', click, true);
            node.removeEventListener('contextmenu', contextmenu);
        },
    };
}
