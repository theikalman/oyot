<script lang="ts">
    import Lightbox from './Lightbox.svelte';
    import { createFrame } from './htmlPreview/frame';

    interface Props {
        /** The HTML to show as a page. */
        source: string;
        onClose: () => void;
    }

    let { source, onClose }: Props = $props();

    function showPage(holder: HTMLElement, html: string) {
        const frame = createFrame(html);
        holder.append(frame);
        return { destroy: () => frame.remove() };
    }
</script>

<Lightbox label="HTML page" {onClose}>
    <div class="page" use:showPage={source}></div>
</Lightbox>

<style>
    .page {
        width: 100%;
        height: 100%;
        max-width: 1280px;
        cursor: default;
    }

    .page :global(iframe) {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        border-radius: 4px;
        /* A page that sets no background was written for a white one. */
        background: #fff;
        color-scheme: light;
    }
</style>
