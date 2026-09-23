# Development

## Prerequisites

- Node.js 20+
- Rust 1.75+ (install via [rustup](https://rustup.rs))
- Platform build dependencies for Tauri (see below)

## Setup

Install Node.js and Rust, then the platform dependencies for your OS.

### macOS

```bash
xcode-select --install
```

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libgtk-3-dev libglib2.0-dev \
  libcairo2-dev libgdk-pixbuf2.0-dev libpango1.0-dev libatk1.0-dev \
  librsvg2-dev libdbus-1-dev libayatana-appindicator3-dev \
  libssl-dev pkg-config
```

For other distros, see the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

### Windows

Install the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (preinstalled on recent Windows 10/11).

### Rust components and npm dependencies

```bash
rustup component add rustfmt clippy
npm install
```

## Development

Run the development server:

```bash
make dev
```

Or manually:

```bash
npm run tauri dev
```

## Build

```bash
make build
```

Or manually:

```bash
npm run tauri build
```

## Available Commands

Run `make help` for a list of all available commands:

- `make install` - Install npm dependencies
- `make dev` - Run development server
- `make build` - Build the application
- `make run` - Build and run the application
- `make clean` - Clean build artifacts
- `make check` - Run TypeScript and Rust checks
- `make fmt` - Format code
- `make lint` - Run the eslint and clippy linters
- `make test` - Run the frontend and Rust test suites
- `make verify` - Everything CI runs: format, lint, typecheck, test, build
- `make clippy` - Run Rust linter

## Quality checks

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request, in two jobs:

| Job      | Checks                                                               |
| -------- | -------------------------------------------------------------------- |
| Frontend | `prettier --check`, `eslint`, `svelte-check`, `vitest`, `vite build` |
| Rust     | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`        |

`make verify` runs the same set locally and is the fastest way to know a
push will pass. Run it before opening a pull request.

Both linters are enforced at zero errors. `@typescript-eslint/no-explicit-any`
is the one rule left at warning level: the sync layer deliberately parses
`unknown` off the wire, and the Tiptap node-view signatures mirror the
library's own typing.

Formatting is not negotiable in CI, so run `make fmt` before committing.
Prettier config lives in `.prettierrc`, eslint in `eslint.config.js`, and
rustfmt uses the default profile.

## Security model

The webview is treated as the untrusted surface, because it renders document
content and image attachments that arrive from paired devices.

**The frontend has no filesystem permission, and cannot pick a file.**
`src-tauri/capabilities/` grants only `core`, `opener`, `os` (and
`barcode-scanner` on mobile). `pick_and_import_image` opens the dialog, reads
the bytes and stores them entirely in Rust, so no path crosses IPC and there
is nothing for a caller to supply. Plugin ACLs constrain the webview, not
Rust. Avoid reaching for `@tauri-apps/plugin-fs` in the frontend; add a
command instead.

**Attachments are raster only, decided by their content.** Every entry point
goes through `store_attachment`, which identifies the type from the bytes
themselves, rejects anything that is not PNG, JPEG, GIF or WebP, and enforces
the 10MB cap. A declared type that disagrees with the content is an error. SVG
is excluded on purpose: it can carry script, and an attachment from a peer is
rendered in the webview.

**Writing out is the same shape as reading in.** Exporting notes
(`export_notes`) takes rendered Markdown from the webview and does every
filesystem operation in Rust, against a path the user picked in a native save
dialog. The entry names inside the archive come from the webview, so they are
validated rather than repaired: anything that is not recognisably one `.md`
filename is refused, because a zip entry name is a path on whatever machine
extracts it. See [ADR 0021](docs/decisions/0021-export-notes-as-a-markdown-archive.md).

**Backups are written and read in Rust, and a backup being imported is
hostile until checked.** `create_local_backup` and `open_local_backup` open
their dialogs in Rust, like the export. On Android and iOS the dialog returns a
content URI or a security-scoped URL rather than a path, which is why
`tauri-plugin-fs` is registered: for its Rust API only, with no capability
granting its commands, so the webview gains nothing by it. A picked backup is
copied into the app's cache and checked in full before anything is imported:
its format and version, size limits on every entry and on the total (the
zip-bomb defence), and a SHA-256 for every entry. Entries are read by name into
memory and never extracted. The webview then pulls one checked document at a
time and merges it through the sync path, and Rust stores the images itself
through `store_attachment`. A backup never contains the signing key, the
pairings or the stored addresses. See
[ADR 0024](docs/decisions/0024-back-up-the-crdt-and-import-by-merging.md).

**A linked Google account's tokens never reach the webview.** Linking opens
Google's sign-in in the system browser, never in the app, and the answer comes
back to a one-shot listener on `127.0.0.1` at a random port. The code in it is
bound to the attempt by PKCE and a random `state`, so something else on the
machine that answers the listener gets nothing it can use. The exchange happens
in Rust; the refresh token goes into the OS keychain and the access token stays
in memory. The webview sees the account's email and the list of backups. The
only scope asked for is `drive.file`, so Oyot can see the files it created and
nothing else in the user's Drive. A Drive file id arrives from the webview, so
it is held to the characters ids are made of before it goes into a URL, and a
downloaded backup is checked exactly as a file from disk is. See
[ADR 0025](docs/decisions/0025-remote-backups-behind-one-trait-google-drive-first.md).

**The asset protocol is scoped to the attachment directory**
(`$APPDATA/attachments/**` in `tauri.conf.json`), so a resolved `asset:` URL
cannot reach anything else.

**The CSP allows only self and the IPC origin.** No remote script, style, or
connection. Signaling is done from Rust and is not subject to it.

**Signaling is authenticated end to end.** A device's `node_id` is its Ed25519
public key, and every signaling message carries a timestamp, a nonce and a
signature over all of its fields. `src-tauri/src/crypto.rs` holds the format and
the verifier; every message is checked on arrival before anything reads the
payload. The transport is therefore untrusted infrastructure: it carries
messages it cannot forge, alter or replay. That is what let the broker be
deleted without renegotiating anything about the envelope. See
[ADR 0009](docs/decisions/0009-authenticated-signaling.md) and
[ADR 0022](docs/decisions/0022-drop-the-broker-and-sync-only-on-the-local-network.md).

The signature answers "is this really that device". Whether we want to talk to
that device is still the pairing check against `device_pairs`, and both must
pass.

Replay history is per sender, bounded at 32 senders and 256 nonces each. It
was one shared list, which meant anyone holding any keypair could push enough
valid messages to evict a real peer's history and replay one of its messages
inside the 120 second window. Filling the sender map still takes 32 distinct
keypairs, and the prize is one replayed signaling message, which the pairing
check and perfect negotiation both absorb.

**Every route is untrusted, including the VPN.** The verifier and its replay
history live on the `SignalingManager` rather than on any one route, so a
message captured off the local network cannot be replayed in over a stored
address inside the 120 second window. An envelope arriving over Tailscale is
admitted on exactly the evidence one arriving over wifi is: right recipient,
valid signature, recent, unseen nonce. Being on the tailnet is not a
credential, and the app never treats it as one.

What the local network exposes: the mDNS TXT record carries this device's
`node_id`, an id for this run of the process and a version, and deliberately
not the device name, so joining a café network does not announce "Aji's
laptop" to everyone on it. The envelope is signed but not encrypted, so anyone
on the network can read the SDP inside. Note content travels inside WebRTC's
DTLS and never appears there.

The `node_id` is stable and is now broadcast on every network the device
joins, which is a tracking vector that did not exist before: someone present
on two different networks can tell it was the same device both times.
Advertising a hash of the id and the hour instead would stay recognisable to
paired peers, who can compute it for each peer they know, and mean nothing to
anyone else. Not done, and worth doing before this is on by default on mobile.

The listener accepts a connection from anyone on the network, so it caps the
frame size before allocating, times out a connection that does not deliver,
and rate limits arrivals per source address. What it does not do is answer
differently for a paired device than for a stranger, so it does not leak who
this device is paired with.

A pairing prompt from one sender is rate limited to one per 30 seconds.
Anyone on the network can reach the listener, and a valid request puts a modal
in front of the user, so without this an unpaired device could make the app
unusable by asking repeatedly.

A `ping` is answered for any correctly signed and correctly addressed sender,
paired or not, because an address is how an unpaired device is reached in the
first place (ADR 0023). The reply discloses that this node is at this address,
to someone who already knew its `node_id` and could already reach the port.
Rewriting an obfuscated ICE candidate also discloses one of this device's own
addresses to the peer it is negotiating with, which is strictly less than the
mDNS advertisement gives away to everyone on a café network.

**Pairing is decided in the webview, not in Rust.** `save_pair` persists any
`peer_node_id` the frontend gives it, and `signaling_accept_pair_request` takes
the peer's `user_id` from the frontend too. Rust checks that a message really came
from the key it claims; it does not own the state machine that decides a
pairing was agreed. That is a real gap between this section's framing and the
code: everything above treats the webview as untrusted, and this one decision
trusts it. Closing it means moving the pair-request exchange into Rust, which
has not been done.

The secret key lives in the app database rather than the OS keychain. Anything
that can read it can already read the notes, so this is coherent rather than
ideal; moving it is tracked as follow-up work in the ADR.

## How a device is found

There are two ways, and only two. Everything after being found is the same
WebRTC data channel and the same document protocol either way, which is what
[ADR 0018](docs/decisions/0018-local-network-sync-as-a-second-signaling-transport.md)
was careful to arrange when the local network was one transport of two.

`network/peers.rs` is where both answers land: one table, each entry tagged
with the source that found it, and `best()` preferring the local one when a
device is reachable both ways. `lan_discovery.rs` fills it from mDNS.
`remote_peers.rs` fills it by probing stored addresses.
`lan_signaling.rs` listens on 19701 where it can, and carries the signed
envelope from `message.rs`, one message per connection - except a `ping`,
which is answered on the same connection because there is nowhere else to send
the answer.

A device that neither finds nor has an address is not reachable at all. There
is no queue and no deferred delivery: the peer reads as offline, and pairing
with it refuses with a sentence saying why.

### Trying it

You need two devices. Two instances on one machine will not do: they share an
app data directory, so they share an identity, and a device ignores its own
advertisement.

1. Put both on the same wifi and open Oyot on each. There is nothing to
   configure; discovery starts with the app.
2. Pair as usual, by ID or by QR code. Discovery supplies the address; the
   confirmation is unchanged, and still the thing that decides a pairing.

`Local network: Searching, N devices nearby` in Settings > Sync is the
quickest check that discovery works on the network you are actually on. The
count includes devices you have not paired with, because "is anything being
found at all" is the question when it does not work.

In a dev build the Rust side traces to stderr, so `[LAN]`, `[peers]` and
`[remote]` lines appear in the terminal running `make dev`, and the frontend's
`[sync]` lines in the webview console.

### The firewall prompt

The listener binds a port, so macOS and Windows ask whether to allow incoming
connections the first time a build runs. Answering no leaves a state that is
hard to read: this device goes on advertising, so the status line can still
say `On`, while nothing on the network can open a connection to it. Depending
on the platform the same block can also stop this device hearing other
devices' advertisements. If local sync stops working after a rebuild, check
there first, since a new binary can be treated as a new application.

### When it does not work

Access point client isolation, which is common on guest and café networks,
passes mDNS and blocks device-to-device traffic. The symptom is specific and
worth recognising: the peer appears in the nearby count, so discovery is
plainly working, and the connection never forms. The 30 second negotiation
watchdog rebuilds the session, which fails the same way. There is nothing to
fall back to, so the honest advice is a different network.

Platform support is not even, and this ships in stages:

| Platform              | Discovery                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, Linux, Windows | `mdns-sd`. This is the path to develop against.                                                                                                                                                                                                                                                                           |
| Android               | `mdns-sd`, with the `MulticastLock` taken in `MainActivity` while the app is on screen. Backgrounded it still advertises and still accepts connections, but hears nothing, and discovery finds the network again on its own when it comes back. Not yet run on a real device.                                             |
| iOS                   | Not built. `mdns-sd` binds a raw multicast socket, which iOS gates behind an entitlement Apple reviews by hand, so iOS needs an `NWBrowser` plugin instead. Since ADR 0023 that is no longer the whole story: an iOS device syncs with any device it has been given an address for, and finds nothing on its own network. |

### Still to do: the iOS backend

Still the largest known gap, though ADR 0023 has reduced it: an iOS device
finds nobody on its own network, and syncs with whatever it has a stored
address for. This is what makes it work without one.

Everything above the `backend` module in `lan_discovery.rs` is platform
independent and already shared: the peer table, the TXT parsing, the pruning
and the event emission. An iOS backend is a `spawn` that returns a `Handle`,
and it needs to:

- Browse and advertise through `NWBrowser` and `NWListener` in a small Tauri
  plugin. These are permitted where a raw multicast socket is not, which is
  the whole reason for the split.
- Declare `NSLocalNetworkUsageDescription` and `NSBonjourServices` (listing
  `_oyot._tcp`) in `Info.plist`. The first is the wording of the permission
  prompt the user sees. Without the second, iOS will not resolve the service
  at all.
- Feed what it finds into the same `Peers` table, as source `Mdns`, and start
  the existing `lan_signaling` listener, which is plain TCP and needs nothing
  special from the platform.

What it must not need is `com.apple.developer.networking.multicast`. That is
the entitlement `mdns-sd` would require, granted only by a request Apple
reviews by hand, and avoiding it is why iOS gets its own backend rather than
the one every other platform uses.

## Reaching a device that is not on this network

[ADR 0023](docs/decisions/0023-reach-a-peer-at-an-address-you-already-know.md).
The user stores a host and a port for a device; a prober turns that into a peer
by getting a signed answer out of it. Tailscale is the recommended way to have
an address that does not move, and nothing in the code knows about it: no
library, no CLI, no LocalAPI, no check that it is installed.

Three pieces make it work.

**A port a peer can assume.** mDNS tells a peer which port to connect back to;
a typed address carries no such channel. `lan_signaling::SIGNALING_PORT` is
19701, below every platform's ephemeral range so no unrelated outbound socket
can have been handed it. A second copy of the app falls back to an ephemeral
port, keeps working locally, and says in Settings > Sync that it is not
reachable at a stored address.

**A probe, not an assumption.** `remote_peers.rs` sends a signed `ping` to each
stored address every 45 seconds and expects a signed `pong` on the same
connection. The answer is verified like any other message and then checked for
coming from the node we addressed; otherwise anything occupying an address
could answer for any device the user has an address for. A peer already found
on this network is skipped, because there is nothing an address could add.

**Rewritten ICE candidates.** This is the part that would otherwise silently
not work. Chromium-family WebViews replace the address in a host candidate with
an `<uuid>.local` mDNS name; on one network the peer resolves it, and over a
VPN it resolves to nothing, so the connection never forms with no error saying
why. `local_address_toward` answers "which of our addresses would that peer
reach us at" with a connected UDP socket, which sends no packet and reports the
source address the kernel would use. `sync/iceRewrite.ts` publishes a copy of
each obfuscated candidate naming it, alongside the original, and only for a
peer that is not on this network.

If candidate rewriting ever turns out not to work on some platform, the
documented fallback is carrying the data channel over the Rust TCP connection
for that route and dropping WebRTC there, which ADR 0023 records as the
alternative it was weighed against.

### Trying it over a tailnet

Two machines, both on a tailnet, and not on the same wifi - or the same wifi
with the local route confirmed off, since `best()` prefers it whenever it is
available and you would be testing the wrong thing.

1. On one device, Settings > Sync, "Pair a Device": choose **Somewhere else**,
   paste the other device's Node ID and its MagicDNS name
   (`laptop.tailnet-name.ts.net`), and press Pair. The port is optional. The
   address is stored and probed before the request goes out, so a wrong one is
   reported as a wrong address rather than as a device that did not answer.
2. Accept the prompt on the other device.
3. On that device, find the first one under "Paired Devices" and use "Add an
   address" on its row. **Both directions need one**: either device may be the
   one that starts a reconnect, and the one without an address cannot.

An address reading "has never answered" means the address itself, the other
device being asleep, or a tailnet ACL that does not allow port 19701 between
your own devices. "Check now", beside the stored-address line under Sync
Connection, re-probes without waiting out the 45 second interval.

The form asks which way first and then shows only that way's fields, so a
blank address is never ambiguous between "it is on this network" and "I have
not filled that in yet". `sync/pairMethod.ts` holds what follows from the
choice: what the Pair button needs, that an address typed and then abandoned is
not used, and the one warning worth raising before anything is sent.

A node id is typed exactly once, when pairing. Afterwards a device's addresses
live on its own row under "Paired Devices" (`PeerAddresses.svelte`), where the
row already says which device this is. The only addresses not shown there are
ones belonging to a pairing that never completed, since an address is stored
before the request goes out; `UnpairedAddressList.svelte` is where those can be
removed, and it renders nothing at all when there are none.

## Google Drive backups

A build offers Google Drive only when it was compiled with a Google OAuth
client. Without one, the Backup page offers files alone, which is what a
development build does by default. Desktop only for now: the phones need a
different sign-in ([ADR 0025](docs/decisions/0025-remote-backups-behind-one-trait-google-drive-first.md),
decision 7).

### Setting up the Google side

Once, by whoever publishes Oyot, in the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project.
2. In APIs and services, enable the **Google Drive API**.
3. In the Google Auth Platform, set up the consent screen: user type
   **External**, the app's name, and a support email. Under data access, add
   one scope, `https://www.googleapis.com/auth/drive.file`, and nothing else.
4. Under audience, while the app is in **Testing**, add every Google account
   that should be able to link as a test user. Google allows 100 of them, and
   expires a test user's link after seven days; linking again restores it.
   Publishing the app lifts both limits. It needs a home page and a privacy
   policy URL, and because `drive.file` is a non-sensitive scope, no security
   assessment.
5. Under clients, create a client of type **Desktop app**, and keep its client
   id and client secret.

### Building with it

The two values are read when the Rust side is compiled, so set them before
building, and changing them rebuilds it:

```bash
export OYOT_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
export OYOT_GOOGLE_CLIENT_SECRET=your-client-secret
npm run tauri dev
```

Keep them out of git. Google does not treat a Desktop client's secret as
confidential, since it ships inside the app, but there is no reason to publish
it either. With direnv, `dotenv_if_exists` in `.envrc` and the two lines in a
`.env` file, which is git-ignored, does it.

A linked account lives in the OS keychain, under the service
`com.ajiyakin.oyot` and the account `google-drive`. macOS may ask to allow
access to it after a rebuild, because a development build is signed afresh
each time. Deleting that entry is the same as unlinking without telling Google.

## Project Structure

```
oyot/
├── src/                     # SvelteKit frontend
│   ├── lib/
│   │   ├── components/      # Sidebar, toasts, sync status
│   │   ├── editor/          # Tiptap editor, save service, Yjs helpers
│   │   ├── settings/        # Pairing, addresses and sync settings UI
│   │   ├── services/        # Document actions, theme, toasts
│   │   ├── stores/          # Svelte stores (app state, sync state)
│   │   ├── sync/            # Peer sync: transport, protocol, framing, ICE
│   │   ├── tiptap/          # Editor extensions, slash commands, nodes
│   │   ├── changelog.ts     # Release notes shown in the About dialog
│   │   ├── version.ts       # Running version, injected at build time
│   │   └── types.ts         # Shared type definitions
│   └── routes/              # SvelteKit routes (SPA, ssr disabled)
├── src-tauri/               # Rust backend
│   ├── src/
│   │   ├── commands/        # Tauri commands, the only frontend surface
│   │   ├── network/         # Signaling: peer table, discovery, probe, listener
│   │   ├── db.rs            # Connection setup and AppState
│   │   └── lib.rs           # Schema, migrations, command registration
│   ├── capabilities/        # Plugin ACLs for the webview
│   ├── gen/android/         # Generated Android project (committed)
│   ├── gen/apple/           # Generated iOS/Xcode project (committed)
│   ├── Cargo.toml           # Rust dependencies and release profile
│   └── tauri.conf.json      # Tauri configuration, CSP, asset scope
├── docs/decisions/          # Architecture decision records
├── package.json             # Node dependencies
└── Makefile                 # Build commands
```

WebRTC lives entirely in the frontend (`src/lib/sync/transport.ts`). Rust owns
the database, the attachment store, identity, and signaling: finding peers,
whether by announcement or by probe, and delivering signed envelopes to them.
It does not participate in the peer connection itself, with one exception it is
worth knowing about: it answers which of this device's addresses a given peer
would reach it at, because only the operating system knows, and the frontend
needs it to make a host ICE candidate usable off this network (ADR 0023).

## Tech Stack

- **Frontend**: SvelteKit 2, Svelte 5, TypeScript, Tiptap (rich text editing)
- **Backend**: Rust, Tauri 2.0
- **Database**: SQLite (rusqlite)
- **Rust Crates**: rusqlite, mdns-sd, ed25519-dalek, serde, chrono, sha2

---

## Releasing

The app builds for **macOS, Windows, Linux, Android, and iOS**.

- `make release` builds for **the current platform only** and puts artifacts
  in `dist/`. The per-platform targets below do the same for Android and iOS.
- `make release-tag VERSION=x.y.z` pushes a git tag, which triggers GitHub
  Actions and publishes a draft GitHub Release.

**CI currently builds Android only.** The desktop and iOS jobs are commented
out in `.github/workflows/release.yml`. Everything else is built locally with
the targets below and attached to the draft by hand. Uncommenting those jobs
is what it would take to change that; until then a tag produces one artifact,
not five.

### Bumping the version

```bash
make bump VERSION=0.1.0
```

That writes the four mechanical places: `package.json`,
`src-tauri/tauri.conf.json` (both the version and `bundle.android.versionCode`),
`src-tauri/Cargo.toml`, and `Cargo.lock`.

The versionCode is derived as `1000 + major*10000 + minor*100 + patch`, which
keeps it increasing as long as minor and patch stay below 100. Play refuses an
upload whose versionCode repeats or lowers a published one, and it tells you
after the build has run, so the script computes it rather than leaving it to be
remembered.

One thing is left to you: **add an entry at the top of `RELEASES` in
`src/lib/changelog.ts`**. An entry is a sentence about what changed and nothing
can write it for you. `src/lib/version.test.ts` fails until it exists, which is
how you are reminded; it also checks every other place the version is written,
so a hand edit that misses one does not get past `npm test`.

The sidebar footer shows the version, and clicking it opens the About dialog
with the changelog, so a release with no entry ships a dialog that says nothing
about it.

`make release-tag` refuses to tag if `package.json` disagrees with the version
you gave it, if the working tree is dirty, or if the tests fail.

### Quick release (all platforms via CI)

```bash
make bump VERSION=1.0.0
# edit src/lib/changelog.ts, then commit
make release-tag VERSION=1.0.0
# → pushes tag v1.0.0
# → GitHub Actions builds the Android artifacts
# → draft release appears at github.com/<you>/oyot/releases
```

Then go to GitHub Releases, review the draft, and publish it.

---

### One-time local environment setup

This only needs to be done once per developer machine.

#### macOS / iOS (Xcode)

Install Xcode from the App Store, then accept the license:

```bash
sudo xcodebuild -license accept
```

#### Android SDK

Set these environment variables (add to `~/.zshrc`):

```bash
export ANDROID_HOME=$HOME/Android
export ANDROID_SDK_ROOT=$HOME/Android
export NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
export PATH="$ANDROID_HOME/cmdline-tools/bin:$ANDROID_HOME/platform-tools:$PATH"
```

Install the NDK (if not already installed):

```bash
sdkmanager "ndk;27.0.12077973"
```

Add Android Rust cross-compilation targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

Add iOS Rust cross-compilation targets:

```bash
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
```

---

### GitHub Secrets setup (required for CI releases)

Go to **GitHub → Settings → Secrets and variables → Actions** and add the following secrets:

#### Android signing

You need a signing keystore. Create one with:

```bash
keytool -genkey -v -keystore oyot.jks -alias oyot -keyalg RSA -keysize 2048 -validity 10000
```

Keep `oyot.jks` somewhere safe (do **not** commit it), and keep its password
out of the repository too. The signing targets read it from the environment:

```bash
export ANDROID_KEYSTORE=/path/to/oyot.jks   # defaults to ./oyot.jks
export ANDROID_KEYSTORE_PASSWORD=...
```

`make release-android`, `make release-android-aab` and `make install-android`
refuse to run without them rather than failing inside `apksigner`.

An earlier version of the Makefile had the password written into it in plain
text, so it is in this repository's history. The keystore file itself was
never committed, so the key is not compromised, but that password should be
treated as public and rotated:

```bash
keytool -storepasswd -keystore oyot.jks
keytool -keypasswd -alias oyot -keystore oyot.jks
```

Then update `KEY_STORE_PASSWORD` and `KEY_PASSWORD` in the GitHub secrets
below.

| Secret                | How to get the value                            |
| --------------------- | ----------------------------------------------- |
| `ANDROID_SIGNING_KEY` | `base64 -i oyot.jks \| pbcopy`                  |
| `KEY_STORE_PASSWORD`  | Password you set when creating the keystore     |
| `KEY_ALIAS`           | Alias you set (e.g. `oyot`)                     |
| `KEY_PASSWORD`        | Key password (often the same as store password) |

#### iOS signing

1. In **Xcode → Settings → Accounts**, add your Apple ID and download your distribution certificate.
2. Open **Keychain Access**, find your "Apple Distribution" certificate, right-click → **Export** → save as `certificate.p12` with a password.
3. Download your `.mobileprovision` from [developer.apple.com/account/resources/profiles](https://developer.apple.com/account/resources/profiles).
4. Find your 10-character **Team ID** at [developer.apple.com/account](https://developer.apple.com/account) (top right).

| Secret                       | How to get the value                          |
| ---------------------------- | --------------------------------------------- |
| `APPLE_CERTIFICATE`          | `base64 -i certificate.p12 \| pbcopy`         |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12`       |
| `APPLE_PROVISIONING_PROFILE` | `base64 -i profile.mobileprovision \| pbcopy` |
| `KEYCHAIN_PASSWORD`          | Any strong random string (used only in CI)    |
| `APPLE_DEVELOPMENT_TEAM`     | Your 10-character Team ID (e.g. `AB12CD34EF`) |

---

### Local release (current platform only)

```bash
make release              # builds for current OS → dist/mac/, dist/linux/, or dist/windows/
make release-android      # builds APK → dist/android/       (requires Android SDK + NDK)
make release-android-aab  # builds AAB (Play Store) → dist/android/  (requires Android SDK + NDK)
make release-ios          # builds IPA → dist/ios/           (requires Xcode + Apple certificate)
```

Output is placed in `dist/` (gitignored - release binaries are not committed).

---

### Artifact locations after build

| Platform | Local path                       | CI artifact                   |
| -------- | -------------------------------- | ----------------------------- |
| macOS    | `dist/mac/*.dmg`                 | not built (job commented out) |
| Windows  | `dist/windows/*.msi`, `*.exe`    | not built (job commented out) |
| Linux    | `dist/linux/*.deb`, `*.AppImage` | not built (job commented out) |
| Android  | `dist/android/*.apk`             | GitHub Release                |
| iOS      | `dist/ios/*.ipa`                 | not built (job commented out) |
