<script lang="ts">
    import { untrack } from 'svelte';
    import { page } from '$app/state';
    import { currentDocument, appStore } from '$lib/stores/app';
    import { loadDocument } from '$lib/services/documents';
    import { documentView } from '$lib/editor/documentView';
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

    // The last document this page had open. A document removed while open,
    // deleted here or by a paired device, leaves nothing open while the URL
    // still names it, and this is what tells that apart from a document that
    // has not arrived yet.
    let shownId = $state<string | null>(null);

    // Loads when the URL names a document that is not open. Only a change of
    // URL is a reason to, so the open document is read without subscribing to
    // it: it going away is not one. That is a document removed while it was
    // open, and loading it again can only fail. It used to, with an error
    // toast, every time a note was deleted while on screen.
    $effect(() => {
        const id = routeId;
        loadFailed = false;
        if (!id) return;
        if (id === untrack(() => $currentDocument?.id)) {
            shownId = id;
            return;
        }

        let cancelled = false;
        void loadDocument(id)
            .then((doc) => {
                if (cancelled) return;
                appStore.setCurrentDocument(doc);
                shownId = doc.id;
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

    let view = $derived(documentView({ routeId, openId: activeDocument?.id, shownId, loadFailed }));
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
    {#if view === 'editor'}
        <Editor {focusTodo} />
    {:else if view === 'gone'}
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
