import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3001', 10);
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3002', 10);
const PING_INTERVAL = 30000;

interface Peer {
  id: string;
  userId: string;
  displayName: string;
  ws: WebSocket;
  lastPing: number;
}

interface SignalingMessage {
  from: string;
  to: string | null;
  type: string;
  payload: string;
}

const peers = new Map<string, Peer>();

function send(ws: WebSocket, msg: SignalingMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendTo(targetId: string, msg: SignalingMessage): boolean {
  const peer = peers.get(targetId);
  if (peer) {
    send(peer.ws, msg);
    return true;
  }
  return false;
}

function broadcast(msg: SignalingMessage, excludeId?: string): void {
  for (const [id, peer] of peers) {
    if (id !== excludeId) {
      send(peer.ws, msg);
    }
  }
}

function sendPeerList(ws: WebSocket): void {
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

function handleMessage(ws: WebSocket, raw: string): void {
  let msg: SignalingMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'register': {
      const { nodeId, userId, displayName } = JSON.parse(msg.payload);
      const peer: Peer = { id: nodeId, userId, displayName, ws, lastPing: Date.now() };
      peers.set(nodeId, peer);
      sendPeerList(ws);
      broadcast(
        { from: 'server', to: null, type: 'peer-joined', payload: JSON.stringify({ id: nodeId, userId, displayName }) },
        nodeId
      );
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
      if (peer) peer.lastPing = Date.now();
      send(ws, { from: 'server', to: null, type: 'pong', payload: '' });
      break;
    }

    default:
      break;
  }
}

function keepAlive(ws: WebSocket, pingInterval: ReturnType<typeof setInterval>): void {
  ws.on('close', () => clearInterval(pingInterval));
}

const httpServer = http.createServer();

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', peers: peers.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.on('error', (err) => {
  console.error(`Health server error: ${err.message}`);
});

healthServer.listen(HEALTH_PORT, HOST, () => {
  console.log(`HTTP healthcheck listening on http://${HOST}:${HEALTH_PORT}/health`);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
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
  console.log(`Signaling server listening on ws://127.0.0.1:3001`);
});

wss.on('error', (err) => {
  console.error('Server error:', err.message);
});

httpServer.listen(HEALTH_PORT, () => {
  console.log(`HTTP healthcheck listening on http://0.0.0.0:${HEALTH_PORT}/health`);

httpServer.on('error', (err) => {
  console.error(`HTTP server error: ${err.message}`);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  httpServer.close();
  wss.close();
  healthServer.close();
});
