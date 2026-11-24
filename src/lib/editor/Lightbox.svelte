<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        label: string;
        onClose: () => void;
        children: Snippet;
    }

    let { label, onClose, children }: Props = $props();

    let closeButton = $state<HTMLButtonElement | null>(null);

    // Focus comes in with the view and goes back to the note when it closes,
    // as a dialog's does (see Modal).
    $effect(() => {
        const previous = document.activeElement as HTMLElement | null;
        closeButton?.focus();
        return () => previous?.focus?.();
    });

    function onKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
        } else if (event.key === 'Tab') {
            // The close button is all there is to reach.
            event.preventDefault();
            closeButton?.focus();
        }
    }
</script>

<!-- Anywhere outside what is shown closes it; what is shown does not, so a
     tap meant to look closer does not throw the view away. -->
<div
    class="lightbox"
    role="dialog"
    aria-modal="true"
    aria-label={label}
    tabindex="-1"
    onclick={onClose}
    onkeydown={onKeydown}
>
    <button
        class="lightbox-close"
        type="button"
        aria-label="Close"
        title="Close"
        bind:this={closeButton}
        onclick={(e) => {
            e.stopPropagation();
            onClose();
        }}
    >
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg
        >
    </button>
    {@render children()}
</div>

<style>
    .lightbox {
        position: fixed;
        inset: 0;
        z-index: 1100;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.86);
        padding: calc(var(--safe-top, 0px) + 56px) calc(var(--safe-right, 0px) + 16px)
            calc(var(--safe-bottom, 0px) + 24px) calc(var(--safe-left, 0px) + 16px);
        box-sizing: border-box;
        outline: none;
        cursor: zoom-out;
        animation: lightbox-in 120ms ease-out;
    }

    .lightbox-close {
        position: absolute;
        top: calc(var(--safe-top, 0px) + 12px);
        right: calc(var(--safe-right, 0px) + 12px);
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.14);
        color: #fff;
        cursor: pointer;
    }

    .lightbox-close:hover,
    .lightbox-close:focus-visible {
        background: rgba(255, 255, 255, 0.26);
    }

    @keyframes lightbox-in {
        from {
            opacity: 0;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .lightbox {
            animation: none;
        }
    }
</style>
