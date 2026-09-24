import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import type { ManifestEntry } from './protocol';

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
    return {
        id: 'doc',
        docType: 'note',
        title: 'Doc',
        titleUpdatedAt: 10,
        createdAt: 1,
        isDeleted: false,
        deletedAt: null,
        lifecycleUpdatedAt: 1,
        contentHash: 'hash-a',
        ...overrides,
    };
}

function tombstone(at: number, overrides: Partial<ManifestEntry> = {}): ManifestEntry {
    return entry({
        isDeleted: true,
        deletedAt: at,
        lifecycleUpdatedAt: at,
        contentHash: null,
        ...overrides,
    });
}

describe('reconcile', () => {
    it('creates a document this device has never seen', () => {
        expect(reconcile(entry(), undefined)).toEqual({ kind: 'create' });
    });

    it('records a tombstone for a document this device never held', () => {
        expect(reconcile(tombstone(5), undefined)).toEqual({ kind: 'record-tombstone' });
    });

    it('applies a delete made after this device last saw the document change', () => {
        expect(reconcile(tombstone(50), entry({ lifecycleUpdatedAt: 20 }))).toEqual({
            kind: 'delete',
            deletedAt: 50,
        });
    });

    it('falls back to the lifecycle stamp when a tombstone carries no delete time', () => {
        const remote = tombstone(50, { deletedAt: null });
        expect(reconcile(remote, entry({ lifecycleUpdatedAt: 20 }))).toEqual({
            kind: 'delete',
            deletedAt: 50,
        });
    });

    it('ignores a tombstone older than a revival this device observed', () => {
        expect(reconcile(tombstone(20), entry({ lifecycleUpdatedAt: 50 }))).toEqual({
            kind: 'stale-tombstone',
        });
    });

    it('revives a document they revived after this device deleted it', () => {
        expect(reconcile(entry({ lifecycleUpdatedAt: 60 }), tombstone(50))).toEqual({
            kind: 'revive',
        });
    });

    it('keeps a delete at least as new as their copy', () => {
        expect(reconcile(entry({ lifecycleUpdatedAt: 50 }), tombstone(50))).toEqual({
            kind: 'stays-deleted',
        });
        expect(reconcile(entry({ lifecycleUpdatedAt: 40 }), tombstone(50))).toEqual({
            kind: 'stays-deleted',
        });
    });

    it('takes a newer title, and only a newer one', () => {
        const local = entry({ titleUpdatedAt: 10 });
        expect(reconcile(entry({ title: 'New', titleUpdatedAt: 11 }), local)).toEqual({
            kind: 'update',
            rename: true,
            repin: false,
            pull: false,
        });
        expect(reconcile(entry({ title: 'Old', titleUpdatedAt: 9 }), local)).toEqual({
            kind: 'up-to-date',
        });
    });

    it('exchanges content when the hashes differ or one is unknown', () => {
        const local = entry();
        expect(reconcile(entry({ contentHash: 'hash-b' }), local)).toEqual({
            kind: 'update',
            rename: false,
            repin: false,
            pull: true,
        });
        expect(reconcile(entry({ contentHash: null }), local)).toMatchObject({ pull: true });
        expect(reconcile(entry(), entry({ contentHash: null }))).toMatchObject({ pull: true });
    });

    it('does nothing for an identical document', () => {
        expect(reconcile(entry(), entry())).toEqual({ kind: 'up-to-date' });
    });

    // A pin is a register like the title: whichever side set it last, pinned
    // or unpinned, is the answer.
    it('takes a newer pin, and only a newer one', () => {
        const local = entry({ pinned: true, pinnedUpdatedAt: 50 });
        expect(reconcile(entry({ pinned: false, pinnedUpdatedAt: 60 }), local)).toEqual({
            kind: 'update',
            rename: false,
            repin: true,
            pull: false,
        });
        expect(reconcile(entry({ pinned: false, pinnedUpdatedAt: 40 }), local)).toEqual({
            kind: 'up-to-date',
        });
    });

    it('takes a pin on a note this device never pinned', () => {
        expect(reconcile(entry({ pinned: true, pinnedUpdatedAt: 1 }), entry())).toMatchObject({
            repin: true,
        });
    });

    // Without a rule for a tie, two devices that set different pins at one
    // stamp would each keep their own for good.
    it('breaks a tie on the pin stamp in favour of pinned, from either side', () => {
        const pinned = entry({ pinned: true, pinnedUpdatedAt: 50 });
        const unpinned = entry({ pinned: false, pinnedUpdatedAt: 50 });
        expect(reconcile(pinned, unpinned)).toMatchObject({ repin: true });
        expect(reconcile(unpinned, pinned)).toEqual({ kind: 'up-to-date' });
    });

    // A peer still on a build from before pins sends no pin at all, which has
    // to read as "never pinned" rather than as unpinning everything.
    it('changes no pin for a manifest that carries none', () => {
        const old = entry();
        delete old.pinned;
        delete old.pinnedUpdatedAt;
        expect(reconcile(old, entry({ pinned: true, pinnedUpdatedAt: 50 }))).toEqual({
            kind: 'up-to-date',
        });
    });
});
