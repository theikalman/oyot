<script lang="ts">
    import { onMount } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import {
        syncStore,
        identity,
        signalingStatus,
        pairedDevices,
        connectedPeers,
        pendingPairRequest,
        pairingState,
        type UserIdentity,
        type DevicePair,
        type ConnectedPeer,
        type PendingPairRequest,
        type PairingState,
    } from '$lib/stores/sync';
    import {
        sendPairRequest,
        respondToPairRequest,
        disconnectPeer,
    } from '$lib/services/WebRtcSyncService';
    import { IdentityCard } from '$lib/settings';
    import { SignalingConfig } from '$lib/settings';
    import { PairDeviceForm } from '$lib/settings';
    import { ConnectedPeerList } from '$lib/settings';
    import { PairingDialog } from '$lib/settings';

    let localIdentity: UserIdentity | null = $state(null);
    let status = $state<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
    let paired = $state<DevicePair[]>([]);
    let connected = $state<ConnectedPeer[]>([]);
    let pending: PendingPairRequest | null = $state(null);
    let pairState = $state<PairingState>(null);
    let signalingUrl = $state<string | null>(null);
    let copySuccess = $state(false);

    onMount(() => {
        const un1 = identity.subscribe(v => { localIdentity = v; });
        const un2 = signalingStatus.subscribe(v => { status = v; });
        const un4 = pairedDevices.subscribe(v => { paired = v; });
        const un5 = connectedPeers.subscribe(v => { connected = v; });
        const un6 = pendingPairRequest.subscribe(v => { pending = v; });
        const un7 = syncStore.subscribe(s => { signalingUrl = s.signalingUrl; });
        const un8 = pairingState.subscribe(v => { pairState = v; });

        return () => {
            un1(); un2(); un4(); un5(); un6(); un7(); un8();
        };
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
            console.log('handleSaveSignalingUrl', newUrl);

            await invoke('save_mqtt_broker_url', { url: newUrl });
            syncStore.setSignalingUrl(newUrl);
            await invoke('mqtt_connect', { brokerUrl: newUrl });
        } catch (e) {
            console.error('Failed to save MQTT URL:', e);
        }
    }

    async function handlePair(nodeId: string) {
        await sendPairRequest(nodeId);
    }

    async function handleAcceptPairRequest() {
        await respondToPairRequest(true);
    }

    async function handleDeclinePairRequest() {
        await respondToPairRequest(false);
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
        <PairDeviceForm pairingState={pairState} onPair={handlePair} />
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
            displayName={pending.display_name}
            onAccept={handleAcceptPairRequest}
            onDecline={handleDeclinePairRequest}
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
