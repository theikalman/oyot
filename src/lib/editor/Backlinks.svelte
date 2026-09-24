<script lang="ts">
    import { invoke } from '@tauri-apps/api/core';
    import { openDocument } from '$lib/services/navigation';
    import type { DocumentSummary } from '$lib/types';
    import { log } from '$lib/log';

    interface Props {
        docId: string | null;
        /** Bumped by the parent after a save, so the list picks up a new link. */
        revision?: number;
    }

    let { docId, revision = 0 }: Props = $props();

    let backlinks = $state<DocumentSummary[]>([]);
    let seq = 0;

    $effect(() => {
        const id = docId;
        // Referenced so the effect re-runs when the parent signals a save.
        void revision;

        const mine = ++seq;
        if (!id) {
            backlinks = [];
            return;
        }
        invoke<DocumentSummary[]>('get_backlinks', { docId: id })
            .then((rows) => {
                if (mine === seq) backlinks = rows;
            })
            .catch((err) => {
                if (mine !== seq) return;
                log.warn('[Backlinks] Failed to load backlinks:', err);
                backlinks = [];
            });
    });

    function open(id: string) {
        void openDocument(id);
    }
</script>

{#if backlinks.length > 0}
    <section class="backlinks">
        <h2>Linked from</h2>
        <ul>
            {#each backlinks as doc (doc.id)}
                <li>
                    <button onclick={() => open(doc.id)}>{doc.title}</button>
                </li>
            {/each}
        </ul>
    </section>
{/if}

<style>
    /* Same height as the sidebar footer beside it, so the two top borders
       make one line across the window. One row, scrolling sideways when
       there are more links than fit, so the height never changes. */
    .backlinks {
        flex-shrink: 0;
        height: 65px;
        padding: 0 24px;
        display: flex;
        align-items: center;
        gap: 12px;
        border-top: 1px solid var(--border-color);
        background: var(--bg-primary);
    }
    .backlinks h2 {
        flex-shrink: 0;
        margin: 0;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
    }
    ul {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-wrap: nowrap;
        gap: 6px;
        margin: 0;
        /* Room for a focused chip's outline, which the scroller would clip. */
        padding: 2px 0;
        list-style: none;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: thin;
    }
    li {
        flex-shrink: 0;
    }
    button {
        white-space: nowrap;
        padding: 3px 10px;
        font-size: 12px;
        color: var(--accent-color);
        background: var(--accent-bg);
        border: 1px solid transparent;
        border-radius: 12px;
        cursor: pointer;
    }
    button:hover {
        border-color: var(--accent-color);
    }
</style>
