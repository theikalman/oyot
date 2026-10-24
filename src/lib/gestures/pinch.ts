// Two fingers moving apart or together, for zooming the Journals page between
// its day list, a month and the year. One call per pinch, once the fingers
// have moved far enough to mean it.

/** Whether the fingers spread (`out`) or closed (`in`), or neither yet. */
export function pinchDirection(
    startGap: number,
    gap: number,
    threshold = 0.25,
): 'in' | 'out' | null {
    if (startGap <= 0) return null;
    const ratio = gap / startGap;
    if (ratio >= 1 + threshold) return 'out';
    if (ratio <= 1 - threshold) return 'in';
    return null;
}

function gapOf(touches: TouchList): number {
    const [a, b] = [touches[0], touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** A Svelte action that calls `onPinch` once for each pinch on the element. */
export function pinch(node: HTMLElement, onPinch: (direction: 'in' | 'out') => void) {
    let handler = onPinch;
    let startGap = 0;
    let done = false;

    function start(event: TouchEvent) {
        if (event.touches.length !== 2) return;
        startGap = gapOf(event.touches);
        done = false;
    }

    function move(event: TouchEvent) {
        if (event.touches.length !== 2 || done) return;
        // The page's own zoom is not what a pinch here means.
        event.preventDefault();
        const direction = pinchDirection(startGap, gapOf(event.touches));
        if (direction) {
            done = true;
            handler(direction);
        }
    }

    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });

    return {
        update(next: (direction: 'in' | 'out') => void) {
            handler = next;
        },
        destroy() {
            node.removeEventListener('touchstart', start);
            node.removeEventListener('touchmove', move);
        },
    };
}
