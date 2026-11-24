<script lang="ts">
    import Lightbox from './Lightbox.svelte';

    interface Props {
        src: string;
        /** The image's description, shown under it when it has one. */
        alt: string;
        onClose: () => void;
    }

    let { src, alt, onClose }: Props = $props();
</script>

<Lightbox label={alt || 'Image'} {onClose}>
    <figure class="lightbox-figure">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <img {src} {alt} onclick={(e) => e.stopPropagation()} />
        {#if alt}
            <figcaption>{alt}</figcaption>
        {/if}
    </figure>
</Lightbox>

<style>
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
</style>
