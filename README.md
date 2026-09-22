# Oyot - Personal Knowledge Management System

> This project is in active development. IT IS NOT STABLE YET.

A local-first note-taking app that syncs directly between your own devices,
inspired by LogSeq. Built with Tauri (Rust) and SvelteKit (TypeScript).

There is no server holding your notes. Documents live in SQLite on each device
and move between paired devices over an encrypted peer-to-peer connection.

## Features

- **Open and write.** A journal entry for today is always there, so there is
  nowhere to file anything before you start.
- **Every day, in one list.** The sidebar calendar covers a month; the Journals
  index lists every day you have an entry for, newest first. Opening one from
  there moves the calendar to it.
- **Rich text editing.** Headings, lists, tables, task lists, images, and slash
  commands, built on Tiptap.
- **Document links and backlinks.** Link one note to another with `/document`.
  Each note shows what links back to it.
- **Full-text search.** Searches the text of your notes and journals, not just
  their titles.
- **Task lists.** Task items are counted per note and shown in the sidebar.
- **Peer-to-peer sync.** Pair two devices on one network and they reconcile
  their whole document set, including images, with no internet and no server
  anywhere in the middle. A device somewhere else is reached at an address you
  give it, over a VPN you already run.
- **Export.** Settings > Data writes every note out as a Markdown file, with
  the images they embed, in one zip. Nothing here is a format you can only
  read from inside Oyot.

## Sync

Devices sync directly over WebRTC. They find each other in one of two ways, and
neither needs an account, a server, or anything run by us.

On one network, they find each other by themselves over mDNS. Elsewhere, you
tell one device where the other is, and it checks.

- Each device's ID is an Ed25519 public key, and every signaling message is
  signed, so nothing on the network can forge, alter or replay one.
- Pairing is explicit. You read one device's ID on another (by hand or by QR
  code) and confirm the prompt. Devices do announce themselves on the network,
  but an announcement is only an address: nothing syncs until you have
  confirmed the ID.
- Documents reconcile as a whole set on every connection, so devices converge
  after being apart without a central copy to fall back on.
- Note content never leaves the two devices, and is encrypted in transit by
  WebRTC's DTLS.

### Devices that are not on one network

Settings > Sync takes an address for a device: a host name or an IP that does
not change. The reliable way to have one is a VPN you already run between your
own machines, such as Tailscale, where every device has a stable name and
address. Add the other device's address on this one, and this device's address
over there, and they reach each other from anywhere.

Oyot does not install, configure or manage the VPN, and does not know whether
you have one. It only uses the address. Nothing else changes: the same signed
handshake, the same encrypted data channel, the same documents.

**What this does not do:** it is not a fallback that happens by itself. Two
devices with no shared network and no address for each other do not sync, and
the app says so rather than queueing. An earlier version reached them through
an MQTT broker;
[ADR 0022](./docs/decisions/0022-drop-the-broker-and-sync-only-on-the-local-network.md)
records why that was removed, and
[ADR 0023](./docs/decisions/0023-reach-a-peer-at-an-address-you-already-know.md)
why the replacement is an address rather than a server.

Local discovery works on desktop and Android. iOS needs a Bonjour backend that
does not exist yet, so an iOS device finds nothing on its own network; it can
still sync with devices you have given it an address for.

The design decisions behind all of this, including what each one gives up, are
in [docs/decisions](./docs/decisions).

## Platforms

Desktop (macOS, Windows, Linux) and mobile (Android, iOS). Android release
builds are produced by CI; other platforms are built locally for now.

## Tech Stack

- **Frontend**: SvelteKit 2, Svelte 5, TypeScript, Tiptap
- **Backend**: Rust, Tauri 2
- **Storage**: SQLite (rusqlite), Yjs CRDTs for document content
- **Sync**: WebRTC data channels, with mDNS on the local network for
  signaling

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, build, and release
instructions.

## License

MIT. See [LICENSE](./LICENSE).
