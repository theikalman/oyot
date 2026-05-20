.PHONY: help install dev build run clean check fmt clippy

RUST_PATH := /opt/homebrew/opt/rustup/bin:$(HOME)/.rustup/toolchains/stable-aarch64-apple-darwin/bin
export PATH := $(RUST_PATH):$(PATH)

help:
	@echo "Available commands:"
	@echo "  make install   - Install npm dependencies"
	@echo "  make dev       - Run development server"
	@echo "  make build     - Build the application"
	@echo "  make run       - Run the built application"
	@echo "  make clean     - Clean build artifacts"
	@echo "  make check     - Run TypeScript and Rust checks"
	@echo "  make fmt       - Format code"
	@echo "  make clippy    - Run Rust linter"

install:
	npm install

dev:
	npm run tauri dev

build:
	npm run tauri build

run:
	npm run tauri build && open src-tauri/target/release/bundle/macos/oyot.app

clean:
	rm -rf src-tauri/target
	rm -rf node_modules/.cache
	rm -rf .svelte-kit
	rm -rf build
	rm -rf src-tauri/src/gen

check:
	npm run check
	cd src-tauri && cargo check

fmt:
	npm run format
	cd src-tauri && cargo fmt

clippy:
	cd src-tauri && cargo clippy -- -D warnings