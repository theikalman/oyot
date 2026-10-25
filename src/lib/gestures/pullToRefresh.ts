// Pulling a list down from its top to have it looked at again, as a phone's
// own lists do. The distance is reported as the finger moves, damped so it
// feels like stretching, and `onRefresh` runs when it is let go past the line.

/** How far, after damping, a pull has to go to count. */
export const PULL_THRESHOLD = 70;

/** How far a finger's travel moves the list: less and less the further it goes. */
export function damp(dy: number): number {
    if (dy <= 0) return 0;
    return Math.min(dy * 0.5, 120);
}

interface Options {
    onPull: (distance: number) => void;
    onRefresh: () => void;
}

/** A Svelte action for the scrolling element whose top a pull starts from. */
export function pullToRefresh(node: HTMLElement, options: Options) {
    let current = options;
    let startY: number | null = null;
    let distance = 0;

    function down(event: TouchEvent) {
        // Only from the very top: anywhere else a drag down is a scroll.
        if (event.touches.length !== 1 || node.scrollTop > 0) return;
        startY = event.touches[0].clientY;
        distance = 0;
    }

    function move(event: TouchEvent) {
        if (startY === null) return;
        const dy = event.touches[0].clientY - startY;
        if (dy <= 0 || node.scrollTop > 0) {
            if (distance > 0) current.onPull((distance = 0));
            return;
        }
        event.preventDefault();
        distance = damp(dy);
        current.onPull(distance);
    }

    function up() {
        if (startY === null) return;
        startY = null;
        const pulled = distance >= PULL_THRESHOLD;
        distance = 0;
        current.onPull(0);
        if (pulled) current.onRefresh();
    }

    node.addEventListener('touchstart', down, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', up);
    node.addEventListener('touchcancel', up);

    return {
        update(next: Options) {
            current = next;
        },
        destroy() {
            node.removeEventListener('touchstart', down);
            node.removeEventListener('touchmove', move);
            node.removeEventListener('touchend', up);
            node.removeEventListener('touchcancel', up);
        },
    };
}
