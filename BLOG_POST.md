# Building Oyot: A Local-First, P2P-Synced Knowledge Management App

**By Aji (10+ YoE Software Engineer)**

---

## The Problem

Note-taking apps are everywhere, but they all share the same fundamental flaw:
they hold your data hostage. Evernote, Notion, Google Keep — they are all
servers you don't control. You pay with money, privacy, or both. Offline
support is an afterthought. Sync is through a central cloud. You own nothing.

I wanted something different. A note-taking app that:

- Works offline first, always
- Syncs directly between my devices — no cloud intermediate
- Is truly cross-platform (desktop + mobile)
- Lets me own my data and my infrastructure
- Is simple to use — open it and write

This is **Oyot**.

---

## Architectural Philosophy: Local-First

The core architectural decision was **local-first**. The primary data store is
on-device. The network is a convenience, not a requirement. This inverts the
traditional client-server model:

| Aspect | Traditional SaaS | Local-First (Oyot) |
|---|---|---|
| Primary data | Server-side database | Local SQLite database |
| Offline usage | Limited or broken | Full functionality |
| Sync | Client pulls from server | P2P, CRDT-based merge |
| Data ownership | Vendor | You |
| Infrastructure | Required (server) | Optional (self-hosted) |

This is not just a philosophical stance — it has practical implications. When
you are on a plane, in a tunnel, or in a country with aggressive internet
filtering, your notes just work. Always.

---

## The Tech Stack

### Frontend: SvelteKit + Svelte 5 + TypeScript

I chose SvelteKit over React for a few reasons. Svelte compiles away the
framework — there is no virtual DOM, no diffing overhead, no hydration
mismatches. The resulting binary is smaller and the runtime is faster. For a
Tauri app where the web view is embedded in a native shell, every kilobyte
matters.

Svelte 5's runes (`$state`, `$derived`, `$effect`) bring explicit reactivity
without the ceremony of React hooks. The mental model is closer to how the DOM
actually works.

TypeScript in strict mode catches an entire class of bugs at compile time. For
a project with a Rust backend, the type discipline carries across the language
boundary — the IPC contract between frontend and backend is well-defined.

### Backend: Rust + Tauri 2.0

Rust is the obvious choice for a local-first app. Memory safety without GC,
zero-cost abstractions, and cross-compilation to every platform we target.
Tauri 2.0 provides:

- Native window management (no Electron overhead)
- File system access
- SQLite integration via `rusqlite`
- Mobile support (Android + iOS) through the same codebase

The IPC boundary between TypeScript and Rust is explicit and type-safe. Every
backend command is registered in Rust and called via `invoke()` from the
frontend. There is no hidden magic, no ORM, no framework abstraction leaking.

### Rich Text: Tiptap (ProseMirror) + Yjs

Tiptap is a headless rich text editor built on ProseMirror, the gold standard
for web-based editing. It is extensible, predictable, and well-documented.

Yjs provides the CRDT (Conflict-free Replicated Data Type) layer. More on that below.

--- 

## The Sync Architecture: Why We Do Not Use a (Public) Relay Server

The sync design went through several iterations. The early prototype used
**iroh** — a Rust library for P2P connectivity that handles NAT traversal,
relay, and discovery. Iroh is elegant and well-engineered. However, there was a
problem.

### The GCC Problem

Iroh (like Tailscale, like WireGuard) relies on relay servers for NAT traversal
when direct connections fail. These relay servers use protocols that are
identifiable by **Deep Packet Inspection (DPI)**. In GCC (Gulf Cooperation
Council) countries — UAE, Saudi Arabia, Qatar, etc. — DPI is pervasive.
Internet traffic is inspected, classified, and throttled. Relay protocols that
look like VPNs are blocked wholesale.

This is not theoretical. Users in these countries could not connect. The app
simply did not work. You can't call your friends via WhatsApp, only text messages.
You have to use direct phone numbers for calls.

### The Solution: WebRTC + MQTT

WebRTC is globally available because browsers made it so. Every browser
implements `RTCPeerConnection`. ISPs cannot block it without breaking the web
itself. WebRTC is the thin end of the wedge — once the browser vendors
standardized it, network-level blocking became impractical.

The trade-off is that WebRTC still needs **signaling** (to exchange offers,
answers, and ICE candidates) and sometimes a **TURN relay** (when symmetric NAT
defeats STUN). The key insight: you can self-host both components.

**MQTT** serves as the signaling layer. It is lightweight, pub/sub, and
well-understood. Each device publishes WebRTC offers and ICE candidates to MQTT
topics. The other device subscribes and responds. Once the WebRTC data channel
is open, MQTT is out of the loop — all data flows P2P.

I chose **Eclipse Mosquitto** as the MQTT broker. It runs on any $5 VPS, uses
minimal resources, and requires no persistent storage (signaling messages are
ephemeral).

The architecture:

```
┌──────────┐  MQTT (signaling)   ┌──────────┐
│ Device A │─────────────────────▶│  MQTT    │◀─────────────────────│ Device B │
│          │◀─────────────────────│  Broker  │──────────────────────│          │
└────┬─────┘                      └──────────┘                     └────┬─────┘
     │                        │
     └─────── WebRTC Data Channel (Yjs updates) ────────┘
                        Direct P2P
```

For the actual media/data relay, I can deploy a self-hosted TURN server
(coturn) on the same infrastructure. This bypasses the DPI problem entirely —
the relay is just a generic UDP/TCP packet forwarder, indistinguishable from
any other internet traffic.

### Alternative Considered: MQTT as the Primary Transport

A natural question: why not skip WebRTC and sync over MQTT directly? MQTT
supports QoS, retained messages, and pub/sub — it could work.

But MQTT is TCP-based and traverses NAT poorly. WebRTC handles NAT traversal
(STUN/TURN) as a first-class concern. WebRTC data channels are UDP-based (via
DTLS-SRTP) and work through symmetric NAT, carrier-grade NAT, and corporate
firewalls. MQTT alone would require a publicly reachable broker for every
device to connect to — and if the broker is public, it becomes a bottleneck and
a privacy concern.

WebRTC keeps the data plane truly P2P. The signaling (MQTT) is lightweight and
replaceable. This is the right separation of concerns.

---

## Conflict Resolution: Yjs CRDT

When multiple devices edit the same note offline and later sync, who wins? With
Operational Transformation (OT, used by Google Docs), the server is the
arbiter. With a **CRDT** (Conflict-free Replicated Data Type), there is no
server — the data structure itself converges automatically.

Yjs implements a CRDT algorithm based on a **linked list with tombstones** and
**interleaving-aware insert positioning**. Every character (or ProseMirror
node) is assigned a unique identifier that encodes:

- The **client ID** that created it
- A **clock value** (monotonically increasing per client)

When two edits conflict, Yjs merges them deterministically. The same set of
operations applied in any order produces the same result. No server, no
conflict resolution dialog, no data loss.

This is the foundation of the local-first model. Without CRDTs, P2P sync would
require a central authority or complex merge protocols.

### Snapshot Strategy

Yjs updates are stored as binary blobs in SQLite. Over time, the update log
grows unbounded. To prevent this, I implemented a **snapshot-based
consolidation**:

- Every 50 updates triggers a snapshot
- The snapshot captures the full document state as a single Yjs update
- Older updates are pruned from the database

This is the same strategy that Yjs recommends for production use. It keeps
storage bounded and load times fast, regardless of how many edits a document
has accumulated.

---

## Identity and Pairing

Each device generates a UUIDv4 on first launch — this is its `node_id`. Users
also have a `user_id`. When two devices want to sync, they exchange user IDs
(via QR code or manual entry).

The **room ID** for their shared WebRTC session is deterministically derived:

```
room_id = SHA-256(sort(user_id_A, user_id_B))
```

This is elegant because:

1. Both devices can compute the same room ID independently
2. No central service is needed to allocate rooms
3. The pairing is asynchronous — device A can publish an offer before device B is even online
4. SHA-256 ensures the room ID is unpredictable, preventing accidental collisions

---

## Data Model

The database is SQLite with a handful of tables:

- **documents** — The primary entity. Stores title, content type, CRDT state,
  TODO metadata, and creation/update timestamps.
- **document_links** — Tracks `[[wiki-style links]]` between notes for backlink
  resolution.
- **device_pairs** — Stores paired devices and their room IDs.
- **yjs_updates** — Append-only log of Yjs binary updates. Used for incremental
  sync with peers. Consolidated into snapshots periodically.
- **attachments** — Content-addressed image storage. Images are stored by
  SHA-256 hash, deduplicating identical files across notes.

The schema is deliberately minimal. There is no migration framework — the
schema is created in `lib.rs` on first launch. For a personal tool, simplicity
trumps flexibility.

---

## Cross-Platform Build Pipeline

Oyot targets **5 platforms**: macOS, Windows, Linux, Android, and iOS. Managing
this by hand would be a nightmare. Instead, GitHub Actions builds all platforms
in parallel on every release tag.

The CI pipeline:

1. Push a tag (`v1.0.0`)
2. GitHub Actions spins up Mac, Windows, and Linux runners
3. Each runner cross-compiles for its target + mobile targets
4. Artifacts are published as a draft GitHub Release

This required significant upfront investment — Android NDK toolchains, iOS
certificates, code signing profiles, and platform-specific build scripts. But
the result is a single `make release-tag VERSION=x.y.z` command that produces
installable binaries for every platform.

---

## Lessons Learned

### What Went Right

1. **Rust + Tauri was the right call.** The type safety, performance, and
   cross-compilation story are unmatched for a project of this scope.

2. **Local-first is liberating.** Developing without a server simplifies
   everything: no deployments, no databases to manage, no API rate limits, no
   GDPR compliance. The app is the product.

3. **CRDTs are magic.** Yjs made offline sync "just work" in a way that OT
   never could. The developer experience is excellent.

### What I Would Do Differently

1. **MQTT as signaling is a leaky abstraction.** While it works, it requires
   users to run a Mosquitto broker. For a consumer product, this is too much
   friction. A future version might embed a WebRTC signaling server directly in
   the app (one device acts as the signaling bridge).

2. **Snapshot strategy needs tuning.** The fixed threshold of 50 updates works
   for notes, but not for large documents with frequent edits. An adaptive
   strategy based on update size or frequency would be more robust.

3. **Mobile is harder than it looks.** Tauri's mobile support works, but the
   ergonomics are not where desktop is. Debugging on device requires patience.

---

## The Bigger Picture

Oyot is not just a note-taking app. It is a demonstration that **local-first,
P2P-synced software is viable today**. The components exist — CRDTs for data
(Yjs), native shells (Tauri), P2P networking (WebRTC), lightweight signaling
(MQTT). What was missing was someone putting them together in a coherent
product.

The GCC DPI problem taught me something important: **freedom from censorship is
not a feature — it is an architectural prerequisite**. If your app cannot work
under adversarial network conditions, it does not work for a significant
portion of the world. Designing for these constraints from the start produces
better software for everyone.

---

## Tech Stack Summary

| Category | Choice |
|---|---|
| Desktop framework | Tauri 2.0 (Rust) |
| Frontend | SvelteKit 2, Svelte 5, TypeScript |
| Rich text | Tiptap 3 (ProseMirror) |
| CRDT | Yjs 13 |
| P2P transport | WebRTC (browser native) |
| Signaling | MQTT (Eclipse Mosquitto) |
| Database | SQLite (rusqlite) |
| Identity | UUIDv4 + SHA-256 pairing |
| Attachments | SHA-256 content addressing |
| Build | Vite 6, GitHub Actions CI |
| Platforms | macOS, Windows, Linux, Android, iOS |

The full source code is available at **[github.com/ikalman/oyot](https://github.com/ikalman/oyot)** (MIT license).
