<script lang="ts">
    import { onMount } from 'svelte';
    import { syncStore, nodeId, syncPeers } from '$lib/stores/app';
    import { NodeIdCard, SyncControls, PeerList, AddPeerForm } from '$lib/settings';
    import { addPeer, removePeer, toggleSyncEnabled, triggerManualSync, formatLastSync, initializeSync } from '$lib/services';
    import { toasts } from '$lib/services/toast';
    import QRCode from 'qrcode';

    let localNodeId = $state<string | null>(null);
    let peers = $state<typeof $syncPeers>([]);
    let isSyncEnabled = $state(true);
    let isSyncing = $state(false);
    let isLoading = $state(true);
    let copySuccess = $state(false);
    let showQrCode = $state(false);
    let qrCodeDataUrl = $state<string | null>(null);

    onMount(() => {
        initializeSync().catch(console.error);

        const unsubNodeId = nodeId.subscribe(v => localNodeId = v);
        const unsubPeers = syncPeers.subscribe(v => peers = v);
        const unsubSyncEnabled = syncStore.subscribe(s => isSyncEnabled = s.isEnabled);

        if (localNodeId) {
            generateQrCode(localNodeId);
        }

        isLoading = false;

        return () => {
            unsubNodeId();
            unsubPeers();
            unsubSyncEnabled();
        };
    });

    async function generateQrCode(text: string) {
        try {
            qrCodeDataUrl = await QRCode.toDataURL(text, {
                width: 200,
                margin: 2,
                color: { dark: '#333333', light: '#ffffff' }
            });
        } catch (error) {
            console.error('Failed to generate QR code:', error);
            qrCodeDataUrl = null;
        }
    }

    async function copyNodeId() {
        if (!localNodeId) return;
        try {
            await navigator.clipboard.writeText(localNodeId);
            copySuccess = true;
            setTimeout(() => copySuccess = false, 2000);
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    }

    async function handleAddPeer(nodeIdValue: string, deviceName: string) {
        try {
            await addPeer(nodeIdValue, deviceName);
        } catch {
            // Error already handled in service
        }
    }

    async function handleRemovePeer(nodeIdValue: string) {
        try {
            await removePeer(nodeIdValue);
        } catch {
            // Error already handled in service
        }
    }

    async function handleToggleSync() {
        try {
            await toggleSyncEnabled(!isSyncEnabled);
        } catch {
            // Error already handled in service
        }
    }

    async function handleTriggerSync() {
        isSyncing = true;
        try {
            await triggerManualSync();
        } catch {
            // Error already handled in service
        } finally {
            isSyncing = false;
        }
    }

    let onlineCount = $derived(peers.filter((p: { is_online: boolean }) => p.is_online).length);
</script>

<div class="settings-page">
    <header class="page-header">
        <h1>Sync Settings</h1>
        <p class="subtitle">Manage P2P sync and connected devices</p>
    </header>

    {#if isLoading}
        <div class="loading">Loading...</div>
    {:else}
        <NodeIdCard
            nodeId={localNodeId}
            {qrCodeDataUrl}
            {showQrCode}
            {copySuccess}
            onToggleQr={() => showQrCode = !showQrCode}
            onCopy={copyNodeId}
        />

        <SyncControls
            {isSyncEnabled}
            {isSyncing}
            {onlineCount}
            totalPeers={peers.length}
            onToggleSync={handleToggleSync}
            onTriggerSync={handleTriggerSync}
        />

        <AddPeerForm
            isAdding={false}
            onSubmit={handleAddPeer}
        />

        <PeerList
            {peers}
            {formatLastSync}
            onRemovePeer={handleRemovePeer}
        />
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

    .loading {
        text-align: center;
        padding: 48px;
        color: var(--text-muted);
    }
</style>