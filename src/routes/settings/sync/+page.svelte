<script lang="ts">
    import { log } from '$lib/log';
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
        reconnectPeer,
    } from '$lib/sync';
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
        const un1 = identity.subscribe((v) => {
            localIdentity = v;
        });
        const un2 = signalingStatus.subscribe((v) => {
            status = v;
        });
        const un4 = pairedDevices.subscribe((v) => {
            paired = v;
        });
        const un5 = connectedPeers.subscribe((v) => {
            connected = v;
        });
        const un6 = pendingPairRequest.subscribe((v) => {
            pending = v;
        });
        const un7 = syncStore.subscribe((s) => {
            signalingUrl = s.signalingUrl;
        });
        const un8 = pairingState.subscribe((v) => {
            pairState = v;
        });

        return () => {
            un1();
            un2();
            un4();
            un5();
            un6();
            un7();
            un8();
        };
    });

    async function copyNodeId() {
        if (!localIdentity?.node_id) return;
        try {
            await navigator.clipboard.writeText(localIdentity.node_id);
            copySuccess = true;
            setTimeout(() => (copySuccess = false), 2000);
        } catch (e) {
            console.error('Failed to copy:', e);
        }
    }

    async function handleSaveSignalingUrl(newUrl: string) {
        try {
            log.debug('handleSaveSignalingUrl', newUrl);

            await invoke('save_mqtt_broker_url', { url: newUrl });
            syncStore.setSignalingUrl(newUrl);
            await invoke('mqtt_connect', { brokerUrl: newUrl });
        } catch (e) {
            console.error('Failed to save MQTT URL:', e);
        }
    }

    async function handleRename(displayName: string) {
        await invoke('set_display_name', { displayName });
        // Re-read rather than patching the store: Rust owns the identity, and
        // the name is what peers will be told on the next exchange.
        const updated = await invoke<UserIdentity>('get_identity');
        syncStore.setIdentity(updated);
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

    async function handleReconnect(peerNodeId: string) {
        await reconnectPeer(peerNodeId);
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

    // Schema v3 replaced UUID device identity with an Ed25519 keypair and
    // cleared every stored pairing, because a pairing records a peer's node_id
    // and every node_id changed meaning. Say so once, rather than leaving the
    // user to notice their devices silently stopped syncing.
    const REPAIR_NOTICE_KEY = 'oyot.repairNoticeDismissed.v3';
    let showRepairNotice = $state(false);

    onMount(() => {
        try {
            showRepairNotice = localStorage.getItem(REPAIR_NOTICE_KEY) !== '1';
        } catch {
            // Private mode or blocked storage: showing it every time is the
            // safe failure, since the alternative is never showing it.
            showRepairNotice = true;
        }
    });

    function dismissRepairNotice() {
        showRepairNotice = false;
        try {
            localStorage.setItem(REPAIR_NOTICE_KEY, '1');
        } catch {
            /* nothing to do; it reappears next visit */
        }
    }
</script>

<div class="sync-page">
    {#if showRepairNotice && paired.length === 0}
        <div class="notice">
            <div class="notice-body">
                <strong>Devices need pairing again</strong>
                <p>
                    This version gives every device a cryptographic identity, so signaling messages
                    can be verified rather than taken on trust. Device IDs changed as a result, and
                    previous pairings no longer apply. Your notes are untouched.
                </p>
            </div>
            <button class="notice-dismiss" onclick={dismissRepairNotice} aria-label="Dismiss">
                Got it
            </button>
        </div>
    {/if}

    <IdentityCard
        identity={localIdentity}
        onCopy={copyNodeId}
        {copySuccess}
        onRename={handleRename}
    />

    <SignalingConfig {signalingUrl} {isConnected} onSave={handleSaveSignalingUrl} />

    {#if isConnected}
        <PairDeviceForm pairingState={pairState} onPair={handlePair} />
    {/if}

    <ConnectedPeerList
        pairedDevices={paired}
        connectedPeers={connected}
        onDisconnect={handleDisconnect}
        onReconnect={handleReconnect}
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
    .notice {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 14px 16px;
        margin-bottom: 24px;
        background: var(--accent-bg);
        border: 1px solid var(--accent-color);
        border-radius: 8px;
    }
    .notice-body {
        flex: 1;
    }
    .notice-body strong {
        display: block;
        margin-bottom: 4px;
        color: var(--text-primary);
        font-size: 14px;
    }
    .notice-body p {
        margin: 0;
        color: var(--text-secondary);
        font-size: 13px;
        line-height: 1.5;
    }
    .notice-dismiss {
        flex-shrink: 0;
        padding: 6px 12px;
        background: transparent;
        color: var(--accent-color);
        border: 1px solid var(--accent-color);
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }
    .notice-dismiss:hover {
        background: var(--accent-bg-hover);
    }
    .sync-page {
        max-width: 600px;
        margin: 0 auto;
        padding: 24px;
    }
</style>
