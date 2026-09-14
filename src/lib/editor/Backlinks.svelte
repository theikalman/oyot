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
    .backlinks {
        flex-shrink: 0;
        padding: 12px 24px 16px;
        border-top: 1px solid var(--border-color);
        background: var(--bg-primary);
    }
    .backlinks h2 {
        margin: 0 0 8px 0;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
    }
    ul {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    button {
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
