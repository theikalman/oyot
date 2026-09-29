# Oyot - Personal Knowledge Management System

> This project is in active development. IT IS NOT STABLE YET.

A local-first note-taking app that syncs directly between your own devices,
inspired by LogSeq. Built with Tauri (Rust) and SvelteKit (TypeScript).

There is no server holding your notes. Documents live in SQLite on each device
and move between paired devices over an encrypted peer-to-peer connection.

## Features

- **Open and write.** A journal entry for today is always there, so there is
  nowhere to file anything before you start.
- **Every day, in one list.** The sidebar calendar covers a month, with a dot
  on each day you have written on, orange while a task on it is still to do;
  the Journals index lists every day you have an entry for, newest first.
  Opening one from there moves the calendar to it.
- **Pinned notes.** The sidebar holds only the notes you pin, from a note's own
  page or from the Notes index, which lists every note with a filter. Pins
  follow you to your other devices, and into your backups.
- **Rich text editing.** Headings, lists, tables, task lists, images, and slash
  commands, built on Tiptap.
- **Reading first.** Notes and journals open for reading, without the toolbar
  and with nothing a stray tap can change, though tasks can still be ticked
  off. Press Edit, or Cmd/Ctrl+Shift+E, to write, and Done to go back. A note
  you have just created opens ready to write in.
- **Document links and backlinks.** Link one note to another with `/document`.
  Each note shows what links back to it.
- **Full-text search.** Searches the text of your notes and journals, not just
  their titles.
- **Task lists.** Every task in every note and journal is on the Todos page,
  under the note or day it belongs to. Its search finds a task by the words in
  it, and a click opens the note right at that task.
- **Peer-to-peer sync.** Pair two devices on one network and they reconcile
  their whole document set, including images, with no internet and no server
  anywhere in the middle. A device somewhere else is reached at an address you
  give it, over a VPN you already run. A computer keeps syncing from the tray
  when its window is closed, and a phone catches up in the background with a
  device that is awake.
- **Export.** Settings > Data writes every note out as a Markdown file, with
  the images they embed, in one zip. Nothing here is a format you can only
  read from inside Oyot.
- **Import.** The Notes page, or Settings > Data, makes a note of each
  Markdown file you pick. The title comes from the front matter, a heading at
  the top or the file's name, `#tags` become tags, and links between files
  imported together become links between their notes. An export imported back
  gives back the notes it held, its journals as notes.
- **Help built in.** The ? at the bottom of the sidebar, Cmd/Ctrl+/ from
  anywhere, or Settings > Help, says what the calendar's dots and the other
  colors mean, lists every keyboard shortcut as your keyboard labels it, and
  covers the rest worth knowing.
- **Your own keyboard shortcuts.** Settings > Keyboard shortcuts gives the
  text styles, headings, lists, undo, Help and Edit other keys, on each
  device. It asks before taking keys another shortcut has, and Reset puts any
  of them back.
- **Backup and restore.** Settings > Backup saves the whole library, images
  included, to one file wherever you choose, or to your Google Drive once you
  link an account (desktop), and imports one back. An import merges into what
  is already there and never removes a note, so it is safe to run on a device
  you are still using. On a computer, backups can also run on their own, daily
  or weekly, to Google Drive or a folder you choose, while Oyot is running.

## Sync

Devices sync directly with each other, over one encrypted connection per
pair. They find each other in one of two ways, and neither needs an account, a
server, or anything run by us.

On one network, they find each other by themselves over mDNS. Elsewhere, you
tell one device where the other is, and it checks.

- Each device's ID is an Ed25519 public key, and that key is what the
  connection is made with (TLS 1.3), so nothing on the network can pose as a
  device you paired with, or read what passes between them.
- Pairing is explicit. You read one device's ID on another (by hand or by QR
  code) and confirm the prompt. Devices do announce themselves on the network,
  but an announcement is only an address: nothing syncs until you have
  confirmed the ID.
- Documents reconcile as a whole set on every connection, so devices converge
  after being apart without a central copy to fall back on.
- Note content never leaves your devices, and is encrypted in transit.

### Devices that are not on one network

Pairing asks where the other device is. Answer "somewhere else" and it takes an
address alongside the ID: a host name or an IP that does not change. The
reliable way to have one is a VPN you already run between your own machines,
such as Tailscale, where every device has a stable name and address. Pair with
the other device's address on this one, and they reach each other from
anywhere: the device with the address makes the connection, and it carries
sync both ways. Adding this device's address on the other one too, on its row
under Paired Devices, lets either side start.

Oyot does not install, configure or manage the VPN, and does not know whether
you have one. It only uses the address. Nothing else changes: the same
handshake, the same encrypted connection, the same documents.

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

### In the background

Closing Oyot's window on a computer leaves it running in the tray (the menu bar
on a Mac), still syncing, and it can start there when you log in. A phone
cannot be reached while it is in your pocket, so instead it reaches out every
so often, when Android or iOS lets it, to a device that is awake, such as that
computer. Settings > Sync on a phone turns this off, allows it on mobile data,
and says when it last ran. Opening Oyot always syncs straight away.

The design decisions behind all of this, including what each one gives up, are
in [docs/decisions](./docs/decisions).

## Platforms

Desktop (macOS, Windows, Linux) and mobile (Android, iOS). Android release
builds are produced by CI; other platforms are built locally for now.

## Tech Stack

- **Frontend**: SvelteKit 2, Svelte 5, TypeScript, Tiptap
- **Backend**: Rust, Tauri 2
- **Storage**: SQLite (rusqlite), Yjs CRDTs for document content
- **Sync**: in Rust, over TLS 1.3 between devices, with mDNS on the local
  network, merging documents with `yrs`, the Rust port of Yjs

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, build, and release
instructions.

## License

MIT. See [LICENSE](./LICENSE).
