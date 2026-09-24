<script lang="ts">
    import { page } from '$app/state';
    import { currentDocument, appStore } from '$lib/stores/app';
    import { loadDocument } from '$lib/services/documents';
    import Editor from '$lib/editor/Editor.svelte';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';
    import PinToggle from '$lib/components/PinToggle.svelte';

    let activeDocument = $derived($currentDocument);

    // The URL is what says which document is open, so opening one is a
    // navigation and the back button works. Before this the only record was a
    // store, so there were no deep links, no history, and Android's hardware
    // back key exited the app from the only route there was.
    let routeId = $derived(page.params.id);

    // `?todo=` says which task item to put the cursor on, set by the todo
    // index when one of its rows is clicked. In the URL rather than in a
    // store so the jump survives a reload and the back button undoes it.
    let focusTodo = $derived.by(() => {
        const raw = page.url.searchParams.get('todo');
        if (raw === null) return null;
        const ordinal = Number(raw);
        return Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : null;
    });
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
    <!-- Reading a note is when deciding to keep it at hand usually happens.
         Only a note: a journal is reached by its day, and nothing lists a
         pinned journal. The pin is kept current on the open document by
         every path that changes it, a peer's included. -->
    {#snippet actions()}
        {#if activeDocument?.doc_type === 'note'}
            <PinToggle docId={activeDocument.id} pinned={activeDocument.pinned} />
        {/if}
    {/snippet}
    {#if activeDocument}
        <Editor {focusTodo} />
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
