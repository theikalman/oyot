<script lang="ts">
    import type { Snippet } from 'svelte';

    // A sheet that slides up from the foot of a phone's screen with what can
    // be done to one thing. Swipe it down, tap outside it or press Esc to put
    // it away.
    interface Props {
        label: string;
        onClose: () => void;
        children: Snippet;
    }

    let { label, onClose, children }: Props = $props();

    let drag = $state(0);
    let startY: number | null = null;

    function down(event: TouchEvent) {
        startY = event.touches[0].clientY;
    }

    function move(event: TouchEvent) {
        if (startY === null) return;
        drag = Math.max(0, event.touches[0].clientY - startY);
    }

    function up() {
        if (startY === null) return;
        startY = null;
        if (drag > 90) onClose();
        drag = 0;
    }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<div class="scrim" role="presentation" onclick={onClose}></div>
<div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-label={label}
    style="transform: translateY({drag}px)"
    class:dragging={drag > 0}
>
    <div
        class="grab-area"
        ontouchstart={down}
        ontouchmove={move}
        ontouchend={up}
        role="presentation"
    >
        <span class="grab"></span>
    </div>
    {@render children()}
</div>

<style>
    .scrim {
        position: fixed;
        inset: 0;
        z-index: 950;
        background: var(--scrim);
        animation: fade 0.15s ease-out;
    }

    .sheet {
        position: fixed;
        z-index: 951;
        left: 0;
        right: 0;
        bottom: 0;
        max-height: 85dvh;
        overflow-y: auto;
        padding: 0 0 calc(var(--safe-bottom) + 24px);
        background: var(--bg-raised);
        border-radius: var(--radius-xl) var(--radius-xl) 0 0;
        box-shadow: var(--shadow-pop);
        transition: transform 0.2s ease-out;
        animation: rise 0.2s ease-out;
    }

    .sheet.dragging {
        transition: none;
    }

    .grab-area {
        display: flex;
        justify-content: center;
        padding: 8px 0 12px;
    }

    .grab {
        width: 38px;
        height: 5px;
        border-radius: 3px;
        background: var(--border-light);
    }

    @keyframes rise {
        from {
            transform: translateY(100%);
        }
    }

    @keyframes fade {
        from {
            opacity: 0;
        }
    }
</style>
