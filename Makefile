.PHONY: help install dev build run clean check fmt clippy \
        release release-android release-ios release-tag install-android \
        signal-up signal-down signal-logs signal-build signal-dev

# Only apply custom Rust path on macOS (Apple Silicon) — not needed on CI or Linux/Windows
ifneq ($(filter darwin,Darwin),)
RUST_PATH := /opt/homebrew/opt/rustup/bin:$(HOME)/.rustup/toolchains/stable-aarch64-apple-darwin/bin
export PATH := $(RUST_PATH):$(PATH)
endif

# Signaling server port
SIGNALING_PORT ?= 3001
export SIGNALING_PORT

# Android SDK — override by setting env vars before calling make
ANDROID_HOME ?= $(HOME)/Android
ANDROID_SDK_ROOT ?= $(HOME)/Android
export ANDROID_HOME
export ANDROID_SDK_ROOT

help:
	@echo "Available commands:"
	@echo "  make install          - Install npm dependencies"
	@echo "  make dev              - Run development server"
	@echo "  make install-android  - Build Android APK and install to tablet"
	@echo "  make build            - Build the application"
	@echo "  make run              - Build and run the application"
	@echo "  make clean            - Clean build artifacts"
	@echo "  make check            - Run TypeScript and Rust checks"
	@echo "  make fmt              - Format code"
	@echo "  make clippy           - Run Rust linter"
	@echo ""
	@echo "Signaling server commands:"
	@echo "  make signal-build      - Build signaling server Docker image"
	@echo "  make signal-up         - Start signaling server in Docker (port $(SIGNALING_PORT))"
	@echo "  make signal-down       - Stop signaling server"
	@echo "  make signal-logs       - Follow signaling server logs"
	@echo "  make signal-dev        - Run signaling server in dev mode (no Docker)"
	@echo ""
	@echo "Release commands:"
	@echo "  make release                    - Build current platform → dist/"
	@echo "  make release-android            - Build Android APK → dist/android/"
	@echo "  make release-ios                - Build iOS IPA → dist/ios/"
	@echo "  make release-tag VERSION=x.y.z  - Push git tag → triggers full CI"

install:
	npm install

# ---------------------------------------------------------------------------
# Signaling server (Docker)
# ---------------------------------------------------------------------------

signal-build:
	@git_hash=$$(git rev-parse --short HEAD); \
	date=$$(date +%Y.%m.%d); \
	export TAG=$${date}-$${git_hash}; \
	echo "Building images with tag: $$TAG"; \
	docker compose build signaling

signal-up:
	docker compose up -d signaling
	@echo "Signaling server started on ws://localhost:$(SIGNALING_PORT)"

signal-down:
	docker compose down signaling

signal-logs:
	docker compose logs -f signaling

signal-dev:
	cd signaling-server && \
		npm install && \
		env HOST=192.168.1.103 npm run dev

# ---------------------------------------------------------------------------
# App targets
# ---------------------------------------------------------------------------

dev:
	env RUST_BACKTRACE=full npm run tauri dev

install-android:
	npm run tauri android build -- --target aarch64 --debug && \
		cd $(ANDROID_HOME)/build-tools/35.0.0/ && \
		./apksigner sign --ks $(HOME)/repo/oyot/oyot.jks --ks-pass pass:ajiyakin123 --out /tmp/oyot-signed.apk $(HOME)/repo/oyot/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk && \
		cd $(ANDROID_HOME)/platform-tools/ && \
		adb install -r /tmp/oyot-signed.apk

build:
	npm run tauri build

run:
	npm run tauri build && open src-tauri/target/release/bundle/macos/oyot.app

clean:
	rm -rf src-tauri/target
	rm -rf node_modules/.cache
	rm -rf .svelte-kit
	rm -rf build
	rm -rf dist

check:
	npm run check
	cd src-tauri && cargo check

fmt:
	npm run format
	cd src-tauri && cargo fmt

clippy:
	cd src-tauri && cargo clippy -- -D warnings

# ---------------------------------------------------------------------------
# Release targets
# ---------------------------------------------------------------------------

release:
	@echo "Building release for current platform..."
	npm run tauri build
	@mkdir -p dist
	@OS=$$(uname -s); \
	if [ "$$OS" = "Darwin" ]; then \
		mkdir -p dist/mac; \
		find src-tauri/target/release/bundle/dmg -name "*.dmg" -exec cp {} dist/mac/ \; 2>/dev/null || true; \
		echo "macOS artifacts → dist/mac/"; \
	elif [ "$$OS" = "Linux" ]; then \
		mkdir -p dist/linux; \
		find src-tauri/target/release/bundle/deb -name "*.deb" -exec cp {} dist/linux/ \; 2>/dev/null || true; \
		find src-tauri/target/release/bundle/appimage -name "*.AppImage" -exec cp {} dist/linux/ \; 2>/dev/null || true; \
		echo "Linux artifacts → dist/linux/"; \
	else \
		mkdir -p dist/windows; \
		find src-tauri/target/release/bundle/msi -name "*.msi" -exec cp {} dist/windows/ \; 2>/dev/null || true; \
		find src-tauri/target/release/bundle/nsis -name "*-setup.exe" -exec cp {} dist/windows/ \; 2>/dev/null || true; \
		echo "Windows artifacts → dist/windows/"; \
	fi

release-android:
	@echo "Building Android release..."
	npm run tauri android build -- --apk
	@mkdir -p dist/android
	@find src-tauri/gen/android/app/build/outputs/apk -name "*.apk" -path "*/release/*" \
		-exec cp {} dist/android/ \; 2>/dev/null || true
	@echo "Android artifacts → dist/android/"

release-ios:
	@echo "Building iOS release..."
	npm run tauri ios build
	@mkdir -p dist/ios
	@find src-tauri/gen/apple/build -name "*.ipa" \
		-exec cp {} dist/ios/ \; 2>/dev/null || true
	@echo "iOS artifacts → dist/ios/"

release-tag:
	@if [ -z "$(VERSION)" ]; then \
		echo "Usage: make release-tag VERSION=1.2.3"; \
		exit 1; \
	fi
	git tag v$(VERSION)
	git push origin v$(VERSION)
	@echo "Tag v$(VERSION) pushed — GitHub Actions will build all platforms."
	@echo "Monitor progress at: https://github.com/$$(git remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/\.git$$//')/actions"
