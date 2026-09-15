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

**The asset protocol is scoped to the attachment directory**
(`$APPDATA/attachments/**` in `tauri.conf.json`), so a resolved `asset:` URL
cannot reach anything else.

**The CSP allows only self and the IPC origin.** No remote script, style, or
connection. The MQTT connection is made from Rust and is not subject to it.

**Signaling is authenticated end to end.** A device's `node_id` is its Ed25519
public key, and every signaling message carries a timestamp, a nonce and a
signature over all of its fields. `src-tauri/src/crypto.rs` holds the format and
the verifier; messages are checked in the MQTT event loop before anything reads
the payload. The broker is therefore untrusted infrastructure: it relays
messages it cannot forge, alter or replay. See
[ADR 0009](docs/decisions/0009-authenticated-signaling.md).

The signature answers "is this really that device". Whether we want to talk to
that device is still the pairing check against `device_pairs`, and both must
pass.

Replay history is per sender, bounded at 32 senders and 256 nonces each. It
was one shared list, which meant anyone holding any keypair could push enough
valid messages to evict a real peer's history and replay one of its messages
inside the 120 second window. Filling the sender map still takes 32 distinct
keypairs, and the prize is one replayed signaling message, which the pairing
check and perfect negotiation both absorb.

**The local network is untrusted in the same way, and shares one verifier.**
Discovery and the local signaling channel carry the same signed envelope, so
nothing about the trust story changes with the transport. The verifier and its
replay history are shared between the two routes rather than one per
transport: separate histories would let a message captured off the broker be
replayed into the local listener inside the 120 second window, with the nonce
that should have caught it recorded in the other copy.

What the local network exposes is not quite what the broker sees. The mDNS TXT
record carries this device's `node_id`, an id for this run of the process and
a version, and deliberately not the device name, so joining a café network
does not announce "Aji's laptop" to everyone on it. The envelope is signed but
not encrypted, so anyone on the network can read the SDP inside, which is the
same exposure the broker already has. Note content travels inside WebRTC's
DTLS either way.

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
Anyone who learns a `node_id` can publish to its topic, and a valid request
puts a modal in front of the user, so without this an unpaired device could
make the app unusable by asking repeatedly.

**Pairing is decided in the webview, not in Rust.** `save_pair` persists any
`peer_node_id` the frontend gives it, and `mqtt_accept_pair_request` takes the
peer's `user_id` from the frontend too. Rust checks that a message really came
from the key it claims; it does not own the state machine that decides a
pairing was agreed. That is a real gap between this section's framing and the
code: everything above treats the webview as untrusted, and this one decision
trusts it. Closing it means moving the pair-request exchange into Rust, which
has not been done.

### Running a broker

`docker compose up -d` starts `mosquitto/config/mosquitto.conf`, which is the
development configuration: anonymous, listening on every interface. Both are
deliberate. The point of running it is to pair two of your own devices, so
localhost binding will not do, and requiring a password file before the app
can connect at all is friction for no security gain: the signatures are what
make a message trustworthy, and pairing still means confirming the other
device's id by hand.

What the broker can still do is read. It sees who is pairing with whom and the
SDP inside, so do not expose the development configuration beyond a network
you trust.

For anything more than that, start from `mosquitto.prod.conf.example` and
`acl.example`. Together they add authentication, a per-device rule so no
account can subscribe outside its own topic subtree, and a place to put TLS
certificates. Enter the username and password in Settings > Sync on each
device, and point it at `mqtts://host:8883`. Credentials are stored in the
same plaintext `config.json` as the rest of the configuration, alongside the
signing key.

You do not need a broker at all to develop against two devices on one
network. See [Local network sync](#local-network-sync).

The secret key lives in the app database rather than the OS keychain. Anything
that can read it can already read the notes, so this is coherent rather than
ideal; moving it is tracked as follow-up work in the ADR.

## Local network sync

Two devices on the same network reach each other directly, with no internet
and no broker. This is a second signaling transport rather than a second sync
mechanism: discovery answers "where is that device", and everything after that
is the same WebRTC data channel and the same document protocol. Note data
already travelled directly between devices on one network; what needed the
internet was the introduction. See
[ADR 0018](docs/decisions/0018-local-network-sync-as-a-second-signaling-transport.md).

`src-tauri/src/network/lan_discovery.rs` advertises `_oyot._tcp.local` and
browses for the same. `lan_signaling.rs` listens on an ephemeral port and
carries the same signed envelope, one message per connection.
`route.rs` holds the choice between the two transports, which is made per peer
and never races them.

### Trying it

You need two devices. Two instances on one machine will not do: they share an
app data directory, so they share an identity, and a device ignores its own
advertisement.

1. Stop the broker, so nothing can fall back to it: `docker compose down`.
2. On both devices, open Settings > Sync and choose **Local network only**.
   The setting is stored as `sync_mode` in `config.json`.
3. Pair as usual, by ID or by QR code. Discovery supplies the address; the
   confirmation is unchanged, and still the thing that decides a pairing.

`Local network: On, N devices nearby` in that section is the quickest check
that discovery works on the network you are actually on. The count includes
devices you have not paired with, because "is anything being found at all" is
the question when it does not work.

In a dev build the Rust side traces to stderr, so `[LAN]` lines appear in the
terminal running `make dev`, and the frontend's `[sync]` lines in the webview
console. Between them they say which route each message took and why a route
was written off.

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
passes mDNS and blocks device-to-device traffic. Discovery finds the peer, the
connection never forms, and after eight seconds that peer's local route is
written off for a minute and the broker takes over. Under Automatic that is a
delay; under Local network only it is a peer that does not sync. If that turns
out to be the common case rather than the rare one, lengthen the cooldown
rather than shortening the eight seconds.

Platform support is not even, and this ships in stages:

| Platform              | Discovery                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, Linux, Windows | `mdns-sd`. This is the path to develop against.                                                                                                                                                           |
| Android               | `mdns-sd` is in the build, but nothing holds the `MulticastLock` Android needs to receive multicast. Assume it does not work yet.                                                                         |
| iOS                   | Not built. `mdns-sd` binds a raw multicast socket, which iOS gates behind an entitlement Apple reviews by hand, so iOS needs an `NWBrowser` plugin instead and falls back to the broker until it has one. |

A device on a build without any of this is simply not discovered, has no
listener, and syncs through the broker exactly as it did before. Mixed pairs
are the normal case for a while.

## Project Structure

```
oyot/
├── src/                     # SvelteKit frontend
│   ├── lib/
│   │   ├── components/      # Sidebar, toasts, sync status
│   │   ├── editor/          # Tiptap editor, save service, Yjs helpers
│   │   ├── settings/        # Pairing and sync settings UI
│   │   ├── services/        # Document actions, theme, toasts
│   │   ├── stores/          # Svelte stores (app state, sync state)
│   │   ├── sync/            # Peer sync: transport, protocol, framing
│   │   ├── tiptap/          # Editor extensions, slash commands, nodes
│   │   ├── changelog.ts     # Release notes shown in the About dialog
│   │   ├── version.ts       # Running version, injected at build time
│   │   └── types.ts         # Shared type definitions
│   └── routes/              # SvelteKit routes (SPA, ssr disabled)
├── src-tauri/               # Rust backend
│   ├── src/
│   │   ├── commands/        # Tauri commands, the only frontend surface
│   │   ├── network/         # Signaling: MQTT, local network, route choice
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
the database, the attachment store, identity, and both signaling transports:
the MQTT client and the local network path, plus the decision about which of
them carries a given message. It does not participate in the peer connection
itself.

## Tech Stack

- **Frontend**: SvelteKit 2, Svelte 5, TypeScript, Tiptap (rich text editing)
- **Backend**: Rust, Tauri 2.0
- **Database**: SQLite (rusqlite)
- **Rust Crates**: rusqlite, rumqttc, ed25519-dalek, serde, chrono, sha2

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
