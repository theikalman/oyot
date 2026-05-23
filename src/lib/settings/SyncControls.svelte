<script lang="ts">
    interface Props {
        isSyncEnabled: boolean;
        isSyncing: boolean;
        onlineCount: number;
        totalPeers: number;
        onToggleSync: () => void;
        onTriggerSync: () => void;
    }

    let {
        isSyncEnabled,
        isSyncing,
        onlineCount,
        totalPeers,
        onToggleSync,
        onTriggerSync
    }: Props = $props();
</script>

<section class="section">
    <h2>Sync Controls</h2>
    <div class="sync-controls">
        <div class="control-row">
            <div class="control-info">
                <span class="control-label">Auto-sync</span>
                <span class="control-desc">Automatically sync changes with paired devices</span>
            </div>
            <button
                class="toggle-btn {isSyncEnabled ? 'enabled' : 'disabled'}"
                onclick={onToggleSync}
            >
                {isSyncEnabled ? 'Enabled' : 'Disabled'}
            </button>
        </div>
        <div class="control-row">
            <div class="control-info">
                <span class="control-label">Manual Sync</span>
                <span class="control-desc">Sync now with all connected devices</span>
            </div>
            <button
                class="btn-sync {isSyncing ? 'syncing' : ''}"
                onclick={onTriggerSync}
                disabled={isSyncing || !isSyncEnabled}
            >
                {isSyncing ? 'Syncing...' : 'Sync Now'}
            </button>
        </div>
        <div class="status-info">
            <span class="status-dot {onlineCount > 0 ? 'online' : 'offline'}"></span>
            <span class="status-text">
                {onlineCount} of {totalPeers} device{totalPeers !== 1 ? 's' : ''} online
            </span>
        </div>
    </div>
</section>

<style>
    .section {
        margin-bottom: 32px;
    }

    .section h2 {
        margin: 0 0 16px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .sync-controls {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
    }

    .control-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .control-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .control-label {
        font-weight: 500;
        color: var(--text-primary);
        font-size: 14px;
    }

    .control-desc {
        font-size: 12px;
        color: var(--text-muted);
    }

    .toggle-btn {
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        transition: background-color 0.2s;
    }

    .toggle-btn.enabled {
        background: #22c55e;
        color: white;
    }

    .toggle-btn.disabled {
        background: var(--bg-hover);
        color: var(--text-secondary);
    }

    .btn-sync {
        padding: 8px 16px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
    }

    .btn-sync:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .btn-sync.syncing {
        background: #eab308;
    }

    .status-info {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        padding-top: 12px;
        border-top: 1px solid var(--border-color);
    }

    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
    }

    .status-dot.online {
        background: #22c55e;
    }

    .status-dot.offline {
        background: #9ca3af;
    }

    .status-text {
        font-size: 12px;
        color: var(--text-secondary);
    }
</style>