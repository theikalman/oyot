<script lang="ts">
    import { page } from '$app/state';
    import { currentDocument, appStore } from '$lib/stores/app';
    import { loadDocument } from '$lib/services/documents';
    import Editor from '$lib/editor/Editor.svelte';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';

    let activeDocument = $derived($currentDocument);

    // The URL is what says which document is open, so opening one is a
    // navigation and the back button works. Before this the only record was a
    // store, so there were no deep links, no history, and Android's hardware
    // back key exited the app from the only route there was.
    let routeId = $derived(page.params.id);
    let loadFailed = $state(false);

    $effect(() => {
        const id = routeId;
        if (!id || id === $currentDocument?.id) return;

        let cancelled = false;
        loadFailed = false;
        void loadDocument(id)
            .then((doc) => {
                if (!cancelled) appStore.setCurrentDocument(doc);
            })
            .catch(() => {
                // loadDocument has already reported it. A bad id in the URL
                // is a dead end rather than an error state to recover from.
                if (!cancelled) loadFailed = true;
            });

        // A quick switch must not let the slower load win and show the
        // document the user has already navigated away from.
        return () => {
            cancelled = true;
        };
    });
</script>

<WorkspaceShell title={activeDocument?.title ?? null}>
    {#if activeDocument}
        <Editor />
    {:else if loadFailed}
        <div class="empty-state">
            <p>That note no longer exists.</p>
        </div>
    {:else}
        <div class="empty-state">
            <p>Loading...</p>
        </div>
    {/if}
</WorkspaceShell>

<style>
    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
    }
</style>
