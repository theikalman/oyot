<script lang="ts">
    import { onMount } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { syncStore, nodeId, syncPeers } from '$lib/stores/app';

    let localNodeId = $state<string | null>(null);
    let peers = $state<Array<{ node_id: string; device_name: string; last_synchronized: number | null }>>([]);
    let newPeerNodeId = $state('');
    let newPeerDeviceName = $state('');
    let isAdding = $state(false);
    let isLoading = $state(true);
    let copySuccess = $state(false);

    async function loadData() {
        try {
            const [nodeIdResult, peersResult] = await Promise.all([
                invoke<string | null>('get_node_id'),
                invoke<Array<{ node_id: string; device_name: string; last_synchronized: number | null }>>('get_sync_peers')
            ]);
            localNodeId = nodeIdResult;
            peers = peersResult;
            syncStore.setNodeId(nodeIdResult || '');
            syncStore.setPeers(peers.map(p => ({ ...p, is_online: false })));
        } catch (error) {
            console.error('Failed to load sync data:', error);
        } finally {
            isLoading = false;
        }
    }

    onMount(() => {
        loadData();
    });

    async function addPeer() {
        if (!newPeerNodeId.trim() || !newPeerDeviceName.trim()) {
            return;
        }

        isAdding = true;
        try {
            await invoke('add_sync_peer', {
                nodeId: newPeerNodeId.trim(),
                deviceName: newPeerDeviceName.trim()
            });
            newPeerNodeId = '';
            newPeerDeviceName = '';
            await loadData();
        } catch (error) {
            console.error('Failed to add peer:', error);
        } finally {
            isAdding = false;
        }
    }

    async function removePeer(nodeIdToRemove: string) {
        try {
            await invoke('remove_sync_peer', { nodeId: nodeIdToRemove });
            await loadData();
        } catch (error) {
            console.error('Failed to remove peer:', error);
        }
    }

    async function copyNodeId() {
        if (!localNodeId) return;
        try {
            await navigator.clipboard.writeText(localNodeId);
            copySuccess = true;
            setTimeout(() => {
                copySuccess = false;
            }, 2000);
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    }

    function formatLastSync(timestamp: number | null): string {
        if (!timestamp) return 'Never';
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} min ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        const diffDays = Math.floor(diffHours / 24);
        return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    }
</script>

<div class="settings-page">
    <header class="page-header">
        <h1>Sync Settings</h1>
        <p class="subtitle">Manage P2P sync and connected devices</p>
    </header>

    {#if isLoading}
        <div class="loading">Loading...</div>
    {:else}
        <section class="section">
            <h2>This Device</h2>
            <div class="node-id-card">
                <div class="node-id-label">Your Node ID</div>
                <div class="node-id-value">{localNodeId || 'Not available'}</div>
                <button class="copy-btn" onclick={copyNodeId} disabled={!localNodeId}>
                    {copySuccess ? 'Copied!' : 'Copy'}
                </button>
            </div>
            <p class="help-text">
                Share this ID with other devices to sync with them.
            </p>
        </section>

        <section class="section">
            <h2>Add Device</h2>
            <form class="add-peer-form" onsubmit={(e) => { e.preventDefault(); addPeer(); }}>
                <input
                    type="text"
                    placeholder="Device Node ID"
                    bind:value={newPeerNodeId}
                    class="input"
                />
                <input
                    type="text"
                    placeholder="Device name (e.g., My iPad)"
                    bind:value={newPeerDeviceName}
                    class="input"
                />
                <button type="submit" class="btn-primary" disabled={isAdding || !newPeerNodeId.trim() || !newPeerDeviceName.trim()}>
                    {isAdding ? 'Adding...' : 'Add Device'}
                </button>
            </form>
        </section>

        <section class="section">
            <h2>Connected Devices</h2>
            {#if peers.length === 0}
                <p class="empty-state">No devices connected yet.</p>
            {:else}
                <ul class="peer-list">
                    {#each peers as peer}
                        <li class="peer-item">
                            <div class="peer-info">
                                <span class="peer-name">{peer.device_name}</span>
                                <span class="peer-node-id">{peer.node_id}</span>
                                <span class="peer-last-sync">Last synced: {formatLastSync(peer.last_synchronized)}</span>
                            </div>
                            <button class="btn-danger" onclick={() => removePeer(peer.node_id)}>
                                Remove
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    {/if}
</div>

<style>
    .settings-page {
        max-width: 600px;
        margin: 0 auto;
        padding: 24px;
    }

    .page-header {
        margin-bottom: 32px;
    }

    .page-header h1 {
        margin: 0 0 8px 0;
        font-size: 24px;
        color: var(--text-primary);
    }

    .subtitle {
        margin: 0;
        color: var(--text-secondary);
        font-size: 14px;
    }

    .section {
        margin-bottom: 32px;
    }

    .section h2 {
        margin: 0 0 16px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .loading {
        text-align: center;
        padding: 48px;
        color: var(--text-muted);
    }

    .node-id-card {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        flex-wrap: wrap;
    }

    .node-id-label {
        font-size: 12px;
        color: var(--text-muted);
        width: 100%;
    }

    .node-id-value {
        flex: 1;
        font-family: monospace;
        font-size: 13px;
        word-break: break-all;
        color: var(--text-primary);
    }

    .copy-btn {
        padding: 6px 12px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }

    .copy-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .help-text {
        margin: 8px 0 0 0;
        font-size: 12px;
        color: var(--text-muted);
    }

    .add-peer-form {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .input {
        padding: 10px 12px;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        font-size: 14px;
        background: var(--bg-primary);
        color: var(--text-primary);
    }

    .input:focus {
        outline: none;
        border-color: var(--accent-color);
    }

    .btn-primary {
        padding: 10px 16px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
    }

    .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .empty-state {
        color: var(--text-muted);
        font-size: 14px;
    }

    .peer-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .peer-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        margin-bottom: 8px;
        background: var(--bg-primary);
    }

    .peer-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        min-width: 0;
    }

    .peer-name {
        font-weight: 500;
        color: var(--text-primary);
    }

    .peer-node-id {
        font-family: monospace;
        font-size: 11px;
        color: var(--text-muted);
        word-break: break-all;
    }

    .peer-last-sync {
        font-size: 11px;
        color: var(--text-muted);
    }

    .btn-danger {
        padding: 6px 12px;
        background: transparent;
        color: #ef4444;
        border: 1px solid #ef4444;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        flex-shrink: 0;
    }

    .btn-danger:hover {
        background: #fef2f2;
    }
</style>