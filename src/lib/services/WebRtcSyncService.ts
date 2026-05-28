import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as Y from 'yjs';
import { get as storeGet } from 'svelte/store';
import { WebrtcProvider } from 'y-webrtc';
import {
    syncStore,
    type UserIdentity,
    type DevicePair,
    type OnlinePeer,
    type ConnectedPeer,
} from '../stores/sync';

interface SignalingMessage {
    from: string;
    to: string | null;
    type: string;
    payload: string;
}

interface ParsedOfferPayload {
    sdp: string;
    from: string;
}

const ydocsByRoom = new Map<string, Y.Doc>();
const providersByRoom = new Map<string, WebrtcProvider>();
let ws: WebSocket | null = null;
let identity: UserIdentity | null = null;
let cleanupFns: Array<() => void> = [];

function parsePayload<T>(payload: string): T | null {
    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

export async function initSync(): Promise<void> {
    try {
        identity = await invoke<UserIdentity>('get_identity');
        syncStore.setIdentity(identity);

        const signalingUrl = await invoke<string | null>('get_signaling_url');
        if (signalingUrl) {
            syncStore.setSignalingUrl(signalingUrl);
        }

        const devices = await invoke<DevicePair[]>('list_paired_devices');
        syncStore.setPairedDevices(devices);

        await connectSignaling(signalingUrl);

        setupEventListeners();
    } catch (error) {
        console.error('[WebRtcSync] Failed to init sync:', error);
    }
}

export async function connectSignaling(url: string | null): Promise<void> {
    if (!url || !identity) {
        syncStore.setSignalingStatus('disconnected');
        return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }

    syncStore.setSignalingStatus('connecting');

    return new Promise((resolve, reject) => {
        ws = new WebSocket(url);

        ws.onopen = () => {
            syncStore.setSignalingStatus('connected');

            console.log(`[WebRtcSync] Connected to signaling server ${url}`);
            console.log(`[WebRtcSync] Sending registration message`);
            console.log(`[WebRtcSync] Identity: ${JSON.stringify(identity)}`);

            const msg: SignalingMessage = {
                from: identity!.node_id,
                to: null,
                type: 'register',
                payload: JSON.stringify({
                    nodeId: identity!.node_id,
                    userId: identity!.user_id,
                    displayName: identity!.display_name,
                }),
            };
            ws!.send(JSON.stringify(msg));

            ws!.send(JSON.stringify({
                from: identity!.node_id,
                to: null,
                type: 'peer-list',
                payload: '',
            }));

            resolve();
        };

        ws.onmessage = (event) => {
            handleSignalingMessage(event.data);
        };

        ws.onclose = () => {
            syncStore.setSignalingStatus('disconnected');
        };

        ws.onerror = () => {
            syncStore.setSignalingStatus('error');
            reject(new Error('WebSocket error'));
        };

        setTimeout(() => {
            if (ws && ws.readyState === WebSocket.CONNECTING) {
                ws.close();
                syncStore.setSignalingStatus('error');
                reject(new Error('Connection timeout'));
            }
        }, 10000);
    });
}

function handleSignalingMessage(data: string): void {
    let msg: SignalingMessage;
    try {
        msg = JSON.parse(data);
    } catch {
        return;
    }

    switch (msg.type) {
        case 'peer-list-response': {
            const peers = parsePayload<Array<{ id: string; userId: string; displayName: string }>>(msg.payload);
            if (peers) {
                const online = peers
                    .filter(p => p.id !== identity?.node_id)
                    .map(p => ({ id: p.id, user_id: p.userId, display_name: p.displayName }));
                syncStore.setOnlinePeers(online);
            }
            break;
        }

        case 'peer-joined': {
            const peer = parsePayload<{ id: string; userId: string; displayName: string }>(msg.payload);
            if (peer && peer.id !== identity?.node_id) {
                syncStore.updateOnlinePeer({
                    id: peer.id,
                    user_id: peer.userId,
                    display_name: peer.displayName,
                });
            }
            break;
        }

        case 'peer-left': {
            syncStore.removeOnlinePeer(msg.payload);
            break;
        }

        case 'offer': {
            const offer = parsePayload<ParsedOfferPayload>(msg.payload);
            if (!offer || offer.from === identity?.node_id) break;

            const roomId = calculateRoomId(identity!.user_id, offer.from);
            syncStore.setPendingOffer({ from: offer.from, sdp: offer.sdp, room_id: roomId });
            break;
        }

        case 'answer': {
            const answer = parsePayload<ParsedOfferPayload>(msg.payload);
            if (!answer) break;
            handleAnswer(answer.from, answer.sdp);
            break;
        }

        case 'ice-candidate': {
            const cand = parsePayload<{ candidate: unknown; from: string }>(msg.payload);
            if (cand) {
                handleIceCandidate(cand.from, cand.candidate);
            }
            break;
        }

        case 'ping': {
            ws?.send(JSON.stringify({ from: identity?.node_id, to: null, type: 'pong', payload: '' }));
            break;
        }
    }
}

const pendingConnections = new Map<string, RTCPeerConnection>();

function calculateRoomId(userA: string, userB: string): string {
    const ids = [userA, userB].sort();
    const combined = ids.join(':');
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    let hash = 0;
    for (let i = 0; i < 16; i++) {
        hash = ((hash << 5) - hash) + (i < data.length ? data[i] : 0);
        hash |= 0;
    }
    const hexes = [];
    for (let i = 0; i < 16; i++) {
        hexes.push(((hash >>> (i * 4)) & 0xf).toString(16));
    }
    return hexes.join('');
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

    const roomId = calculateRoomId(identity.user_id, peer.user_id);

    console.log(`[WebRtcSync] Requesting connection to ${JSON.stringify(peer)}`);
    console.log(`[WebRtcSync] Requesting connection to ${peer.display_name} (${peer.id})`);

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pendingConnections.set(peer.id, pc);

    console.log(`[WebRtcSync] Created peer connection for ${peer.display_name} (${peer.id})`);

    const channel = pc.createDataChannel('yjs-sync');
    const ydoc = new Y.Doc();
    ydocsByRoom.set(roomId, ydoc);

    console.log(`[WebRtcSync] Created data channel for ${peer.display_name} (${peer.id})`);

    setupDataChannel(channel, ydoc, roomId, peer);

    console.log(`[WebRtcSync] Setting up ICE candidates for ${peer.display_name} (${peer.id})`);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws?.send(JSON.stringify({
                from: identity!.node_id,
                to: peer.id,
                type: 'ice-candidate',
                payload: JSON.stringify({ candidate: event.candidate.toJSON(), from: identity!.node_id }),
            }));
        }
    };

    console.log(`[WebRtcSync] Setting up connection state for ${peer.display_name} (${peer.id})`);

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

    console.log(`[WebRtcSync] Creating offer for ${peer.display_name} (${peer.id})`);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    console.log(`[WebRtcSync] Sending offer for ${peer.display_name} (${peer.id})`);

    ws?.send(JSON.stringify({
        from: identity!.node_id,
        to: peer.id,
        type: 'offer',
        payload: JSON.stringify({ sdp: JSON.stringify(offer), from: identity!.node_id }),
    }));
}

export async function acceptConnection(from: string, sdp: string, roomId: string): Promise<void> {
    if (!identity) return;

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pendingConnections.set(from, pc);

    pc.ondatachannel = (event) => {
        const channel = event.channel;
        let ydoc = ydocsByRoom.get(roomId);
        if (!ydoc) {
            ydoc = new Y.Doc();
            ydocsByRoom.set(roomId, ydoc);
        }
        setupDataChannel(channel, ydoc, roomId, { id: from, display_name: 'Peer' } as OnlinePeer);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws?.send(JSON.stringify({
                from: identity!.node_id,
                to: from,
                type: 'ice-candidate',
                payload: JSON.stringify({ candidate: event.candidate.toJSON(), from: identity!.node_id }),
            }));
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

    ws?.send(JSON.stringify({
        from: identity!.node_id,
        to: from,
        type: 'answer',
        payload: JSON.stringify({ sdp: JSON.stringify(answer), from: identity!.node_id }),
    }));
}

function setupDataChannel(
    channel: RTCDataChannel,
    ydoc: Y.Doc,
    roomId: string,
    peer: OnlinePeer
): void {
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
    ydocsByRoom.delete(roomId);
    providersByRoom.delete(roomId);
}

export function getYDocForRoom(roomId: string): Y.Doc | null {
    return ydocsByRoom.get(roomId) ?? null;
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
    for (const roomId of ydocsByRoom.keys()) {
        cleanupRoom(roomId);
    }
    syncStore.setConnectedPeers([]);
    if (ws) {
        ws.close();
        ws = null;
    }
    syncStore.setSignalingStatus('disconnected');
}

function setupEventListeners(): void {
    listen('signaling-reconnected', () => {
        if (identity) {
            connectSignaling(storeGet(syncStore).signalingUrl);
        }
    });
}

export function getCleanup(): () => void {
    return () => {
        cleanupFns.forEach(fn => fn());
        cleanupFns = [];
        disconnectAll();
    };
}
