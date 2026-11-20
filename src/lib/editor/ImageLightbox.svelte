<script lang="ts">
    interface Props {
        src: string;
        /** The image's description, shown under it when it has one. */
        alt: string;
        onClose: () => void;
    }

    let { src, alt, onClose }: Props = $props();

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

<!-- Anywhere outside the image closes it; the image itself does not, so a
     tap meant to look closer does not throw the view away. -->
<div
    class="lightbox"
    role="dialog"
    aria-modal="true"
    aria-label={alt || 'Image'}
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
    <figure class="lightbox-figure">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <img {src} {alt} onclick={(e) => e.stopPropagation()} />
        {#if alt}
            <figcaption>{alt}</figcaption>
        {/if}
    </figure>
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

    .lightbox-figure {
        margin: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        max-width: 100%;
        max-height: 100%;
        min-height: 0;
    }

    .lightbox-figure img {
        display: block;
        max-width: 100%;
        max-height: 100%;
        min-height: 0;
        object-fit: contain;
        border-radius: 4px;
        cursor: default;
        /* Pinch to look closer on a phone. */
        touch-action: pinch-zoom;
    }

    figcaption {
        color: #f2f2f2;
        font-size: 14px;
        line-height: 1.5;
        text-align: center;
        max-width: 680px;
        flex-shrink: 0;
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
