import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_VERSION } from './version';
import { RELEASES } from './changelog';

const root = resolve(__dirname, '../..');

function read(file: string): string {
    return readFileSync(resolve(root, file), 'utf8');
}

// The version is written down in five places. The app shows one of them, so a
// bump that misses any of the others would have the app lie about itself, and
// a missed Android versionCode is rejected by Play only after the build has
// already run. `make bump` writes all five; these tests are what catch a hand
// edit that did not.
describe('app version', () => {
    it('matches package.json', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(APP_VERSION).toBe(pkg.version);
    });

    it('matches src-tauri/tauri.conf.json', () => {
        const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
        expect(conf.version).toBe(APP_VERSION);
    });

    it('matches src-tauri/Cargo.toml', () => {
        const cargoVersion = read('src-tauri/Cargo.toml').match(/^version = "(.+)"$/m)?.[1];
        expect(cargoVersion).toBe(APP_VERSION);
    });

    it('is the newest changelog entry', () => {
        expect(RELEASES[0].version).toBe(APP_VERSION);
    });

    // Android will not accept an upload whose versionCode repeats or lowers a
    // published one, so it has to move with the version and it has to be
    // derived the same way every time.
    it('matches the Android versionCode', () => {
        const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
        const [, major, minor, patch] = APP_VERSION.match(/^(\d+)\.(\d+)\.(\d+)/) ?? [];
        expect(major, `could not read a version out of ${APP_VERSION}`).toBeDefined();

        const expected = 1000 + Number(major) * 10000 + Number(minor) * 100 + Number(patch);
        expect(conf.bundle.android.versionCode).toBe(expected);
    });

    it('keeps the versionCode scheme monotonic', () => {
        // The scheme only increases while minor and patch stay below 100.
        // `scripts/bump-version.sh` refuses to go past that, and this says why.
        const [, , minor, patch] = APP_VERSION.match(/^(\d+)\.(\d+)\.(\d+)/) ?? [];
        expect(Number(minor)).toBeLessThan(100);
        expect(Number(patch)).toBeLessThan(100);
    });
});

describe('changelog', () => {
    it('lists releases newest first by date', () => {
        const dates = RELEASES.map((release) => release.date);
        expect(dates).toEqual([...dates].sort().reverse());
    });

    it('gives every release a date, a summary and at least one change', () => {
        for (const release of RELEASES) {
            expect(release.date, `${release.version} date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(release.summary.length, `${release.version} summary`).toBeGreaterThan(0);
            expect(release.changes.length, `${release.version} changes`).toBeGreaterThan(0);
        }
    });

    it('has no duplicate versions', () => {
        const versions = RELEASES.map((release) => release.version);
        expect(new Set(versions).size).toBe(versions.length);
    });
});
