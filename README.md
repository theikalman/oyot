# Oyot - Personal Knowledge Management System

> The status of this project is in active development. IT IS NOT STABLE YET.

A lightweight personal knowledge management app inspired by LogSeq, built with Tauri (Rust) and SvelteKit (TypeScript).

## Features

- **Simple**: Open the app, write. That is all, no need to organize anything manually.
- **Task Lists**: List out all of your TODO list in one place even if you write it anywhere in your notes.
- **Document Linking**: Track and index your linked notes. Easy to follow how your notes are tied to each other.

## Prerequisites

- Node.js 18+
- Rust 1.75+

## Setup

If you have [Nix](https://nixos.org/download.html) installed, enter the development shell:

```bash
nix-shell
```

This provides Node.js, Rust, Cargo, and all other build dependencies. Then install npm dependencies:

```bash
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
- `make clippy` - Run Rust linter

## Project Structure

```
oyot/
├── src/                    # SvelteKit frontend
│   ├── lib/
│   │   ├── components/      # UI components (Editor, Sidebar)
│   │   ├── stores/         # Svelte stores for state management
│   │   └── types.ts        # TypeScript type definitions
│   └── routes/             # SvelteKit routes
├── src-tauri/              # Rust backend
│   ├── src/                # Tauri commands and backend logic
│   ├── gen/android/        # Generated Android project (committed)
│   ├── gen/apple/          # Generated iOS/Xcode project (committed)
│   ├── Cargo.toml          # Rust dependencies
│   └── tauri.conf.json     # Tauri configuration
├── package.json            # Node dependencies
└── Makefile                # Build commands
```

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

| Secret | How to get the value |
|---|---|
| `ANDROID_SIGNING_KEY` | `base64 -i oyot.jks \| pbcopy` |
| `KEY_STORE_PASSWORD` | Password you set when creating the keystore |
| `KEY_ALIAS` | Alias you set (e.g. `oyot`) |
| `KEY_PASSWORD` | Key password (often the same as store password) |

#### iOS signing

1. In **Xcode → Settings → Accounts**, add your Apple ID and download your distribution certificate.
2. Open **Keychain Access**, find your "Apple Distribution" certificate, right-click → **Export** → save as `certificate.p12` with a password.
3. Download your `.mobileprovision` from [developer.apple.com/account/resources/profiles](https://developer.apple.com/account/resources/profiles).
4. Find your 10-character **Team ID** at [developer.apple.com/account](https://developer.apple.com/account) (top right).

| Secret | How to get the value |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i certificate.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_PROVISIONING_PROFILE` | `base64 -i profile.mobileprovision \| pbcopy` |
| `KEYCHAIN_PASSWORD` | Any strong random string (used only in CI) |
| `APPLE_DEVELOPMENT_TEAM` | Your 10-character Team ID (e.g. `AB12CD34EF`) |

---

### Local release (current platform only)

```bash
make release          # builds for current OS → dist/mac/, dist/linux/, or dist/windows/
make release-android  # builds APK → dist/android/  (requires Android SDK + NDK)
make release-ios      # builds IPA → dist/ios/       (requires Xcode + Apple certificate)
```

Output is placed in `dist/` (gitignored — release binaries are not committed).

---

### Artifact locations after build

| Platform | Local path | CI artifact |
|---|---|---|
| macOS | `dist/mac/*.dmg` | GitHub Release |
| Windows | `dist/windows/*.msi`, `*.exe` | GitHub Release |
| Linux | `dist/linux/*.deb`, `*.AppImage` | GitHub Release |
| Android | `dist/android/*.apk` | GitHub Release |
| iOS | `dist/ios/*.ipa` | GitHub Release |
