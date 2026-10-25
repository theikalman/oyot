<script lang="ts" module>
    // Only one row is open at a time: opening one closes the last.
    let closeOpenRow: (() => void) | null = null;
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';

    // A list row that answers to the finger on a touch screen: drag it left
    // to show its actions behind it, or right to do its one quick thing
    // (tick a todo), which happens when it is let go past the line.
    interface Props {
        /** The buttons revealed behind the row's right end. */
        actions?: Snippet;
        /** How wide those buttons are, in px. */
        actionsWidth?: number;
        /** What a swipe right does, and the label drawn behind it. */
        onSwipeRight?: () => void;
        rightLabel?: Snippet;
        children: Snippet;
    }

    let { actions, actionsWidth = 156, onSwipeRight, rightLabel, children }: Props = $props();

    let offset = $state(0);
    let dragging = $state(false);
    let start: { x: number; y: number; base: number } | null = null;
    let horizontal: boolean | null = null;

    function close() {
        offset = 0;
    }

    function down(event: TouchEvent) {
        if (event.touches.length !== 1) return;
        const t = event.touches[0];
        start = { x: t.clientX, y: t.clientY, base: offset };
        horizontal = null;
    }

    function move(event: TouchEvent) {
        if (!start) return;
        const t = event.touches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        // Decide once whether this is a swipe or a scroll.
        if (horizontal === null) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
            if (horizontal && closeOpenRow !== close) {
                closeOpenRow?.();
                closeOpenRow = close;
            }
        }
        if (!horizontal) return;
        event.preventDefault();
        dragging = true;
        const max = onSwipeRight ? 140 : 0;
        const min = actions ? -actionsWidth - 24 : 0;
        offset = Math.min(max, Math.max(min, start.base + dx));
    }

    function up() {
        if (!start) return;
        start = null;
        if (!dragging) return;
        dragging = false;
        if (offset > 90 && onSwipeRight) {
            offset = 0;
            onSwipeRight();
        } else if (actions && offset < -actionsWidth / 2) {
            offset = -actionsWidth;
        } else {
            offset = 0;
        }
    }

    // A tap on the row while its actions show puts it back, instead of
    // opening what it is.
    function clickCapture(event: MouseEvent) {
        if (offset !== 0) {
            event.preventDefault();
            event.stopPropagation();
            offset = 0;
        }
    }
</script>

<div class="swipe-row">
    {#if offset > 0 && rightLabel}
        <div class="under right" class:armed={offset > 90}>{@render rightLabel()}</div>
    {/if}
    {#if offset < 0 && actions}
        <div class="under left" style="width: {actionsWidth}px">{@render actions()}</div>
    {/if}
    <div
        class="front"
        class:dragging
        style="transform: translateX({offset}px)"
        ontouchstart={down}
        ontouchmove={move}
        ontouchend={up}
        ontouchcancel={up}
        onclickcapture={clickCapture}
        role="presentation"
    >
        {@render children()}
    </div>
</div>

<style>
    .swipe-row {
        position: relative;
        overflow: hidden;
    }

    .front {
        position: relative;
        z-index: 1;
        background: var(--bg-primary);
        transition: transform 0.2s ease-out;
        touch-action: pan-y;
    }

    .front.dragging {
        transition: none;
    }

    .under {
        position: absolute;
        top: 0;
        bottom: 0;
        display: flex;
        align-items: stretch;
    }

    .under.left {
        right: 0;
    }

    .under.right {
        left: 0;
        right: 0;
        align-items: center;
        gap: 8px;
        padding: 0 22px;
        background: var(--ok-bg);
        color: var(--ok-text);
        font-size: 14px;
        font-weight: 650;
    }

    .under.right.armed {
        background: color-mix(in srgb, var(--status-ok) 35%, var(--ok-bg));
    }
</style>
