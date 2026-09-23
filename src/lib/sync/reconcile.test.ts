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
            pull: true,
        });
        expect(reconcile(entry({ contentHash: null }), local)).toMatchObject({ pull: true });
        expect(reconcile(entry(), entry({ contentHash: null }))).toMatchObject({ pull: true });
    });

    it('does nothing for an identical document', () => {
        expect(reconcile(entry(), entry())).toEqual({ kind: 'up-to-date' });
    });
});
