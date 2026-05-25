"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const PORT = parseInt(process.env.PORT || '3001', 10);
const PING_INTERVAL = 30000;
const peers = new Map();
function send(ws, msg) {
    if (ws.readyState === ws_1.WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}
function sendTo(targetId, msg) {
    const peer = peers.get(targetId);
    if (peer) {
        send(peer.ws, msg);
        return true;
    }
    return false;
}
function broadcast(msg, excludeId) {
    for (const [id, peer] of peers) {
        if (id !== excludeId) {
            send(peer.ws, msg);
        }
    }
}
function sendPeerList(ws) {
    const list = Array.from(peers.values()).map(p => ({
        id: p.id,
        userId: p.userId,
        displayName: p.displayName,
    }));
    send(ws, {
        from: 'server',
        to: null,
        type: 'peer-list-response',
        payload: JSON.stringify(list),
    });
}
function handleMessage(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    }
    catch {
        return;
    }
    switch (msg.type) {
        case 'register': {
            const { nodeId, userId, displayName } = JSON.parse(msg.payload);
            const peer = { id: nodeId, userId, displayName, ws, lastPing: Date.now() };
            peers.set(nodeId, peer);
            sendPeerList(ws);
            broadcast({ from: 'server', to: null, type: 'peer-joined', payload: JSON.stringify({ id: nodeId, userId, displayName }) }, nodeId);
            console.log(`[+] ${displayName} registered (nodeId=${nodeId}, userId=${userId}) — ${peers.size} peers`);
            break;
        }
        case 'offer': {
            const { target, sdp, from } = JSON.parse(msg.payload);
            sendTo(target, {
                from,
                to: target,
                type: 'offer',
                payload: JSON.stringify({ sdp, from }),
            });
            break;
        }
        case 'answer': {
            const { target, sdp, from } = JSON.parse(msg.payload);
            sendTo(target, {
                from,
                to: target,
                type: 'answer',
                payload: JSON.stringify({ sdp, from }),
            });
            break;
        }
        case 'ice-candidate': {
            const { target, candidate, from } = JSON.parse(msg.payload);
            sendTo(target, {
                from,
                to: target,
                type: 'ice-candidate',
                payload: JSON.stringify({ candidate, from }),
            });
            break;
        }
        case 'peer-list': {
            sendPeerList(ws);
            break;
        }
        case 'ping': {
            const peer = Array.from(peers.values()).find(p => p.ws === ws);
            if (peer)
                peer.lastPing = Date.now();
            send(ws, { from: 'server', to: null, type: 'pong', payload: '' });
            break;
        }
        default:
            break;
    }
}
function keepAlive(ws, pingInterval) {
    ws.on('close', () => clearInterval(pingInterval));
}
const wss = new ws_1.WebSocketServer({ port: PORT });
wss.on('connection', (ws) => {
    const pingInterval = setInterval(() => {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            send(ws, { from: 'server', to: null, type: 'ping', payload: '' });
        }
    }, PING_INTERVAL);
    keepAlive(ws, pingInterval);
    ws.on('message', (data) => handleMessage(ws, data.toString()));
    ws.on('close', () => {
        clearInterval(pingInterval);
        for (const [id, peer] of peers) {
            if (peer.ws === ws) {
                peers.delete(id);
                broadcast({ from: 'server', to: null, type: 'peer-left', payload: id });
                console.log(`[-] Peer disconnected: ${id} — ${peers.size} peers`);
                break;
            }
        }
    });
    ws.on('error', (err) => console.error('WS error:', err.message));
});
wss.on('listening', () => {
    console.log(`Signaling server listening on ws://0.0.0.0:${PORT}`);
});
wss.on('error', (err) => {
    console.error('Server error:', err.message);
});
