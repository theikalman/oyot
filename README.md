# Oyot - Personal Knowledge Management System

> This project is in active development. IT IS NOT STABLE YET.

A local-first note-taking app that syncs directly between your own devices,
inspired by LogSeq. Built with Tauri (Rust) and SvelteKit (TypeScript).

There is no server holding your notes. Documents live in SQLite on each device
and move between paired devices over an encrypted peer-to-peer connection.

## Features

- **Open and write.** A journal entry for today is always there, so there is
  nowhere to file anything before you start.
- **Rich text editing.** Headings, lists, tables, task lists, images, and slash
  commands, built on Tiptap.
- **Document links and backlinks.** Link one note to another with `/document`.
  Each note shows what links back to it.
- **Full-text search.** Searches the text of your notes and journals, not just
  their titles.
- **Task lists.** Task items are counted per note and shown in the sidebar.
- **Peer-to-peer sync.** Pair two devices and they reconcile their whole
  document set, including images, whenever they can reach each other. On the
  same network that needs no internet at all.

## Sync

Devices sync directly over WebRTC. On the same network they find each other and
need nothing else. For devices that are not, an MQTT broker is used only to
introduce them; it never sees document content, and it does not need to be
trusted:

- Each device's ID is an Ed25519 public key, and every signaling message is
  signed. A broker can relay messages but cannot forge, alter or replay one.
- Pairing is explicit. You read one device's ID on another (by hand or by QR
  code) and confirm the prompt. Devices do announce themselves on a local
  network, but an announcement is only an address: nothing syncs until you
  have confirmed the ID.
- Documents reconcile as a whole set on every connection, so devices converge
  after being apart without a central copy to fall back on.

You need a broker for devices that are not on the same network.
`docker compose up -d` starts one for development: anonymous, on every
interface, so a laptop and a phone can both reach it. That is deliberate
rather than lax, because the signatures above are what make a message
trustworthy, not the broker. It does still see who is pairing with whom, so do
not expose it beyond a network you trust; see
[DEVELOPMENT.md](./DEVELOPMENT.md) for the hardened configuration, with
authentication, per-device topic rules and TLS.

A device can also be set to use the local network only, in Settings > Sync, in
which case it never contacts a broker at all and syncs with devices that are
on the network with it. Local discovery works on desktop today; Android and
iOS still go through the broker.

The design decisions behind all of this, including what each one gives up, are
in [docs/decisions](./docs/decisions).

## Platforms

Desktop (macOS, Windows, Linux) and mobile (Android, iOS). Android release
builds are produced by CI; other platforms are built locally for now.

## Tech Stack

- **Frontend**: SvelteKit 2, Svelte 5, TypeScript, Tiptap
- **Backend**: Rust, Tauri 2
- **Storage**: SQLite (rusqlite), Yjs CRDTs for document content
- **Sync**: WebRTC data channels; mDNS on a local network and MQTT elsewhere
  for signaling

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, build, and release
instructions.

## License

MIT. See [LICENSE](./LICENSE).
