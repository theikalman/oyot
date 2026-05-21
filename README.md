# Oyot - Personal Knowledge Management System

A lightweight personal knowledge management app inspired by LogSeq, built with Tauri (Rust) and SvelteKit (TypeScript).

## Features

- **Simple**: Open the app, write. That is all, no need to organize anything manually.
- **Task Lists**: List out all of your TODO list in one place even if you write it anywhere in your notes.
- **Document Linking**: Track and index your linked notes. Easy to follow how your notes are tied to each other.

## Prerequisites

- Node.js 18+
- Rust 1.75+
- Homebrew (for macOS)

## Setup

1. Install Rust (if not already installed):
   ```bash
   brew install rustup-init
   rustup-init
   ```

2. Set up your PATH (add to your `~/.zshrc`):
   ```bash
   export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
   ```

3. Install dependencies:
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
