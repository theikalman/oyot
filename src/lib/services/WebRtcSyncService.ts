import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
import * as Y from 'yjs';
import { syncStore, pendingPairRequest, type UserIdentity, type DevicePair } from '../stores/sync';

interface RoomPeer {
    id: string;
    display_name: string;
}

interface RoomDoc {
    ydoc: Y.Doc;
    peer: RoomPeer;
    roomId: string;
}

const roomDocs = new Map<string, RoomDoc>();
const pendingConnections = new Map<string, RTCPeerConnection>();
let identity: UserIdentity | null = null;
let cleanupFns: UnlistenFn[] = [];

async function calculateRoomId(userA: string, userB: string): Promise<string> {
    const ids = [userA, userB].sort();
    const combined = ids.join(':');
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const hashHex = Array.from(hashArray.slice(0, 16))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return hashHex;
}

async function refreshPairedDevices(): Promise<void> {
    const updated = await invoke<DevicePair[]>('list_paired_devices');
    syncStore.setPairedDevices(updated);
}

export async function initSync(): Promise<void> {
    console.log('[WebRtcSync] initSync() starting...');
    try {
        identity = await invoke<UserIdentity>('get_identity');
        console.log(`[WebRtcSync] Local identity: node_id=${identity.node_id} user_id=${identity.user_id} display_name=${identity.display_name}`);
        syncStore.setIdentity(identity);

        const mqttBroker = await invoke<string | null>('get_mqtt_broker_url');
        console.log(`[WebRtcSync] MQTT broker URL from config: ${mqttBroker || '(none)'}`);
        if (mqttBroker && mqttBroker.trim() !== '') {
            syncStore.setSignalingUrl(mqttBroker);
            try {
                console.log(`[WebRtcSync] Connecting to MQTT broker ${mqttBroker}...`);
                await invoke('mqtt_connect', { brokerUrl: mqttBroker });
                syncStore.setSignalingStatus('connected');
                console.log('[WebRtcSync] MQTT broker connected');
            } catch (e) {
                console.error('[WebRtcSync] Failed to connect to MQTT broker:', e);
                syncStore.setSignalingStatus('error');
            }
        } else {
            console.warn('[WebRtcSync] No MQTT broker URL configured, signaling will not start');
            syncStore.setSignalingStatus('disconnected');
        }

        await refreshPairedDevices();

        setupEventListeners();
        console.log('[WebRtcSync] initSync() complete, event listeners active');
    } catch (error) {
        console.error('[WebRtcSync] Failed to init sync:', error);
        syncStore.setSignalingStatus('error');
    }
}

async function handleAnswer(from: string, sdp: string): Promise<void> {
    console.log(`[WebRtcSync] handleAnswer() from ${from}`);
    const pc = pendingConnections.get(from);
    if (!pc) {
        console.warn(`[WebRtcSync] No pending RTCPeerConnection for ${from}, dropping answer (did we ever send an offer to this peer?)`);
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.warn(`[WebRtcSync] Ignoring answer from ${from}: connection is in '${pc.signalingState}' state, not 'have-local-offer'`);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sdp)));
        console.log(`[WebRtcSync] Remote answer applied for ${from}, signalingState=${pc.signalingState}`);
    } catch (e) {
        console.error('[WebRtcSync] Failed to set remote answer:', e);
    }
}

function handleIceCandidate(from: string, candidate: unknown): void {
    const pc = pendingConnections.get(from);
    if (!pc) {
        console.warn(`[WebRtcSync] Received ICE candidate from ${from} but no pending connection exists, dropping`);
        return;
    }

    try {
        pc.addIceCandidate(new RTCIceCandidate(candidate as RTCIceCandidateInit));
        console.log(`[WebRtcSync] Added remote ICE candidate from ${from}`);
    } catch (e) {
        console.error('[WebRtcSync] Failed to add ICE candidate:', e);
    }
}

// Shared by a brand-new pairing (initiateOffer, room_id freshly derived from both real
// user_ids) and a reconnect to an already-paired device (reconnectToPeer, room_id reused
// from the persisted device_pairs row). Either way, by the time this runs the peer is
// already trusted - the pairing handshake (or a prior successful pairing) already happened.
async function createOfferConnection(peerNodeId: string, roomId: string, peerDisplayName: string): Promise<void> {
    if (!identity) {
        console.warn('[WebRtcSync] createOfferConnection() called before identity was loaded, aborting');
        return;
    }

    console.log(`[WebRtcSync] createOfferConnection() -> ${peerDisplayName} (peer_id=${peerNodeId}, room_id=${roomId})`);

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pendingConnections.set(peerNodeId, pc);

    const channel = pc.createDataChannel('yjs-sync', { ordered: true });
    const ydoc = new Y.Doc();
    roomDocs.set(roomId, { ydoc, peer: { id: peerNodeId, display_name: peerDisplayName }, roomId });

    setupDataChannel(channel, roomId);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`[WebRtcSync] [${peerNodeId}] Local ICE candidate gathered (type=${event.candidate.type}, protocol=${event.candidate.protocol}), publishing via MQTT`);
            invoke('mqtt_publish_ice_candidate', {
                peerId: peerNodeId,
                candidate: JSON.stringify(event.candidate.toJSON()),
            }).catch((e) => console.error(`[WebRtcSync] [${peerNodeId}] Failed to publish ICE candidate:`, e));
        } else {
            console.log(`[WebRtcSync] [${peerNodeId}] ICE candidate gathering complete`);
        }
    };

    pc.onicegatheringstatechange = () => {
        console.log(`[WebRtcSync] [${peerNodeId}] iceGatheringState -> ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRtcSync] [${peerNodeId}] iceConnectionState -> ${pc.iceConnectionState}`);
    };

    pc.onsignalingstatechange = () => {
        console.log(`[WebRtcSync] [${peerNodeId}] signalingState -> ${pc.signalingState}`);
    };

    pc.onconnectionstatechange = () => {
        console.log(`[WebRtcSync] [${peerNodeId}] connectionState -> ${pc.connectionState} (room=${roomId})`);
        if (pc.connectionState === 'connected') {
            console.log(`[WebRtcSync] [${peerNodeId}] Peer connection established, room=${roomId}`);
            syncStore.addConnectedPeer({
                peer_node_id: peerNodeId,
                peer_display_name: peerDisplayName,
                room_id: roomId,
            });
            invoke('save_pair', { peerNodeId, peerDisplayName, roomId })
                .then(refreshPairedDevices)
                .catch((e) => console.error(`[WebRtcSync] [${peerNodeId}] Failed to save pair:`, e));
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            console.warn(`[WebRtcSync] [${peerNodeId}] Peer connection ${pc.connectionState}, tearing down room=${roomId}`);
            syncStore.removeConnectedPeer(roomId);
            cleanupRoom(roomId);
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log(`[WebRtcSync] [${peerNodeId}] Local offer created and set, publishing via MQTT (room=${roomId})`);

    await invoke('mqtt_publish_offer', {
        peerId: peerNodeId,
        sdp: JSON.stringify(offer),
    }).catch((e) => console.error(`[WebRtcSync] [${peerNodeId}] Failed to publish offer:`, e));
}

// Called once a pair-response with accepted=true arrives - we now have the peer's real
// user_id, so room_id can be derived correctly on both sides (see the mismatch bug fix
// in the pairing plan: room_id must come from two real user_ids, never a node_id).
export async function initiateOffer(peerNodeId: string, peerUserId: string, peerDisplayName: string): Promise<void> {
    if (!identity) {
        console.warn('[WebRtcSync] initiateOffer() called before identity was loaded, aborting');
        return;
    }
    const roomId = await calculateRoomId(identity.user_id, peerUserId);
    await createOfferConnection(peerNodeId, roomId, peerDisplayName);
}

// Re-establishes a WebRTC connection to a device we're already paired with (e.g. after an
// app restart or network drop). No handshake needed - the room_id is already agreed and
// persisted from the original pairing, and the peer's signaling_manager trusts an offer
// from an already-paired node_id without re-showing a consent dialog.
export async function reconnectToPeer(pair: DevicePair): Promise<void> {
    await createOfferConnection(pair.peer_node_id, pair.room_id, pair.peer_display_name);
}

export async function acceptConnection(from: string, sdp: string, roomId: string, displayName: string): Promise<void> {
    if (!identity) {
        console.warn('[WebRtcSync] acceptConnection() called before identity was loaded, aborting');
        return;
    }

    console.log(`[WebRtcSync] acceptConnection() <- offer from ${from} (room=${roomId})`);

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pendingConnections.set(from, pc);

    pc.ondatachannel = (event) => {
        console.log(`[WebRtcSync] [${from}] Remote data channel '${event.channel.label}' received (room=${roomId})`);
        const channel = event.channel;
        let roomDoc = roomDocs.get(roomId);
        if (!roomDoc) {
            const ydoc = new Y.Doc();
            roomDoc = { ydoc, peer: { id: from, display_name: displayName }, roomId };
            roomDocs.set(roomId, roomDoc);
        }
        setupDataChannel(channel, roomId);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`[WebRtcSync] [${from}] Local ICE candidate gathered (type=${event.candidate.type}, protocol=${event.candidate.protocol}), publishing via MQTT`);
            invoke('mqtt_publish_ice_candidate', {
                peerId: from,
                candidate: JSON.stringify(event.candidate.toJSON()),
            }).catch((e) => console.error(`[WebRtcSync] [${from}] Failed to publish ICE candidate:`, e));
        } else {
            console.log(`[WebRtcSync] [${from}] ICE candidate gathering complete`);
        }
    };

    pc.onicegatheringstatechange = () => {
        console.log(`[WebRtcSync] [${from}] iceGatheringState -> ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRtcSync] [${from}] iceConnectionState -> ${pc.iceConnectionState}`);
    };

    pc.onsignalingstatechange = () => {
        console.log(`[WebRtcSync] [${from}] signalingState -> ${pc.signalingState}`);
    };

    pc.onconnectionstatechange = () => {
        console.log(`[WebRtcSync] [${from}] connectionState -> ${pc.connectionState} (room=${roomId})`);
        if (pc.connectionState === 'connected') {
            console.log(`[WebRtcSync] [${from}] Peer connection established, room=${roomId}`);
            syncStore.addConnectedPeer({
                peer_node_id: from,
                peer_display_name: displayName,
                room_id: roomId,
            });
            invoke('save_pair', { peerNodeId: from, peerDisplayName: displayName, roomId })
                .then(refreshPairedDevices)
                .catch((e) => console.error(`[WebRtcSync] [${from}] Failed to save pair:`, e));
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            console.warn(`[WebRtcSync] [${from}] Peer connection ${pc.connectionState}, tearing down room=${roomId}`);
            syncStore.removeConnectedPeer(roomId);
            cleanupRoom(roomId);
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sdp)));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log(`[WebRtcSync] [${from}] Local answer created and set, publishing via MQTT (room=${roomId})`);

    await invoke('mqtt_publish_answer', {
        peerId: from,
        sdp: JSON.stringify(answer),
    }).catch((e) => console.error(`[WebRtcSync] [${from}] Failed to publish answer:`, e));
}

// Step 1 of the pairing handshake: tell a specific node_id (typed or QR-scanned into the
// same input field, never picked from an open discovery list) that we'd like to pair.
export async function sendPairRequest(peerNodeId: string): Promise<void> {
    if (!identity) {
        console.warn('[WebRtcSync] sendPairRequest() called before identity was loaded, aborting');
        return;
    }
    syncStore.setPairingState('requesting');
    try {
        console.log(`[WebRtcSync] sendPairRequest() -> ${peerNodeId}`);
        await invoke('mqtt_publish_pair_request', { peerNodeId });
    } catch (e) {
        console.error('[WebRtcSync] Failed to send pair request:', e);
        syncStore.setPairingState(null);
    }
}

// Step 2, on the receiving side: the user explicitly accepts or declines the incoming
// pair-request shown in PairingDialog. Accepting authorizes the peer's node_id on the
// Rust side (signaling_manager::authorize_peer) before the pair-response goes out, so the
// offer that follows is trusted rather than dropped as unsolicited.
export async function respondToPairRequest(accept: boolean): Promise<void> {
    const req = get(pendingPairRequest);
    if (!req) {
        console.warn('[WebRtcSync] respondToPairRequest() called with no pending request');
        return;
    }
    syncStore.setPendingPairRequest(null);
    try {
        if (accept) {
            console.log(`[WebRtcSync] Accepting pair request from ${req.from}`);
            await invoke('mqtt_accept_pair_request', {
                peerNodeId: req.from,
                peerUserId: req.user_id,
                peerDisplayName: req.display_name,
            });
        } else {
            console.log(`[WebRtcSync] Declining pair request from ${req.from}`);
            await invoke('mqtt_decline_pair_request', { peerNodeId: req.from });
        }
    } catch (e) {
        console.error('[WebRtcSync] Failed to respond to pair request:', e);
    }
}

function setupDataChannel(channel: RTCDataChannel, roomId: string): void {
    const roomDoc = roomDocs.get(roomId);
    if (!roomDoc) {
        console.warn(`[WebRtcSync] setupDataChannel() called for room ${roomId} but no roomDoc exists yet`);
        return;
    }

    const { ydoc, peer } = roomDoc;
    channel.binaryType = 'arraybuffer';
    console.log(`[WebRtcSync] Setting up data channel '${channel.label}' for room ${roomId} (peer=${peer.id}, initial readyState=${channel.readyState})`);

    channel.onmessage = (event) => {
        try {
            const update = new Uint8Array(event.data);
            console.log(`[WebRtcSync] [room=${roomId}] Received Yjs update over data channel: ${update.byteLength} bytes`);
            Y.applyUpdate(ydoc, update);
            console.log(`[WebRtcSync] [room=${roomId}] Applied remote update to room-scoped Y.Doc (this doc is NOT the editor's document Y.Doc)`);
        } catch (e) {
            console.error(`[WebRtcSync] [room=${roomId}] Failed to apply update:`, e);
        }
    };

    channel.onopen = () => {
        console.log(`[WebRtcSync] DataChannel open for room ${roomId} (peer=${peer.id})`);
    };

    channel.onclose = () => {
        console.log(`[WebRtcSync] DataChannel closed for room ${roomId} (peer=${peer.id})`);
        syncStore.removeConnectedPeer(roomId);
        cleanupRoom(roomId);
    };

    channel.onerror = (event) => {
        console.error(`[WebRtcSync] DataChannel error for room ${roomId} (peer=${peer.id}):`, event);
    };

    ydoc.on('update', (update: Uint8Array) => {
        console.log(`[WebRtcSync] [room=${roomId}] Local room-doc update (${update.byteLength} bytes), channel.readyState=${channel.readyState}`);
        if (channel.readyState === 'open') {
            channel.send(update);
        } else {
            console.warn(`[WebRtcSync] [room=${roomId}] Dropping outgoing update, data channel is '${channel.readyState}' not 'open'`);
        }
    });

    syncStore.addConnectedPeer({
        peer_node_id: peer.id,
        peer_display_name: peer.display_name,
        room_id: roomId,
    });
}

function cleanupRoom(roomId: string): void {
    console.log(`[WebRtcSync] cleanupRoom(${roomId})`);
    roomDocs.delete(roomId);
    pendingConnections.delete(roomId);
}

export function getYDocForRoom(roomId: string): Y.Doc | null {
    return roomDocs.get(roomId)?.ydoc ?? null;
}

export function createYDoc(): Y.Doc {
    return new Y.Doc();
}

export function applyYjsUpdate(ydoc: Y.Doc, update: Uint8Array): void {
    Y.applyUpdate(ydoc, update);
}

export function exportYjsState(ydoc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(ydoc);
}

export function disconnectPeer(roomId: string): void {
    cleanupRoom(roomId);
    syncStore.removeConnectedPeer(roomId);
}

export function disconnectAll(): void {
    for (const roomId of roomDocs.keys()) {
        cleanupRoom(roomId);
    }
    syncStore.setConnectedPeers([]);
}

async function setupEventListeners(): Promise<void> {
    console.log('[WebRtcSync] Registering Tauri event listeners (mqtt-pair-request-received, mqtt-pair-response-received, mqtt-offer-received, mqtt-answer-received, mqtt-ice-candidate-received, mqtt-status)');

    const unlistenPairRequest = await listen<{ from: string; user_id: string; display_name: string }>('mqtt-pair-request-received', (event) => {
        console.log(`[WebRtcSync] event: mqtt-pair-request-received from=${event.payload.from} display_name=${event.payload.display_name}`);
        syncStore.setPendingPairRequest(event.payload);
    });

    const unlistenPairResponse = await listen<{ from: string; user_id: string; display_name: string; accepted: boolean }>('mqtt-pair-response-received', async (event) => {
        const { from, user_id, display_name, accepted } = event.payload;
        console.log(`[WebRtcSync] event: mqtt-pair-response-received from=${from} accepted=${accepted}`);
        if (accepted) {
            syncStore.setPairingState(null);
            await initiateOffer(from, user_id, display_name);
        } else {
            syncStore.setPairingState('declined');
        }
    });

    const unlistenOffer = await listen<{ from: string; sdp: string; room_id: string; display_name: string }>('mqtt-offer-received', async (event) => {
        const { from, sdp, room_id, display_name } = event.payload;
        console.log(`[WebRtcSync] event: mqtt-offer-received from=${from} room_id=${room_id}`);
        await acceptConnection(from, sdp, room_id, display_name);
    });

    const unlistenAnswer = await listen<{ from: string; sdp: string }>('mqtt-answer-received', async (event) => {
        const { from, sdp } = event.payload;
        console.log(`[WebRtcSync] event: mqtt-answer-received from=${from}`);
        await handleAnswer(from, sdp);
    });

    const unlistenIce = await listen<{ from: string; candidate: string }>('mqtt-ice-candidate-received', async (event) => {
        const { from, candidate } = event.payload;
        console.log(`[WebRtcSync] event: mqtt-ice-candidate-received from=${from}`);
        handleIceCandidate(from, JSON.parse(candidate));
    });

    const unlistenStatus = await listen<string>('mqtt-status', (event) => {
        console.log(`[WebRtcSync] event: mqtt-status -> ${event.payload}`);
        syncStore.setSignalingStatus(event.payload as 'connected' | 'disconnected' | 'error');
    });

    cleanupFns = [unlistenPairRequest, unlistenPairResponse, unlistenOffer, unlistenAnswer, unlistenIce, unlistenStatus];
    console.log('[WebRtcSync] Event listeners registered');
}

export function getCleanup(): () => void {
    return () => {
        console.warn(`[WebRtcSync] getCleanup() invoked - tearing down ${cleanupFns.length} Tauri event listener(s) and disconnecting all rooms. Signaling messages arriving after this point will be MISSED until initSync() runs again.`);
        cleanupFns.forEach(fn => fn());
        cleanupFns = [];
        disconnectAll();
    };
}
