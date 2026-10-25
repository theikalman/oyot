// Holding a finger still on something, for its full menu as a sheet on a
// phone, the touch form of right-clicking it.

const HOLD_MS = 500;
const SLOP_PX = 10;

/** A Svelte action that calls `onLongPress` when the element is held. */
export function longpress(node: HTMLElement, onLongPress: () => void) {
    let handler = onLongPress;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    let fired = false;

    function cancel() {
        if (timer) clearTimeout(timer);
        timer = null;
        start = null;
    }

    function down(event: TouchEvent) {
        if (event.touches.length !== 1) return cancel();
        fired = false;
        start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        timer = setTimeout(() => {
            fired = true;
            timer = null;
            navigator.vibrate?.(10);
            handler();
        }, HOLD_MS);
    }

    function move(event: TouchEvent) {
        if (!start) return;
        const t = event.touches[0];
        if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > SLOP_PX) cancel();
    }

    // The tap that ends a long press is not also a click on the row.
    function click(event: MouseEvent) {
        if (!fired) return;
        fired = false;
        event.preventDefault();
        event.stopPropagation();
    }

    // The platform's own menu (copy, select) would open over the sheet.
    function contextmenu(event: Event) {
        if (fired || timer) event.preventDefault();
    }

    node.addEventListener('touchstart', down, { passive: true });
    node.addEventListener('touchmove', move, { passive: true });
    node.addEventListener('touchend', cancel);
    node.addEventListener('touchcancel', cancel);
    node.addEventListener('click', click, true);
    node.addEventListener('contextmenu', contextmenu);

    return {
        update(next: () => void) {
            handler = next;
        },
        destroy() {
            cancel();
            node.removeEventListener('touchstart', down);
            node.removeEventListener('touchmove', move);
            node.removeEventListener('touchend', cancel);
            node.removeEventListener('touchcancel', cancel);
            node.removeEventListener('click', click, true);
            node.removeEventListener('contextmenu', contextmenu);
        },
    };
}
