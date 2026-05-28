import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as Y from 'yjs';
import { syncStore, type UserIdentity, type DevicePair, type OnlinePeer, type ConnectedPeer } from '../stores/sync';

interface RoomDoc {
    ydoc: Y.Doc;
    peer: OnlinePeer;
    roomId: string;
}

const roomDocs = new Map<string, RoomDoc>();
const pendingConnections = new Map<string, RTCPeerConnection>();
let identity: UserIdentity | null = null;
let cleanupFns: UnlistenFn[] = [];
const onlinePeersMap = new Map<string, OnlinePeer>();

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

export async function initSync(): Promise<void> {
    try {
        identity = await invoke<UserIdentity>('get_identity');
        syncStore.setIdentity(identity);

        const mqttBroker = await invoke<string | null>('get_mqtt_broker_url');
        if (mqttBroker && mqttBroker.trim() !== '') {
            syncStore.setSignalingUrl(mqttBroker);
            try {
                await invoke('mqtt_connect', { brokerUrl: mqttBroker });
                syncStore.setSignalingStatus('connected');
            } catch (e) {
                console.error('[WebRtcSync] Failed to connect to MQTT broker:', e);
                syncStore.setSignalingStatus('error');
            }
        } else {
            syncStore.setSignalingStatus('disconnected');
        }

        const devices = await invoke<DevicePair[]>('list_paired_devices');
        syncStore.setPairedDevices(devices);

        setupEventListeners();
    } catch (error) {
        console.error('[WebRtcSync] Failed to init sync:', error);
        syncStore.setSignalingStatus('error');
    }
}

async function handleAnswer(from: string, sdp: string): Promise<void> {
    const pc = pendingConnections.get(from);
    if (!pc) return;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sdp)));
    } catch (e) {
        console.error('[WebRtcSync] Failed to set remote answer:', e);
    }
}

function handleIceCandidate(from: string, candidate: unknown): void {
    const pc = pendingConnections.get(from);
    if (!pc) return;

    try {
        pc.addIceCandidate(new RTCIceCandidate(candidate as RTCIceCandidateInit));
    } catch (e) {
        console.error('[WebRtcSync] Failed to add ICE candidate:', e);
    }
}

export async function requestConnection(peer: OnlinePeer): Promise<void> {
    if (!identity) return;

    const roomId = await calculateRoomId(identity.user_id, peer.user_id);
    console.log(`[WebRtcSync] Requesting connection to ${peer.display_name} (${peer.id})`);

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pendingConnections.set(peer.id, pc);

    const channel = pc.createDataChannel('yjs-sync', { ordered: true });
    const ydoc = new Y.Doc();
    roomDocs.set(roomId, { ydoc, peer, roomId });

    setupDataChannel(channel, roomId);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            invoke('mqtt_publish_ice_candidate', {
                peerId: peer.id,
                candidate: JSON.stringify(event.candidate.toJSON()),
                from: identity!.node_id,
            }).catch(console.error);
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            syncStore.addConnectedPeer({
                peer_node_id: peer.id,
                peer_display_name: peer.display_name,
                room_id: roomId,
            });
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            syncStore.removeConnectedPeer(roomId);
            cleanupRoom(roomId);
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await invoke('mqtt_publish_offer', {
        peerId: peer.id,
        sdp: JSON.stringify(offer),
        from: identity!.node_id,
    }).catch(console.error);
}

export async function acceptConnection(from: string, sdp: string, roomId: string): Promise<void> {
    if (!identity) return;

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pendingConnections.set(from, pc);

    pc.ondatachannel = (event) => {
        const channel = event.channel;
        let roomDoc = roomDocs.get(roomId);
        if (!roomDoc) {
            const ydoc = new Y.Doc();
            roomDoc = { ydoc, peer: { id: from, user_id: from, display_name: 'Peer' }, roomId };
            roomDocs.set(roomId, roomDoc);
        }
        setupDataChannel(channel, roomId);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            invoke('mqtt_publish_ice_candidate', {
                peerId: from,
                candidate: JSON.stringify(event.candidate.toJSON()),
                from: identity!.node_id,
            }).catch(console.error);
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            syncStore.addConnectedPeer({
                peer_node_id: from,
                peer_display_name: 'Peer',
                room_id: roomId,
            });
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            syncStore.removeConnectedPeer(roomId);
            cleanupRoom(roomId);
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sdp)));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await invoke('mqtt_publish_answer', {
        peerId: from,
        sdp: JSON.stringify(answer),
        from: identity!.node_id,
    }).catch(console.error);
}

function setupDataChannel(channel: RTCDataChannel, roomId: string): void {
    const roomDoc = roomDocs.get(roomId);
    if (!roomDoc) return;

    const { ydoc, peer } = roomDoc;
    channel.binaryType = 'arraybuffer';

    channel.onmessage = (event) => {
        try {
            const update = new Uint8Array(event.data);
            Y.applyUpdate(ydoc, update);
        } catch (e) {
            console.error('[WebRtcSync] Failed to apply update:', e);
        }
    };

    channel.onopen = () => {
        console.log(`[WebRtcSync] DataChannel open for room ${roomId}`);
    };

    channel.onclose = () => {
        console.log(`[WebRtcSync] DataChannel closed for room ${roomId}`);
        syncStore.removeConnectedPeer(roomId);
        cleanupRoom(roomId);
    };

    ydoc.on('update', (update: Uint8Array) => {
        if (channel.readyState === 'open') {
            channel.send(update);
        }
    });

    syncStore.addConnectedPeer({
        peer_node_id: peer.id,
        peer_display_name: peer.display_name,
        room_id: roomId,
    });
}

function cleanupRoom(roomId: string): void {
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
    const unlistenOffer = await listen<{ from: string; sdp: string; room_id: string }>('mqtt-offer-received', async (event) => {
        const { from, sdp, room_id } = event.payload;
        await acceptConnection(from, sdp, room_id);
    });

    const unlistenAnswer = await listen<{ from: string; sdp: string }>('mqtt-answer-received', async (event) => {
        const { from, sdp } = event.payload;
        await handleAnswer(from, sdp);
    });

    const unlistenIce = await listen<{ from: string; candidate: string }>('mqtt-ice-candidate-received', async (event) => {
        const { from, candidate } = event.payload;
        handleIceCandidate(from, JSON.parse(candidate));
    });

    const unlistenStatus = await listen<string>('mqtt-status', (event) => {
        syncStore.setSignalingStatus(event.payload as 'connected' | 'disconnected' | 'error');
    });

    const unlistenPeerJoined = await listen<{ peer_id: string; user_id: string; display_name: string }>('mqtt-peer-joined', (event) => {
        const { peer_id, user_id, display_name } = event.payload;
        const peer: OnlinePeer = {
            id: peer_id,
            user_id,
            display_name,
        };
        onlinePeersMap.set(peer_id, peer);
        syncStore.setOnlinePeers(Array.from(onlinePeersMap.values()));
    });

    const unlistenPeerLeft = await listen<string>('mqtt-peer-left', (event) => {
        const peerId = event.payload;
        onlinePeersMap.delete(peerId);
        syncStore.setOnlinePeers(Array.from(onlinePeersMap.values()));
    });

    cleanupFns = [unlistenOffer, unlistenAnswer, unlistenIce, unlistenStatus, unlistenPeerJoined, unlistenPeerLeft];
}

export function getCleanup(): () => void {
    return () => {
        cleanupFns.forEach(fn => fn());
        cleanupFns = [];
        disconnectAll();
    };
}