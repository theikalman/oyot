import * as Y from 'yjs';
import { bytesToBase64, base64ToBytes, type ManifestEntry } from '$lib/sync/protocol';
import { contentHashBase64 } from '$lib/sync/hash';

// A DocumentRepository stand-in backed by real Y.Docs. Mirrors the semantics
// the protocol relies on (deterministic update encoding, empty-update sentinel,
// LWW rename and pin, tombstones) without Tauri.
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
            const state = Y.encodeStateAsUpdate(d.ydoc);
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
                contentHash: state.length <= 2 ? null : await contentHashBase64(state),
            });
        }
        return out;
    }

    async localStateVector(id: string): Promise<string> {
        const d = this.docs.get(id);
        return bytesToBase64(Y.encodeStateVector(d ? d.ydoc : new Y.Doc()));
    }

    async computeDelta(id: string, svB64: string): Promise<string | null> {
        const d = this.docs.get(id);
        if (!d) return null;
        const diff = svB64
            ? Y.encodeStateAsUpdate(d.ydoc, base64ToBytes(svB64))
            : Y.encodeStateAsUpdate(d.ydoc);
        return diff.length <= 2 ? null : bytesToBase64(diff);
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

    // --- attachments ---
    attachments = new Map<string, { mime: string; data: string }>();

    async listAttachments(): Promise<{ hash: string; mime: string; size: number }[]> {
        return [...this.attachments].map(([hash, a]) => ({
            hash,
            mime: a.mime,
            size: a.data.length,
        }));
    }

    async hasAttachment(hash: string): Promise<boolean> {
        return this.attachments.has(hash);
    }

    async readAttachment(hash: string): Promise<{ mime: string; data: string } | null> {
        return this.attachments.get(hash) ?? null;
    }

    async saveAttachment(hash: string, mime: string, data: string): Promise<void> {
        this.attachments.set(hash, { mime, data });
    }
}
