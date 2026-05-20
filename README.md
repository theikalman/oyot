# Oyot - Personal Knowledge Management System

A lightweight personal knowledge management app inspired by LogSeq, built with Tauri (Rust) and SvelteKit (TypeScript).

## Features

- **Wiki-style Linking**: Link between files using `[[File Title Here]]` syntax
- **Reading Mode**: View markdown files with rendered HTML
- **Index Views**: Browse and search through your knowledge base
  - All Files
  - All Links (with backlink tracking)
  - TODO items across all files

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
./run-dev.sh
```
Or manually:
```bash
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Project Structure

```
oyot/
├── src/                    # SvelteKit frontend
│   ├── lib/
│   │   ├── components/    # UI components (Sidebar, Reader, Index)
│   │   ├── stores/        # Svelte stores for state management
│   │   ├── types.ts       # TypeScript type definitions
│   │   └── utils/         # Utility functions (markdown parsing)
│   └── routes/            # SvelteKit routes
├── src-tauri/             # Rust backend
│   ├── src/lib.rs         # Tauri commands (file scanning, search)
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri configuration
└── package.json           # Node dependencies
```

## Tech Stack

- **Frontend**: SvelteKit, TypeScript, unified/remark (markdown parsing)
- **Backend**: Rust, Tauri 2.0
- **Rust Crates**: walkdir, regex, ignore, glob