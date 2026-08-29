# Retry / Reconnect + Glare Handling - Implementation Plan

## Goals

1. **MQTT broker retry** - the signaling client automatically re-establishes its
   connection to the MQTT broker after a network drop or broker restart, with
   backoff, and re-subscribes to its topics on every (re)connect.
2. **Paired-device reconnect** - WebRTC data-channel connections to already-paired
   devices are re-established automatically: on app start, when MQTT signaling
   comes back, and after a peer connection drops (with backoff).
3. **Glare / offer-collision handling** - implement the WHATWG **perfect
   negotiation** pattern so two peers that offer at the same time (both running a
   reconnect sweep, or both doing an ICE restart) converge on one connection
   instead of corrupting each other's state.

Non-goals (track separately): broker auth/TLS, TURN servers, the discovery/QR
pairing UX items in `CURRENT_ISSUES.md`.

---

## Current state (reference)

| Concern | Where | Behaviour today |
| --- | --- | --- |
| MQTT connect | `src-tauri/src/network/mqtt_client.rs:35` | one-shot; `MqttOptions` has no reconnect config |
| MQTT event loop | `mqtt_client.rs:64-102` | on `poll()` `Err` -> emit `Disconnected`, **`break`** (task dies permanently) |
| MQTT subscribe | `signaling_manager.rs:100-102` | subscribes once in `connect()`; never replayed |
| `disconnect()` | `signaling_manager.rs:257` | drops client `Option`; the spawned poll task is not signalled |
| `get_mqtt_status` | `commands/mqtt.rs:85` | returns `connected` whenever `mqtt_client.is_some()` (stale once loop dies) |
| FE connect | `WebRtcSyncService.ts:279` (`initSync`) | calls `mqtt_connect` once at startup; sets status `connected` optimistically |
| FE status listener | `WebRtcSyncService.ts:704` | registered **after** `mqtt_connect`, so the first `Connected` can be missed |
| Paired reconnect | `WebRtcSyncService.ts:441` (`reconnectToPeer`) | only called from the manual "Reconnect" button (`ConnectedPeerList.svelte:52`, wired via `settings/sync/+page.svelte:92`) - to be removed, see B6 |
| Peer drop | `WebRtcSyncService.ts:408-412`, `:507-511`, `:625-629` | tears down room, no retry |
| Offer/answer/ICE | `createOfferConnection` / `acceptConnection` | asymmetric; `pendingConnections`/`roomDocs` keyed by peer id with one slot, no session tag -> simultaneous offers clobber each other |
| `peer-disconnected` (Rust) | `lib.rs:123,149` | emitted, no FE listener |

Deps already available: `rumqttc = "0.24"`, `tokio = { features = ["full"] }`
(so `tokio::sync::watch`, `tokio::time` are available). No `tokio-util`.

---

## Part A - MQTT broker retry (Rust)

### A1. Add connection-state + shutdown primitives to `MqttSignalingClient`

File: `src-tauri/src/network/mqtt_client.rs`

Extend the struct:

```rust
pub struct MqttSignalingClient {
    client: rumqttc::AsyncClient,
    event_tx: broadcast::Sender<MqttEvent>,
    connected: Arc<AtomicBool>,          // true only while a session is live (post-ConnAck)
    shutdown_tx: watch::Sender<bool>,    // set true -> poll loop exits
    topics: Arc<Vec<String>>,            // fully-qualified topics to (re)subscribe on every ConnAck
}
```

- Update the manual `Clone` impl to clone all fields (`Arc` / `Sender` clones are cheap;
  `watch::Sender` is `Clone` in tokio 1.x - if pinned tokio predates that, store it as
  `Arc<watch::Sender<bool>>`).
- Add helpers:
  ```rust
  pub fn is_connected(&self) -> bool { self.connected.load(Ordering::Relaxed) }
  pub fn shutdown(&self) { let _ = self.shutdown_tx.send(true); }
  ```

### A2. Build the topic list in the constructor

`MqttSignalingClient::new` currently takes `(broker_url, node_id)`. Have it compute the
node-scoped topics itself (moved out of `signaling_manager::connect`):

```rust
let topics: Vec<String> = ["pair-request","pair-response","offer","answer","ice-candidate"]
    .iter().map(|s| format!("signaling/{node_id}/{s}")).collect();
```

Keep `connect()`'s explicit `subscribe` calls **removed** - subscription now happens
inside the poll loop's `ConnAck` handler so it is replayed after every reconnect.

### A3. Rewrite the poll loop: backoff + `continue`, re-subscribe on ConnAck

Replace `mqtt_client.rs:64-102` with a loop that:

1. Selects between the shutdown signal and `event_loop.poll()`:
   ```rust
   let mut shutdown_rx = shutdown_tx.subscribe();
   let mut backoff = Duration::from_secs(1);
   loop {
       tokio::select! {
           _ = shutdown_rx.changed() => {
               if *shutdown_rx.borrow() {
                   let _ = client_clone.disconnect().await; // best-effort graceful
                   break;
               }
           }
           res = event_loop.poll() => match res {
               Ok(notification) => {
                   backoff = Duration::from_secs(1); // healthy traffic -> reset
                   match notification {
                       Event::Incoming(Packet::ConnAck(_)) => {
                           connected.store(true, Ordering::Relaxed);
                           for t in topics.iter() {
                               if let Err(e) = client_clone
                                   .subscribe(t, QoS::AtLeastOnce).await {
                                   eprintln!("[MQTT] re-subscribe {t} failed: {e}");
                               }
                           }
                           let _ = event_tx_clone.send(MqttEvent::Connected);
                       }
                       Event::Incoming(Packet::Publish(publish)) => { /* unchanged parse + emit */ }
                       Event::Incoming(Packet::SubAck(_)) => { /* log */ }
                       _ => {}
                   }
               }
               Err(e) => {
                   eprintln!("[MQTT] connection error: {e}; retrying in {backoff:?}");
                   if connected.swap(false, Ordering::Relaxed) {
                       let _ = event_tx_clone.send(MqttEvent::Disconnected);
                   }
                   tokio::time::sleep(backoff).await;
                   backoff = (backoff * 2).min(Duration::from_secs(30));
                   // do NOT break - next poll() drives rumqttc's own reconnect
               }
           }
       }
   }
   connected.store(false, Ordering::Relaxed);
   ```
2. Notes:
   - rumqttc 0.24 `EventLoop::poll()` re-attempts the TCP/MQTT connect on the next
     call after an error; our `sleep(backoff)` just prevents a hot error loop
     (0.24 `MqttOptions` has no built-in delay).
   - `Disconnected` is emitted **once** per healthy->broken transition (guarded by
     `connected.swap`), so the FE does not get a burst of `disconnected` events
     during a long outage.
   - Emitting `Connected` only *after* the re-subscribe calls means the FE's
     "signaling ready" state lines up with actually being able to receive offers.

### A4. `SignalingManager`: shut down the previous client on reconnect/disconnect

File: `src-tauri/src/network/signaling_manager.rs`

- `connect()` (`:93`): before overwriting `*self.mqtt_client.lock()`, call
  `.shutdown()` on any existing client so its poll loop and the publish task from
  the old generation stop. Then drop/replace `publish_tx` (dropping the old
  `mpsc::Sender` ends the old publish task's `while let Some(..)` loop).
- `disconnect()` (`:257`): call `client.shutdown()` on the stored client before
  setting the `Option` to `None`.
- Remove the explicit `client.subscribe(...)` loop at `:100-102` (now in A3).
- The `event_rx` forwarding task (`:132-153`) already handles `Connected` /
  `Disconnected` / `Message`; no change beyond it now receiving repeated
  `Connected`/`Disconnected` across the app's lifetime. Make sure it does **not**
  exit on a single error - it uses `while let Ok(event) = event_rx.recv().await`,
  which exits only when all senders drop (fine; the broadcast sender lives in the
  client).

### A5. Real status command

File: `src-tauri/src/commands/mqtt.rs:85`

```rust
#[tauri::command]
pub fn get_mqtt_status(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.signaling_manager.mqtt_connection_status()) // "connected" | "connecting" | "disconnected"
}
```

Add `SignalingManager::mqtt_connection_status()`:
- no client stored -> `"disconnected"`
- client stored, `is_connected()` false -> `"connecting"`
- client stored, `is_connected()` true -> `"connected"`

### A6. Emit a `connecting` status event

In the `event_rx` task, also emit `mqtt-status` = `"connecting"` right when
`connect()` stores the client (before the first ConnAck). Simplest: emit it
synchronously in `connect()` via `app_handle.emit("mqtt-status", "connecting")`
just after `MqttSignalingClient::new` returns.

---

## Part B - Paired-device reconnect (frontend)

File: `src/lib/services/WebRtcSyncService.ts` (+ `src/lib/stores/sync.ts`)

### B1. Fix listener ordering in `initSync`

Move `setupEventListeners()` **before** the `mqtt_connect` invoke (`:292`) so the
first `mqtt-status` / offer events during connect are not dropped. `initSync` becomes:

1. load identity, broker url
2. `await setupEventListeners()`
3. if broker url present: set status `connecting`, `invoke('mqtt_connect', ...)`
   (do **not** optimistically set `connected` - let the `mqtt-status` event do it)
4. `await refreshPairedDevices()`

### B2. Status enum + reconnect trigger

`sync.ts`: `SignalingStatus` already has `connecting`. Keep
`'disconnected' | 'connecting' | 'connected' | 'error'`.

`mqtt-status` listener (`:704`):

```ts
const prev = get(signalingStatus);
syncStore.setSignalingStatus(next);
if (next === 'connected' && prev !== 'connected') {
    void reconnectAllPairedDevices('mqtt-connected');
}
if (next === 'disconnected' || next === 'error') {
    pauseAllReconnects();          // clear timers, mark sessions stale (B4)
}
```

### B3. `reconnectAllPairedDevices(reason)`

```ts
let sweepRunning = false;

export async function reconnectAllPairedDevices(reason: string): Promise<void> {
    if (sweepRunning) return;
    if (get(signalingStatus) !== 'connected') return;
    sweepRunning = true;
    try {
        await refreshPairedDevices();
        const pairs = get(pairedDevices);
        const connectedRooms = new Set(get(connectedPeers).map(p => p.room_id));
        for (const pair of pairs) {
            if (connectedRooms.has(pair.room_id)) continue;
            if (sessions.get(pair.peer_node_id)?.pc.connectionState === 'connecting') continue;
            // stagger to avoid a burst of simultaneous negotiations
            await sleep(jitter(150, 400));
            void ensurePeerConnection(pair.peer_node_id, pair.room_id, pair.peer_display_name, {
                initiate: !isPolite(pair.peer_node_id),   // see Part C
            });
        }
    } finally {
        sweepRunning = false;
    }
}
```

- Called from: `initSync` (after listeners + first `refreshPairedDevices`, if
  status already `connected`) and the `mqtt-status` -> `connected` transition.
  No user action involved (see B6 - the manual button goes away).

### B4. Per-peer backoff on drop

Add to the `PeerSession` (Part C) a reconnect scheduler:

```ts
function scheduleReconnect(peerNodeId: string): void {
    const s = sessions.get(peerNodeId);
    if (!s) return;
    if (s.reconnectTimer) return;
    if (get(signalingStatus) !== 'connected') return;      // wait for B2 trigger instead
    const pair = get(pairedDevices).find(p => p.peer_node_id === peerNodeId);
    if (!pair) return;                                       // unpaired -> don't retry
    const attempt = s.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** attempt, 30_000) + jitter(0, 1000);
    s.reconnectTimer = setTimeout(() => {
        s.reconnectTimer = undefined;
        teardownSession(peerNodeId, { keepAttempts: true });
        void ensurePeerConnection(pair.peer_node_id, pair.room_id, pair.peer_display_name, {
            initiate: !isPolite(pair.peer_node_id),
        });
    }, delay);
}
```

- Call `scheduleReconnect(peerNodeId)` from:
  - `pc.onconnectionstatechange` when state is `failed` (immediately) or
    `disconnected` (after a short grace timer - `disconnected` often self-heals).
  - `channel.onclose`.
- Reset `reconnectAttempts = 0` and clear any grace timer when `pc.connectionState`
  reaches `connected`.
- `pauseAllReconnects()`: for every session clear `reconnectTimer` / grace timer
  and set `reconnectAttempts = 0` (the next `mqtt-connected` sweep restarts them).

### B6. Remove the manual "Reconnect" UI

With B2-B4 the app reconnects paired devices on its own (startup, MQTT recovery,
and per-peer backoff after a drop), so the button is dead weight and, worse,
races the automatic path if a user taps it mid-backoff.

- `src/lib/settings/ConnectedPeerList.svelte`
  - drop the `onReconnect` prop from `Props` and the destructure (`:15`, `:18`)
  - delete the `<button class="btn-secondary" ...>Reconnect</button>` (`:52-54`)
  - the offline branch now shows only **Remove**. Replace the bare `Offline`
    pill with a live hint driven by session state:
    - `Connecting…` when a `PeerSession` exists for `pair.peer_node_id` and its
      `pc.connectionState` is `connecting`/`new`, **or** a `reconnectTimer` is armed
    - `Offline` otherwise
    Expose this via a derived store (e.g. `reconnectingPeerIds` in `sync.ts`,
    updated by `ensurePeerConnection` / `scheduleReconnect` / `teardownSession`)
    so the component stays prop-driven.
- `src/routes/settings/sync/+page.svelte`
  - remove `reconnectToPeer` from the import (`:21`), the `handleReconnect`
    function (`:92-94`), and the `onReconnect={handleReconnect}` prop (`:131`)
- `src/lib/services/WebRtcSyncService.ts`
  - `reconnectToPeer` is no longer exported/used - delete it (its body is just
    `ensurePeerConnection(..., { initiate: true, force: true })`, which the
    automatic paths call directly)
- Keep `disconnectPeer` / the **Disconnect** button - still a valid manual action
  (it also needs to suppress auto-reconnect; see note below).

**Disconnect vs auto-reconnect:** since `scheduleReconnect` fires on any drop,
a user-initiated `disconnectPeer` must not immediately be undone. Add a
`suppressReconnect: Set<string>` (peer node_ids) that `disconnectPeer` populates
and `scheduleReconnect` / `reconnectAllPairedDevices` check; clear it when the
user removes the pair or triggers a connect some other way. (Pairs the user wants
gone should use **Remove**, not Disconnect, so this mainly guards the
"temporarily stop syncing to this device" case.)

### B5. Rust `peer-disconnected` (optional, low priority)

Add a listener that maps `peer-disconnected` (payload = peer node_id) to
`scheduleReconnect`, as a backstop for cases where the JS `RTCPeerConnection`
callbacks don't fire. Safe because `scheduleReconnect` is idempotent.

---

## Part C - Perfect negotiation (glare handling)

Replaces `createOfferConnection` (`:354`) and `acceptConnection` (`:445`) with one
symmetric path. This is the largest change.

### C1. Politeness

Deterministic, needs no exchange - `node_id`s are unique UUIDs:

```ts
function isPolite(peerNodeId: string): boolean {
    // impolite = lexicographically-smaller node_id; it wins collisions.
    return identity!.node_id > peerNodeId;
}
```

The **impolite** peer, on a collision, keeps its own offer and ignores the
incoming one; the **polite** peer rolls back and accepts.

### C2. `PeerSession` model

Replace `pendingConnections: Map<string, RTCPeerConnection>` with:

```ts
interface PeerSession {
    peerNodeId: string;
    roomId: string;
    displayName: string;
    pc: RTCPeerConnection;
    polite: boolean;
    epoch: number;                 // bumped on every teardown/rebuild
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
    dataChannel: RTCDataChannel | null;
    reconnectAttempts: number;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    graceTimer?: ReturnType<typeof setTimeout>;
    promoteTimer?: ReturnType<typeof setTimeout>;
}
const sessions = new Map<string, PeerSession>();   // one per peer node_id
```

`roomDocs` (keyed by `roomId`) stays as the doc-sync layer; a session owns exactly
one room.

### C3. `ensurePeerConnection`

```ts
interface EnsureOpts { initiate: boolean; force?: boolean }

async function ensurePeerConnection(
    peerNodeId: string, roomId: string, displayName: string, opts: EnsureOpts,
): Promise<void> {
    if (!identity) return;
    const existing = sessions.get(peerNodeId);
    if (existing && !opts.force) {
        const st = existing.pc.connectionState;
        if (st === 'connected' || st === 'connecting' || st === 'new') return;
        teardownSession(peerNodeId, { keepAttempts: true });
    } else if (existing) {
        teardownSession(peerNodeId, { keepAttempts: true });
    }

    const polite = isPolite(peerNodeId);
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const session: PeerSession = {
        peerNodeId, roomId, displayName, pc, polite,
        epoch: (existing?.epoch ?? 0) + 1,
        makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false,
        dataChannel: null,
        reconnectAttempts: existing?.reconnectAttempts ?? 0,
    };
    sessions.set(peerNodeId, session);

    // roomDoc so setupDataChannel() can attach (peer/display_name for the store)
    roomDocs.set(roomId, { peer: { id: peerNodeId, display_name: displayName }, roomId, channel: null });

    pc.onnegotiationneeded = async () => {
        try {
            session.makingOffer = true;
            await pc.setLocalDescription();                       // implicit createOffer
            await sendDescription(peerNodeId, session, pc.localDescription!);
        } catch (e) {
            console.error(`[WebRtcSync] [${peerNodeId}] negotiationneeded failed:`, e);
        } finally {
            session.makingOffer = false;
        }
    };

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) void sendIce(peerNodeId, session, candidate);
    };

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
            try { pc.restartIce(); } catch { /* older impls */ }
        }
    };

    pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') {
            session.reconnectAttempts = 0;
            clearTimeout(session.graceTimer); session.graceTimer = undefined;
            clearTimeout(session.promoteTimer); session.promoteTimer = undefined;
            syncStore.addConnectedPeer({ peer_node_id: peerNodeId, peer_display_name: displayName, room_id: roomId });
            void invoke('save_pair', { peerNodeId, peerDisplayName: displayName, roomId })
                .then(refreshPairedDevices).catch(() => {});
        } else if (st === 'failed') {
            syncStore.removeConnectedPeer(roomId);
            scheduleReconnect(peerNodeId);
        } else if (st === 'disconnected') {
            syncStore.removeConnectedPeer(roomId);
            session.graceTimer ??= setTimeout(() => {
                if (pc.connectionState === 'disconnected') scheduleReconnect(peerNodeId);
            }, 5000);
        }
    };

    pc.ondatachannel = ({ channel }) => {
        session.dataChannel = channel;
        const rd = roomDocs.get(roomId); if (rd) rd.channel = channel;
        setupDataChannel(channel, roomId);
    };

    if (opts.initiate) {
        const channel = pc.createDataChannel('yjs-sync', { ordered: true });   // triggers onnegotiationneeded
        session.dataChannel = channel;
        const rd = roomDocs.get(roomId); if (rd) rd.channel = channel;
        setupDataChannel(channel, roomId);
    } else if (polite) {
        // promotion fallback: if the impolite side never offers, become initiator
        session.promoteTimer = setTimeout(() => {
            if (pc.connectionState !== 'connected' && !session.dataChannel) {
                void ensurePeerConnection(peerNodeId, roomId, displayName, { initiate: true, force: true });
            }
        }, 6000);
    }
}
```

Data-channel ownership rule (avoids two channels while still glare-safe):

| Trigger | initiate |
| --- | --- |
| Initial pairing, pair-response receiver (`initiateOffer`) | `true` |
| Reconnect sweep / backoff, **impolite** side | `true` |
| Reconnect sweep / backoff, **polite** side | `false` + promote timer |
| Incoming offer, no session yet (`handleDescription`) | `false` |

Residual races (both promote, ICE restart from both sides, an initial-pairing
offer racing a sweep offer) are absorbed by C4.

### C4. Unified `handleDescription`

Both `mqtt-offer-received` and `mqtt-answer-received` funnel here:

```ts
async function handleDescription(from: string, envelope: DescEnvelope): Promise<void> {
    let session = sessions.get(from);

    if (!session) {
        if (envelope.description.type !== 'offer') return;      // stray answer, no session
        // inbound offer from a trusted peer (Rust already vetted it and gave us room_id)
        await ensurePeerConnection(from, envelope.roomId!, envelope.displayName!, { initiate: false });
        session = sessions.get(from)!;
    }

    // stale-epoch guard: ignore descriptions for a session we've since rebuilt
    if (envelope.epoch != null && envelope.epoch < session.epoch - 0) {
        // allow equal or newer; drop strictly older
        if (envelope.epoch < session.epoch && envelope.forRebuild !== true) { /* keep simple: */ }
    }

    const { pc } = session;
    const description = envelope.description;
    const readyForOffer =
        !session.makingOffer &&
        (pc.signalingState === 'stable' || session.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    session.ignoreOffer = !session.polite && offerCollision;
    if (session.ignoreOffer) {
        console.warn(`[WebRtcSync] [${from}] impolite: ignoring colliding offer`);
        return;
    }

    session.isSettingRemoteAnswerPending = description.type === 'answer';
    await pc.setRemoteDescription(description);     // polite peer: implicit rollback on collision
    session.isSettingRemoteAnswerPending = false;

    if (description.type === 'offer') {
        await pc.setLocalDescription();             // implicit createAnswer
        await sendDescription(from, session, pc.localDescription!);
    }
}
```

Delete `handleAnswer` (`:314`) and the `have-local-offer` guard - perfect
negotiation subsumes it.

### C5. Unified ICE handler

```ts
async function handleIceCandidate(from: string, envelope: IceEnvelope): Promise<void> {
    const session = sessions.get(from);
    if (!session) return;
    try {
        await session.pc.addIceCandidate(envelope.candidate);
    } catch (e) {
        if (!session.ignoreOffer) console.error(`[WebRtcSync] [${from}] addIceCandidate:`, e);
    }
}
```

### C6. Wire payload envelope (no Rust change needed)

`signaling_manager.rs` treats `SignalingMessage.payload` as an opaque string and
forwards it verbatim (`"sdp": msg.payload` at `:200` and `:252`, `"candidate":
msg.payload` at `:207`). So the frontend can put JSON in `payload` on both ends
with **zero Rust changes**.

```ts
type DescEnvelope = {
    epoch: number;
    description: RTCSessionDescriptionInit;
    roomId?: string;        // set by Rust for offers via the mqtt-offer-received event, not the payload
    displayName?: string;
};
type IceEnvelope = { epoch: number; candidate: RTCIceCandidateInit };

async function sendDescription(peerId: string, s: PeerSession, d: RTCSessionDescription) {
    const payload = JSON.stringify({ epoch: s.epoch, description: d.toJSON() } satisfies Omit<DescEnvelope,'roomId'|'displayName'>);
    const cmd = d.type === 'offer' ? 'mqtt_publish_offer' : 'mqtt_publish_answer';
    await invoke(cmd, { peerId, sdp: payload });
}
async function sendIce(peerId: string, s: PeerSession, c: RTCIceCandidate) {
    await invoke('mqtt_publish_ice_candidate', { peerId, candidate: JSON.stringify({ epoch: s.epoch, candidate: c.toJSON() }) });
}
```

Receiving side parses:

```ts
listen('mqtt-offer-received', (e) => {
    const { from, sdp, room_id, display_name } = e.payload;
    const env = JSON.parse(sdp) as DescEnvelope;   // sdp is now our JSON envelope
    env.roomId = room_id; env.displayName = display_name;
    void handleDescription(from, env);
});
listen('mqtt-answer-received', (e) => {
    const env = JSON.parse(e.payload.sdp) as DescEnvelope;
    void handleDescription(e.payload.from, env);
});
listen('mqtt-ice-candidate-received', (e) => {
    void handleIceCandidate(e.payload.from, JSON.parse(e.payload.candidate));
});
```

**Backward compatibility:** old clients send raw SDP strings, new clients send
JSON. Parse defensively:

```ts
function parseDesc(raw: string): DescEnvelope {
    try {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object' && 'description' in o) return o as DescEnvelope;
        if (o && typeof o === 'object' && 'type' in o) return { epoch: 0, description: o }; // bare RTCSessionDescriptionInit JSON (current format)
    } catch { /* not JSON */ }
    throw new Error('unrecognised description payload');
}
```

Note the **current** code already `JSON.stringify`s a bare `RTCSessionDescriptionInit`
(`:421`), so today's payload is `{"type":"offer","sdp":"..."}` - the second branch
above handles that, giving a smooth migration.

### C7. `epoch` use

- Bumped in `ensurePeerConnection` each rebuild.
- Sent on every description/ICE.
- On receive: drop envelopes with `epoch < session.epoch` (they belong to a torn-down
  attempt). Accept `epoch >= session.epoch`; if `epoch > session.epoch` it means the
  peer rebuilt - safe to proceed (our next offer/answer carries our own current epoch).
- Keeps late ICE from a dead attempt out of a fresh `pc`.

### C8. `teardownSession`

```ts
function teardownSession(peerNodeId: string, opts: { keepAttempts?: boolean } = {}): void {
    const s = sessions.get(peerNodeId);
    if (!s) return;
    clearTimeout(s.reconnectTimer); clearTimeout(s.graceTimer); clearTimeout(s.promoteTimer);
    try { s.dataChannel?.close(); } catch {}
    try {
        s.pc.onnegotiationneeded = null; s.pc.onicecandidate = null;
        s.pc.onconnectionstatechange = null; s.pc.oniceconnectionstatechange = null;
        s.pc.ondatachannel = null;
        s.pc.close();
    } catch {}
    const attempts = opts.keepAttempts ? s.reconnectAttempts : 0;
    sessions.delete(peerNodeId);
    if (!opts.keepAttempts) roomDocs.delete(s.roomId);
    // if keeping attempts, the caller is about to rebuild and will carry them via ensurePeerConnection
    void attempts;
}
```

Rewrite `cleanupRoom` (`:642`), `disconnectPeer` (`:655`), `disconnectAll` (`:660`)
in terms of `teardownSession` (look the session up by `roomId` -> `peerNodeId`).

### C9. `initiateOffer` / `reconnectToPeer`

```ts
export async function initiateOffer(peerNodeId: string, peerUserId: string, peerDisplayName: string) {
    if (!identity) return;
    const roomId = await calculateRoomId(identity.user_id, peerUserId);
    await ensurePeerConnection(peerNodeId, roomId, peerDisplayName, { initiate: true, force: true });
}
```

`reconnectToPeer` is **deleted** (see B6) - the reconnect sweep and per-peer
backoff call `ensurePeerConnection` directly.

---

## Wire protocol summary

| Message | `payload` today | `payload` after |
| --- | --- | --- |
| offer  | `JSON(RTCSessionDescriptionInit)` | `JSON({ epoch, description })` |
| answer | `JSON(RTCSessionDescriptionInit)` | `JSON({ epoch, description })` |
| ice    | `JSON(RTCIceCandidateInit)` | `JSON({ epoch, candidate })` |

Rust envelope (`SignalingMessage` `from/to/type/payload`) and all topic names are
**unchanged**. `mqtt-offer-received` still carries `room_id` + `display_name`
alongside the (now-JSON) `sdp` string.

---

## Files touched

**Rust**
- `src-tauri/src/network/mqtt_client.rs` - struct fields, topic list, poll loop rewrite, shutdown, `is_connected`
- `src-tauri/src/network/signaling_manager.rs` - shutdown previous client on connect/disconnect, drop the one-shot subscribe loop, `mqtt_connection_status()`, emit `connecting`
- `src-tauri/src/commands/mqtt.rs` - `get_mqtt_status` reads real state

**Frontend**
- `src/lib/services/WebRtcSyncService.ts` - Parts B + C (bulk of the work); delete `reconnectToPeer`
- `src/lib/stores/sync.ts` - add `reconnectingPeerIds` derived store for the "Connecting…" hint (B6)
- `src/routes/+layout.svelte` - none (initSync owns it)
- `src/routes/settings/sync/+page.svelte` - remove `reconnectToPeer` import, `handleReconnect`, `onReconnect` prop (B6)
- `src/lib/settings/ConnectedPeerList.svelte` - remove `onReconnect` prop + "Reconnect" button; offline pill becomes `Connecting…` / `Offline` (B6)

---

## Testing plan

### Rust (MQTT retry)
1. **Broker restart** - connect, `docker restart mosquitto`; expect `mqtt-status`
   `disconnected` then `connected` within backoff, and a fresh `SubAck` per topic
   in logs. A pair-request sent from the other device after the blip is received.
2. **Broker down at startup** - launch app with broker offline; status stays
   `connecting`; bring broker up; status -> `connected` without user action.
3. **`mqtt_disconnect`** - poll-loop log line "shutdown" appears; no further
   reconnect attempts; `get_mqtt_status` -> `disconnected`.
4. **Broker URL change** - `save_mqtt_broker_url` + `mqtt_connect` again; old
   generation's logs stop, no duplicate subscriptions.
5. Backoff cap: pull the network for 5 min, confirm interval tops out at ~30 s and
   only one `Disconnected` event was emitted.

### Frontend (paired reconnect)
6. **App restart** - device A restarts; within a few seconds it re-shows the peer
   as connected (sweep on `mqtt-connected`).
7. **Wi-Fi bounce on one device** - toggle airplane mode ~20 s; connection drops
   then re-establishes via backoff; Yjs edits made during the outage converge.
8. **Unpair during outage** - remove the pair while disconnected; confirm
   `scheduleReconnect` bails (no pair row) and no zombie session remains.
8b. **Manual Disconnect** - tap Disconnect on a connected peer; confirm it stays
   offline (not auto-reconnected) until app restart or a Remove+re-pair; the
   peer's row shows `Offline`, not `Connecting…`.
8c. **UI** - no "Reconnect" button anywhere; an offline peer with an armed
   backoff timer shows `Connecting…`.

### Glare (perfect negotiation)
9. **Simultaneous sweep** - kill the broker, make both devices reconnect at the
   same instant by restoring the broker; both run the sweep. Expect exactly one
   `RTCPeerConnection` per side ending `connected`, one `yjs-sync` data channel,
   no leaked PCs (`sessions.size === pairedDevices count`), impolite side logs
   "ignoring colliding offer".
10. **Double ICE restart** - force `iceConnectionState = failed` on both sides
    (block STUN briefly); both call `restartIce()`; connection recovers, single PC.
11. **Initial-pairing offer racing a sweep** - start a fresh pairing at the same
    moment the other device's sweep fires for that (now-just-saved) pair; converges.
12. **Stale ICE** - add artificial latency so ICE from a torn-down attempt
    arrives after rebuild; confirm epoch guard drops it (no `addIceCandidate`
    error spam).

---

## Sequencing / rollout

1. **Part A** (Rust MQTT retry) - self-contained, shippable alone; immediately
   fixes "goes offline and never comes back".
2. **B1** (listener ordering) + **A5/A6** (status accuracy) - small, ship with A.
3. **Part C** (perfect negotiation refactor) - land behind the existing manual
   reconnect path first; verify 1:1 pairing still works, then wire triggers.
4. **Part B2-B4** (automatic sweeps + backoff) - last, since it depends on C's
   `ensurePeerConnection` / `sessions` and multiplies the glare surface that C
   exists to handle.
5. **B6** (remove the manual "Reconnect" button) - only after B2-B4 are verified
   in the wild, so there is always a working reconnect path for testers. Ship it
   in the same release as B2-B4, not before.

Each part is independently testable; do not enable B's automatic sweeps until C
is merged and tests 9-12 pass.

---

## Risks / open questions

- **rumqttc 0.24 `watch::Sender: Clone`** - if the pinned tokio is old enough that
  `watch::Sender` isn't `Clone`, wrap it in `Arc`. (tokio 1.x full is fine for
  `watch` itself.)
- **`setLocalDescription()` with no args** - needs a reasonably modern WebRTC
  impl (Tauri uses the system WebView: WKWebView / WebView2 / WebKitGTK). All
  current versions support argument-less `setLocalDescription` and implicit
  rollback. Confirm on the oldest Android WebView the app targets; fallback is
  explicit `createOffer`/`createAnswer` + manual `{type:'rollback'}`.
- **`restartIce()` support** - same concern; guarded with try/catch, and ICE
  failure still triggers `scheduleReconnect` as a backstop.
- **Migration window** - during a mixed-version rollout, `parseDesc` handles both
  formats; epoch defaults to 0 for old-format messages, which is `< session.epoch`
  after the first rebuild. Keep the "accept epoch 0 when session.epoch === 1 and
  no prior description seen" leniency, or simply treat missing epoch as "current".
- **`save_pair` on every connect** - `onconnectionstatechange === 'connected'`
  calls `save_pair` + `refreshPairedDevices` each reconnect; fine but noisy.
  Consider only calling it when the row is missing or `last_synchronized` is old.
- **Promotion timer value (6 s)** vs MQTT backoff (up to 30 s) - if the impolite
  peer is still reconnecting to MQTT when the polite peer's promote timer fires,
  the polite peer initiates and the impolite peer answers on arrival. Acceptable;
  perfect negotiation covers the overlap if the impolite peer also offers.
