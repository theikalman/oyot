// Telling a deliberate horizontal swipe from a scroll, a tap or a slip of the
// finger, for the touch gestures: swiping between days on a journal, and in
// from the left edge for the sidebar.

export type SwipeDirection = 'left' | 'right';

export interface SwipeOptions {
    /** How far the finger has to travel sideways, in px. */
    distance?: number;
    /** How much more sideways than up or down it has to go. */
    ratio?: number;
    /** How long it may take, in ms; longer is a drag, not a swipe. */
    maxDuration?: number;
}

/**
 * Which way a touch that went from (x0, y0) to (x1, y1) in `ms` swiped, or
 * null when it was not a swipe: too short, too slow, or more of a scroll.
 */
export function swipeDirection(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    ms: number,
    { distance = 70, ratio = 1.8, maxDuration = 600 }: SwipeOptions = {},
): SwipeDirection | null {
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (ms > maxDuration) return null;
    if (Math.abs(dx) < distance) return null;
    if (Math.abs(dx) < Math.abs(dy) * ratio) return null;
    return dx < 0 ? 'left' : 'right';
}

interface SwipeHandlers {
    onSwipe: (direction: SwipeDirection, startX: number) => void;
    /** Only touches that start where this says. */
    accept?: (event: TouchEvent) => boolean;
    options?: SwipeOptions;
}

/** A Svelte action that calls `onSwipe` for each swipe on the element. */
export function swipe(node: HTMLElement, handlers: SwipeHandlers) {
    let current = handlers;
    let start: { x: number; y: number; t: number } | null = null;

    function down(event: TouchEvent) {
        if (event.touches.length !== 1 || (current.accept && !current.accept(event))) {
            start = null;
            return;
        }
        const t = event.touches[0];
        start = { x: t.clientX, y: t.clientY, t: event.timeStamp };
    }

    function up(event: TouchEvent) {
        if (!start) return;
        const t = event.changedTouches[0];
        // A selection being made is not a swipe.
        const selecting = !(window.getSelection()?.isCollapsed ?? true);
        const direction = selecting
            ? null
            : swipeDirection(
                  start.x,
                  start.y,
                  t.clientX,
                  t.clientY,
                  event.timeStamp - start.t,
                  current.options,
              );
        const startX = start.x;
        start = null;
        if (direction) current.onSwipe(direction, startX);
    }

    node.addEventListener('touchstart', down, { passive: true });
    node.addEventListener('touchend', up, { passive: true });
    node.addEventListener('touchcancel', () => (start = null), { passive: true });

    return {
        update(next: SwipeHandlers) {
            current = next;
        },
        destroy() {
            node.removeEventListener('touchstart', down);
            node.removeEventListener('touchend', up);
        },
    };
}
