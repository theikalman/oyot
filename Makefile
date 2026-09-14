.PHONY: help install dev build run clean check fmt lint test verify clippy \
        release release-android release-android-aab release-ios release-tag install-android \
        mqtt-up mqtt-down mqtt-logs

# Only apply the custom Rust path on macOS (Apple Silicon); not needed on CI
# or Linux/Windows. `$(filter darwin,Darwin)` never matched, because filter is
# case-sensitive, so this block had never run.
ifeq ($(shell uname -s),Darwin)
RUST_PATH := /opt/homebrew/opt/rustup/bin:$(HOME)/.rustup/toolchains/stable-aarch64-apple-darwin/bin
export PATH := $(RUST_PATH):$(PATH)
endif

# Android SDK - override by setting env vars before calling make
ANDROID_HOME ?= $(HOME)/Android
ANDROID_SDK_ROOT ?= $(HOME)/Android
export ANDROID_HOME
export ANDROID_SDK_ROOT

# Android NDK - must match `ndkVersion` in src-tauri/gen/android/app/build.gradle.kts.
# Used both by the Rust cross-compile (Tauri) and by AGP's native-debug-symbol extraction.
ANDROID_NDK_VERSION ?= 30.0.15729638
ANDROID_NDK_HOME ?= $(ANDROID_HOME)/ndk/$(ANDROID_NDK_VERSION)
NDK_HOME ?= $(ANDROID_NDK_HOME)
export ANDROID_NDK_HOME
export NDK_HOME

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
	@echo "  make lint             - Run the eslint and clippy linters"
	@echo "  make verify           - Everything CI runs: format, lint, typecheck, test"
	@echo "  make clippy           - Run Rust linter"
	@echo ""
	@echo "MQTT broker commands:"
	@echo "  make mqtt-up         - Start MQTT broker in Docker (port 1883)"
	@echo "  make mqtt-down       - Stop MQTT broker"
	@echo "  make mqtt-logs       - Follow MQTT broker logs"
	@echo ""
	@echo "Release commands:"
	@echo "  make release                    - Build current platform → dist/"
	@echo "  make release-android            - Build Android APK → dist/android/"
	@echo "  make release-android-aab        - Build Android AAB (Play Store) → dist/android/"
	@echo "  make release-ios                - Build iOS IPA → dist/ios/"
	@echo "  make release-tag VERSION=x.y.z  - Push git tag → triggers full CI"

install:
	npm install --force

# ---------------------------------------------------------------------------
# MQTT broker (Docker)
# ---------------------------------------------------------------------------

mqtt-up:
	docker compose up -d mqtt
	@echo "MQTT broker started on mqtt://localhost:1883"

mqtt-down:
	docker compose down mqtt

mqtt-logs:
	docker compose logs -f mqtt

# ---------------------------------------------------------------------------
# App targets
# ---------------------------------------------------------------------------

dev:
	env RUST_BACKTRACE=full npm run tauri dev

# Android signing.
#
# The keystore path and its password used to be written here, the password in
# plain text on three lines. It is in the git history as a result, so treat it
# as public and rotate it: `keytool -storepasswd -keystore oyot.jks` and
# `keytool -keypasswd -alias oyot -keystore oyot.jks`. The keystore file itself
# was never committed, so the signing key is not compromised.
#
# Set these in your shell, or a .env your shell sources. `make` will not run a
# signing target without them.
ANDROID_KEYSTORE ?= $(CURDIR)/oyot.jks
# ANDROID_KEYSTORE_PASSWORD: no default on purpose.

# Fail with an explanation rather than an apksigner usage error.
define require_signing
	@test -n "$(ANDROID_KEYSTORE_PASSWORD)" || { \
		echo "ERROR: ANDROID_KEYSTORE_PASSWORD is not set."; \
		echo "  export ANDROID_KEYSTORE_PASSWORD=... (and ANDROID_KEYSTORE if not ./oyot.jks)"; \
		exit 1; \
	}
	@test -f "$(ANDROID_KEYSTORE)" || { \
		echo "ERROR: keystore not found at $(ANDROID_KEYSTORE)"; \
		echo "  set ANDROID_KEYSTORE to its path."; \
		exit 1; \
	}
endef

install-android:
	$(require_signing)
	npm run tauri android build -- --target aarch64 --debug && \
		cd $(ANDROID_HOME)/build-tools/35.0.0/ && \
		./apksigner sign --ks "$(ANDROID_KEYSTORE)" --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
			--out /tmp/oyot-signed.apk \
			$(CURDIR)/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk && \
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

lint:
	npm run lint
	cd src-tauri && cargo clippy --all-targets -- -D warnings

test:
	npm test
	cd src-tauri && cargo test

# Mirrors .github/workflows/ci.yml. Run this before pushing.
verify:
	npm run format:check
	npm run lint
	npm run check
	npm test
	cd src-tauri && cargo fmt --check
	cd src-tauri && cargo clippy --all-targets -- -D warnings
	cd src-tauri && cargo test

clippy:
	cd src-tauri && cargo clippy --all-targets -- -D warnings

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
	$(require_signing)
	@echo "Building Android release..."
	npm run tauri android build -- --apk
	@mkdir -p dist/android
	cd $(ANDROID_HOME)/build-tools/35.0.0/ && \
		./apksigner sign --ks "$(ANDROID_KEYSTORE)" --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
			--out $(CURDIR)/dist/android/oyot-release.apk \
			$(CURDIR)/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
	@echo "Android artifacts → dist/android/"

release-android-aab:
	$(require_signing)
	@echo "Building Android App Bundle..."
	@mkdir -p dist/android
	@echo "Using NDK: $(ANDROID_NDK_HOME)"
	@test -d "$(ANDROID_NDK_HOME)" || { \
		echo "ERROR: NDK not found at $(ANDROID_NDK_HOME)"; \
		echo "Install it (sdkmanager \"ndk;$(ANDROID_NDK_VERSION)\") or set ANDROID_NDK_VERSION/ANDROID_NDK_HOME."; \
		exit 1; \
	}
	@echo "Pinning SDK dir for AGP (NDK is selected via ndkVersion in app/build.gradle.kts)..."
	@printf 'sdk.dir=%s\n' "$(ANDROID_HOME)" > src-tauri/gen/android/local.properties
	npm run tauri android build -- --aab
	cp $(CURDIR)/src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab \
		$(CURDIR)/dist/android/oyot-release.aab
	jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
		-keystore "$(ANDROID_KEYSTORE)" -storepass "$(ANDROID_KEYSTORE_PASSWORD)" \
		$(CURDIR)/dist/android/oyot-release.aab oyot
	@unzip -l $(CURDIR)/dist/android/oyot-release.aab \
		| grep -q 'com.android.tools.build.debugsymbols' \
		&& echo "OK: native debug symbols bundled in AAB" \
		|| { echo "ERROR: native debug symbols missing from AAB - check the release strip step is not a no-op"; exit 1; }
	@echo "Android App Bundle -> dist/android/oyot-release.aab"

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
