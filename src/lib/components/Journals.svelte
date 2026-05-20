<script lang="ts">
    import { invoke } from "@tauri-apps/api/core";
    import { workspacePath } from "../stores/app";
    import type { JournalEntry } from "../types";

    let journals = $state<JournalEntry[]>([]);
    let loading = $state(true);
    let error = $state<string | null>(null);

    async function loadJournals() {
        const path = $workspacePath;
        if (!path) {
            loading = false;
            return;
        }

        try {
            journals = await invoke("get_journals", { workspacePath: path });
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
                        {journal.content}
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
        white-space: pre-wrap;
        font-size: 14px;
        line-height: 1.6;
        color: #555;
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