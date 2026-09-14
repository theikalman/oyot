# Development

## Prerequisites

- Node.js 18+
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
- `make verify` - Everything CI runs: format, lint, typecheck, test
- `make clippy` - Run Rust linter

## Quality checks

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request, in two jobs:

| Job      | Checks                                                        |
| -------- | ------------------------------------------------------------- |
| Frontend | `prettier --check`, `eslint`, `svelte-check`, `vitest`        |
| Rust     | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` |

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

**The frontend has no filesystem permission.** `src-tauri/capabilities/`
grants only `core`, `dialog`, `opener`, `os` (and `barcode-scanner` on mobile).
Inserting an image opens the native dialog, which returns a path, and
`import_image_from_path` reads the bytes in Rust. Plugin ACLs constrain the
webview, not Rust, so nothing needs to be opened up for that read. Avoid
reaching for `@tauri-apps/plugin-fs` in the frontend; add a command instead.

**Attachments are raster only.** `ext_for_mime` in
`src-tauri/src/commands/attachments.rs` is the allowlist, and every entry point
goes through `store_attachment`, which enforces it along with the 10MB cap. SVG
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
[ADR 0009](decisions/0009-authenticated-signaling.md).

The signature answers "is this really that device". Whether we want to talk to
that device is still the pairing check against `device_pairs`, and both must
pass.

`mqtts://` is supported and preferred for any broker beyond localhost; the
reference `mosquitto.conf` also requires authentication and restricts each
device to its own topic subtree. Neither is what makes a message trustworthy,
but they keep pairing traffic and SDP off the wire in the clear.

The secret key lives in the app database rather than the OS keychain. Anything
that can read it can already read the notes, so this is coherent rather than
ideal; moving it is tracked as follow-up work in the ADR.

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
│   │   ├── network/         # MQTT client and signaling manager
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
the database, the attachment store, the MQTT signaling transport and identity;
it does not participate in the peer connection itself.

## Tech Stack

- **Frontend**: SvelteKit 2, Svelte 5, TypeScript, Tiptap (rich text editing)
- **Backend**: Rust, Tauri 2.0
- **Database**: SQLite (rusqlite)
- **Rust Crates**: walkdir, regex, ignore, glob, serde, chrono

---

## Releasing

The app supports 5 platforms: **macOS, Windows, Linux, Android, and iOS**.

- `make release` builds a release for **the current platform only** and puts artifacts in `dist/`.
- `make release-tag VERSION=x.y.z` pushes a git tag that triggers **GitHub Actions to build all 5 platforms** in parallel and publishes a draft GitHub Release.

### Bumping the version

The version lives in four places, and `src/lib/version.test.ts` fails when they
disagree. Change all four in the same commit:

1. `package.json`
2. `src-tauri/tauri.conf.json` (and `bundle.android.versionCode`)
3. `src-tauri/Cargo.toml` (run `cargo check` to refresh `Cargo.lock`)
4. `src/lib/changelog.ts` — add a new entry at the top of `RELEASES`

The sidebar footer shows the version from `package.json`, and clicking it opens
the About dialog with the changelog, so a release with no entry ships a dialog
that says nothing about it.

### Quick release (all platforms via CI)

```bash
make release-tag VERSION=1.0.0
# → pushes tag v1.0.0
# → GitHub Actions builds Mac/Win/Linux/Android/iOS in parallel
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

Keep `oyot.jks` somewhere safe (do **not** commit it).

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

| Platform | Local path                       | CI artifact    |
| -------- | -------------------------------- | -------------- |
| macOS    | `dist/mac/*.dmg`                 | GitHub Release |
| Windows  | `dist/windows/*.msi`, `*.exe`    | GitHub Release |
| Linux    | `dist/linux/*.deb`, `*.AppImage` | GitHub Release |
| Android  | `dist/android/*.apk`             | GitHub Release |
| iOS      | `dist/ios/*.ipa`                 | GitHub Release |
