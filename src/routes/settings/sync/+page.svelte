<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import {
        syncStore,
        identity,
        signalingStatus,
        onlinePeers,
        pairedDevices,
        connectedPeers,
        pendingOffer,
        type OnlinePeer,
        type UserIdentity,
        type DevicePair,
        type ConnectedPeer,
    } from '$lib/stores/sync';
    import {
        initSync,
        connectSignaling,
        requestConnection,
        acceptConnection,
        disconnectPeer,
        getCleanup,
    } from '$lib/services/WebRtcSyncService';
    import { IdentityCard } from '$lib/settings';
    import { SignalingConfig } from '$lib/settings';
    import { DiscoveryList } from '$lib/settings';
    import { ConnectedPeerList } from '$lib/settings';
    import { PairingDialog } from '$lib/settings';

    let localIdentity: UserIdentity | null = $state(null);
    let status = $state<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
    let peers = $state<OnlinePeer[]>([]);
    let paired = $state<DevicePair[]>([]);
    let connected = $state<ConnectedPeer[]>([]);
    let pending: { from: string; sdp: string; room_id: string } | null = $state(null);
    let signalingUrl = $state<string | null>(null);
    let copySuccess = $state(false);

    onMount(() => {
        let cleanup: (() => void) | null = null;
        (async () => {
            await initSync();
            cleanup = getCleanup();
        })();

        const un1 = identity.subscribe(v => { localIdentity = v; });
        const un2 = signalingStatus.subscribe(v => { status = v; });
        const un3 = onlinePeers.subscribe(v => { peers = v; });
        const un4 = pairedDevices.subscribe(v => { paired = v; });
        const un5 = connectedPeers.subscribe(v => { connected = v; });
        const un6 = pendingOffer.subscribe(v => { pending = v; });
        const un7 = syncStore.subscribe(s => { signalingUrl = s.signalingUrl; });

        return () => {
            un1(); un2(); un3(); un4(); un5(); un6(); un7();
            if (cleanup) cleanup();
        };
    });

    onDestroy(() => {
        getCleanup()();
    });

    async function copyNodeId() {
        if (!localIdentity?.node_id) return;
        try {
            await navigator.clipboard.writeText(localIdentity.node_id);
            copySuccess = true;
            setTimeout(() => copySuccess = false, 2000);
        } catch (e) {
            console.error('Failed to copy:', e);
        }
    }

    async function handleSaveSignalingUrl(newUrl: string) {
        try {
            await invoke('save_signaling_url', { url: newUrl });
            syncStore.setSignalingUrl(newUrl);
            await connectSignaling(newUrl);
        } catch (e) {
            console.error('Failed to save signaling URL:', e);
        }
    }

    async function handleConnect(peer: OnlinePeer) {
        await requestConnection(peer);
        await invoke('save_pair', {
            peerNodeId: peer.id,
            peerDisplayName: peer.display_name,
            roomId: '',
        });
        const updated = await invoke<DevicePair[]>('list_paired_devices');
        syncStore.setPairedDevices(updated);
    }

    async function handleAcceptOffer() {
        if (!pending) return;
        await acceptConnection(pending.from, pending.sdp, pending.room_id);
        await invoke('save_pair', {
            peerNodeId: pending.from,
            peerDisplayName: 'Peer',
            roomId: pending.room_id,
        });
        const updated = await invoke<DevicePair[]>('list_paired_devices');
        syncStore.setPairedDevices(updated);
        syncStore.setPendingOffer(null);
    }

    function handleDeclineOffer() {
        syncStore.setPendingOffer(null);
    }

    async function handleDisconnect(roomId: string) {
        disconnectPeer(roomId);
    }

    async function handleRemovePeer(peerNodeId: string) {
        try {
            await invoke('remove_pair', { peerNodeId });
            const updated = await invoke<DevicePair[]>('list_paired_devices');
            syncStore.setPairedDevices(updated);
        } catch (e) {
            console.error('Failed to remove pair:', e);
        }
    }

    let isConnected = $derived(status === 'connected');
</script>

<div class="sync-page">
    <IdentityCard
        identity={localIdentity}
        onCopy={copyNodeId}
        {copySuccess}
    />

    <SignalingConfig
        {signalingUrl}
        {isConnected}
        onSave={handleSaveSignalingUrl}
    />

    {#if isConnected}
        <DiscoveryList {peers} onConnect={handleConnect} />
    {/if}

    <ConnectedPeerList
        pairedDevices={paired}
        connectedPeers={connected}
        onDisconnect={handleDisconnect}
        onRemove={handleRemovePeer}
    />

    {#if pending}
        <PairingDialog
            from={pending.from}
            displayName="Unknown Device"
            onAccept={handleAcceptOffer}
            onDecline={handleDeclineOffer}
        />
    {/if}
</div>

<style>
    .sync-page {
        max-width: 600px;
        margin: 0 auto;
        padding: 24px;
    }
</style>