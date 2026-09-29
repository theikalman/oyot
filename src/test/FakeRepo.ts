import * as Y from 'yjs';
import { base64ToBytes, type ManifestEntry } from '$lib/sync/protocol';
import { contentDigest } from './contentDigest';

// A DocumentRepository stand-in backed by real Y.Docs, for importing a backup
// without Tauri. Mirrors the rules the Rust commands apply (LWW rename and
// pin, tombstones, content hashes).
export class FakeRepo {
    docs = new Map<
        string,
        {
            docType: string;
            title: string;
            titleUpdatedAt: number;
            createdAt: number;
            isDeleted: boolean;
            deletedAt: number | null;
            lifecycleUpdatedAt: number;
            pinned: boolean;
            pinnedUpdatedAt: number | null;
            ydoc: Y.Doc;
        }
    >();

    seed(id: string, text: string, titleUpdatedAt = 1): void {
        const ydoc = new Y.Doc();
        ydoc.getText('content').insert(0, text);
        this.docs.set(id, {
            docType: 'note',
            title: id,
            titleUpdatedAt,
            createdAt: 1,
            isDeleted: false,
            deletedAt: null,
            lifecycleUpdatedAt: 1,
            pinned: false,
            pinnedUpdatedAt: null,
            ydoc,
        });
    }

    // Mirrors the Rust delete: tombstone the row, stamp the lifecycle register,
    // drop the CRDT history.
    remove(id: string, at: number): void {
        const d = this.docs.get(id);
        if (!d) throw new Error(`remove of unknown ${id}`);
        d.isDeleted = true;
        d.deletedAt = at;
        d.lifecycleUpdatedAt = at;
        d.ydoc = new Y.Doc();
    }

    // Mirrors the create upsert: clear the tombstone and stamp it later than
    // the delete it supersedes.
    revive(id: string, at: number, text: string): void {
        const d = this.docs.get(id);
        if (!d) throw new Error(`revive of unknown ${id}`);
        d.isDeleted = false;
        d.deletedAt = null;
        d.lifecycleUpdatedAt = at;
        d.ydoc = new Y.Doc();
        d.ydoc.getText('content').insert(0, text);
    }

    text(id: string): string {
        return this.docs.get(id)?.ydoc.getText('content').toString() ?? '';
    }

    async listSyncState(): Promise<ManifestEntry[]> {
        const out: ManifestEntry[] = [];
        for (const [id, d] of this.docs) {
            out.push({
                id,
                docType: d.docType,
                title: d.title,
                titleUpdatedAt: d.titleUpdatedAt,
                createdAt: d.createdAt,
                isDeleted: d.isDeleted,
                deletedAt: d.deletedAt,
                lifecycleUpdatedAt: d.lifecycleUpdatedAt,
                pinned: d.pinned,
                pinnedUpdatedAt: d.pinnedUpdatedAt,
                // As Rust reports it: an empty document has a hash too (ADR 0033).
                contentHash: contentDigest(d.ydoc),
            });
        }
        return out;
    }

    async mergeDelta(id: string, updateB64: string): Promise<void> {
        const d = this.docs.get(id);
        if (!d) throw new Error(`mergeDelta for unknown ${id}`);
        Y.applyUpdate(d.ydoc, base64ToBytes(updateB64));
    }

    async ensureDoc(entry: ManifestEntry): Promise<void> {
        const existing = this.docs.get(entry.id);
        const stamp = entry.lifecycleUpdatedAt ?? entry.createdAt;
        if (existing) {
            // Clears a local tombstone only when the peer observed the revival
            // later than we observed the delete.
            if (existing.isDeleted && existing.lifecycleUpdatedAt < stamp) {
                existing.isDeleted = false;
                existing.deletedAt = null;
                existing.lifecycleUpdatedAt = stamp;
            }
            return;
        }
        this.docs.set(entry.id, {
            docType: entry.docType,
            title: entry.title,
            titleUpdatedAt: entry.titleUpdatedAt,
            createdAt: entry.createdAt,
            isDeleted: false,
            deletedAt: null,
            lifecycleUpdatedAt: stamp,
            // Only a new row takes the peer's pin, as ensure_document does.
            pinned: entry.pinned ?? false,
            pinnedUpdatedAt: entry.pinnedUpdatedAt ?? null,
            ydoc: new Y.Doc(),
        });
    }

    // Mirrors ensure_tombstone: record a peer's tombstone for a document we
    // have never held, and never touch one we have.
    async ensureTombstone(entry: ManifestEntry): Promise<void> {
        if (this.docs.has(entry.id)) return;
        const stamp = entry.lifecycleUpdatedAt ?? entry.createdAt;
        this.docs.set(entry.id, {
            docType: entry.docType,
            title: entry.title,
            titleUpdatedAt: entry.titleUpdatedAt,
            createdAt: entry.createdAt,
            isDeleted: true,
            deletedAt: entry.deletedAt ?? stamp,
            lifecycleUpdatedAt: stamp,
            pinned: false,
            pinnedUpdatedAt: null,
            ydoc: new Y.Doc(),
        });
    }

    async applyRename(id: string, title: string, titleUpdatedAt: number): Promise<void> {
        const d = this.docs.get(id);
        if (d && (d.titleUpdatedAt ?? 0) < titleUpdatedAt) {
            d.title = title;
            d.titleUpdatedAt = titleUpdatedAt;
        }
    }

    // Mirrors apply_pin_if_newer: last writer wins on the stamp, and a tie
    // goes to pinned.
    async applyPin(id: string, pinned: boolean, pinnedUpdatedAt: number): Promise<void> {
        const d = this.docs.get(id);
        if (!d) return;
        const ours = d.pinnedUpdatedAt ?? 0;
        if (ours < pinnedUpdatedAt || (ours === pinnedUpdatedAt && pinned && !d.pinned)) {
            d.pinned = pinned;
            d.pinnedUpdatedAt = pinnedUpdatedAt;
        }
    }

    async applyDelete(id: string, deletedAt: number): Promise<boolean> {
        const d = this.docs.get(id);
        if (!d || d.lifecycleUpdatedAt >= deletedAt) return false;
        d.isDeleted = true;
        d.deletedAt = deletedAt;
        d.lifecycleUpdatedAt = deletedAt;
        d.ydoc = new Y.Doc();
        return true;
    }
}
