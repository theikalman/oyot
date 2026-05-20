<script lang="ts">
    import { invoke } from "@tauri-apps/api/core";
    import { workspacePath } from "../stores/app";
    import type { JournalEntry } from "../types";
    import { parseMarkdown } from "../utils/markdown";

    type RenderedJournal = JournalEntry & { renderedContent: string };

    let journals = $state<RenderedJournal[]>([]);
    let loading = $state(true);
    let error = $state<string | null>(null);

    async function loadJournals() {
        const path = $workspacePath;
        if (!path) {
            loading = false;
            return;
        }

        try {
            const entries: JournalEntry[] = await invoke("get_journals", { workspacePath: path });
            journals = await Promise.all(
                entries.map(async (j) => ({
                    ...j,
                    renderedContent: await parseMarkdown(j.content),
                }))
            );
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    $effect(() => {
        loadJournals();
    });
</script>

<div class="journals">
    <div class="journals-header">
        <h2>Journals</h2>
    </div>

    <div class="journals-content">
        {#if loading}
            <p class="loading-message">Loading journals...</p>
        {:else if error}
            <p class="error-message">Error: {error}</p>
        {:else if journals.length === 0}
            <p class="empty-message">No journals created, let's create one!</p>
        {:else}
            {#each journals as journal}
                <div class="journal-entry">
                    <div class="journal-date">{journal.date}</div>
                    <div class="journal-content">
                        {@html journal.renderedContent}
                    </div>
                </div>
            {/each}
        {/if}
    </div>
</div>

<style>
    .journals {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .journals-header {
        padding: 16px 24px;
        border-bottom: 1px solid #e0e0e0;
    }

    .journals-header h2 {
        margin: 0;
        font-size: 20px;
    }

    .journals-content {
        flex: 1;
        padding: 24px;
        overflow-y: auto;
    }

    .journal-entry {
        margin-bottom: 24px;
    }

    .journal-date {
        font-size: 16px;
        font-weight: 600;
        color: #333;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid #e0e0e0;
    }

    .journal-content {
        font-size: 14px;
        line-height: 1.6;
        color: #555;
    }

    .journal-content :global(ul) {
        list-style: none;
        padding-left: 1.5em;
    }

    .journal-content :global(li) {
        position: relative;
    }

    .journal-content :global(input[type="checkbox"]) {
        position: absolute;
        left: -1.5em;
        top: 0.25em;
    }

    .loading-message,
    .error-message,
    .empty-message {
        color: #999;
        text-align: center;
        padding: 40px;
    }

    .error-message {
        color: #d32f2f;
    }
</style>