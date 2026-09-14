<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { documents } from '$lib/stores/app';
    import { get } from 'svelte/store';
    import { ensureTodayJournal } from '$lib/services/documentActions';
    import { toasts } from '$lib/services/toast';
    import { startApp } from '$lib/services/startup';

    // The entry point, not a page. It works out which document to open and
    // hands over to /doc/[id], replacing itself in history so the back button
    // never lands the user back on a redirect.
    let failed = $state(false);

    onMount(async () => {
        // The document list has to be loaded before this. Creating today's
        // journal adds it to that list, and a load finishing afterwards would
        // replace the list and drop it again.
        await startApp();

        try {
            const doc = await ensureTodayJournal();
            await goto(resolve('/doc/[id]', { id: doc.id }), { replaceState: true });
            return;
        } catch (error) {
            // Opening today's journal is a convenience, not a precondition.
            console.error("Failed to open today's journal:", error);
            toasts.error("Could not open today's journal");
        }

        const fallback = get(documents)[0];
        if (fallback) {
            await goto(resolve('/doc/[id]', { id: fallback.id }), { replaceState: true });
            return;
        }
        failed = true;
    });
</script>

<div class="entry">
    {#if failed}
        <p>Could not open a document.</p>
    {:else}
        <p>Loading...</p>
    {/if}
</div>

<style>
    .entry {
        height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
    }
</style>
