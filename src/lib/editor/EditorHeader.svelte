<script lang="ts">
    interface Props {
        title: string;
        isSaving: boolean;
    }

    let { title, isSaving }: Props = $props();
</script>

<div class="editor-header">
    <h1>{title}</h1>
    <div class="header-actions">
        {#if isSaving}
            <span class="saving-indicator">Saving...</span>
        {/if}
    </div>
</div>

<style>
    .editor-header {
        padding: 16px 24px;
        border-bottom: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        gap: 16px;
        background: var(--bg-primary);
    }

    .editor-header h1 {
        margin: 0;
        flex: 1;
        font-size: 24px;
        color: var(--text-primary);
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .saving-indicator {
        font-size: 12px;
        color: var(--text-secondary);
    }
</style>