import type { DocumentRepository } from '../DocumentRepository';
import {
    SYNC_PROTOCOL_VERSION,
    type ManifestEntry,
    type SyncMessage,
} from '../protocol';

export interface SyncProgressSink {
    onPhase(phase: 'reconciling' | 'transferring' | 'synced' | 'error'): void;
    onProgress(pending: number, total: number): void;
    onSynced(at: number): void;
}

// Bound in-flight `sync-need`s so a peer with hundreds of divergent docs does
// not balloon memory or the send buffer.
const MAX_IN_FLIGHT = 4;
// A `sync-need` with no answer within this long is retried once, then dropped
// (the next reconnect's manifest will pick it up).
const NEED_TIMEOUT_MS = 20_000;
const MAX_NEED_ATTEMPTS = 2;

interface NeedItem {
    id: string;
    sv: string;
    attempts: number;
}

// Attachment transfer runs on its own queue, off the document finish gate: an
// image can be large and slow, and text sync should not wait on it.
const MAX_ATTACH_IN_FLIGHT = 2;
const ATTACH_TIMEOUT_MS = 30_000;
const MAX_ATTACH_ATTEMPTS = 2;

// Runs the two-phase reconciliation (manifest, then delta) for ONE data channel,
// plus the steady-state live-message fast path. Pure logic: it talks to a
// DocumentRepository and a `send` function, never to the transport or the store
// directly. Version-negotiated via `hello`.
export class DocSyncProtocol {
    private started = false;
    private incompatiblePeer = false;
    private localDone = false;
    private peerDone = false;

    private queue: NeedItem[] = [];
    private inFlight = new Map<string, NeedItem>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private total = 0;
    private settled = 0;

    private attachQueue: string[] = [];
    private attachInFlight = new Map<string, number>(); // hash -> attempts
    private attachTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly repo: DocumentRepository,
        private readonly send: (m: SyncMessage) => void | Promise<void>,
        private readonly sink: SyncProgressSink,
    ) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        this.sink.onPhase('reconciling');
        this.send({ t: 'hello', v: SYNC_PROTOCOL_VERSION });
        try {
            const docs = await this.repo.listSyncState();
            this.send({ t: 'sync-manifest', docs });
        } catch (e) {
            console.error('[sync] failed to send manifest:', e);
            this.sink.onPhase('error');
        }
        void this.sendAttachManifest();
    }

    dispose(): void {
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        for (const t of this.attachTimers.values()) clearTimeout(t);
        this.attachTimers.clear();
    }

    async handle(msg: SyncMessage): Promise<void> {
        switch (msg.t) {
            case 'hello':
                if (msg.v !== SYNC_PROTOCOL_VERSION) {
                    this.incompatiblePeer = true;
                    this.sink.onPhase('error');
                    console.warn(`[sync] peer speaks protocol v${msg.v}, we speak v${SYNC_PROTOCOL_VERSION}`);
                }
                return;
            case 'sync-manifest':
                await this.onManifest(msg.docs);
                return;
            case 'sync-need':
                await this.onNeed(msg.id, msg.sv);
                return;
            case 'sync-delta':
                await this.onDelta(msg.id, msg.update);
                return;
            case 'sync-done':
                this.peerDone = true;
                this.maybeFinish();
                return;
            case 'doc-created':
                await this.onLiveCreated(msg.entry);
                return;
            case 'doc-renamed':
                await this.repo.applyRename(msg.id, msg.title, msg.titleUpdatedAt);
                return;
            case 'doc-deleted':
                await this.repo.applyDelete(msg.id, msg.deletedAt);
                return;
            case 'live-update':
                await this.repo.mergeDelta(msg.id, msg.update).catch((e) =>
                    console.error(`[sync] live-update merge failed for ${msg.id}:`, e),
                );
                return;
            case 'attach-manifest':
                await this.onAttachManifest(msg.items.map((i) => i.hash));
                return;
            case 'attach-need':
                await this.onAttachNeed(msg.hash);
                return;
            case 'attach-data':
                await this.onAttachData(msg.hash, msg.mime, msg.data);
                return;
            case 'attach-missing':
                this.clearAttachInFlight(msg.hash);
                this.attachPump();
                return;
        }
    }

    // --- attachments ---------------------------------------------------

    private async sendAttachManifest(): Promise<void> {
        if (this.incompatiblePeer) return;
        try {
            const items = await this.repo.listAttachments();
            if (items.length > 0) this.send({ t: 'attach-manifest', items });
        } catch (e) {
            console.error('[sync] failed to send attachment manifest:', e);
        }
    }

    private async onAttachManifest(hashes: string[]): Promise<void> {
        if (this.incompatiblePeer) return;
        for (const hash of hashes) {
            if (this.attachInFlight.has(hash) || this.attachQueue.includes(hash)) continue;
            try {
                if (await this.repo.hasAttachment(hash)) continue;
            } catch (e) {
                console.error(`[sync] hasAttachment(${hash}) failed:`, e);
                continue;
            }
            this.attachQueue.push(hash);
        }
        this.attachPump();
    }

    // Pull one attachment now (steady-state: a freshly inserted image).
    requestAttachment(hash: string): void {
        if (this.attachInFlight.has(hash) || this.attachQueue.includes(hash)) return;
        this.attachQueue.push(hash);
        this.attachPump();
    }

    private attachPump(): void {
        while (this.attachInFlight.size < MAX_ATTACH_IN_FLIGHT && this.attachQueue.length > 0) {
            const hash = this.attachQueue.shift()!;
            const attempts = (this.attachInFlight.get(hash) ?? 0) + 1;
            this.attachInFlight.set(hash, attempts);
            this.send({ t: 'attach-need', hash });
            this.armAttachTimeout(hash);
        }
    }

    private armAttachTimeout(hash: string): void {
        const existing = this.attachTimers.get(hash);
        if (existing) clearTimeout(existing);
        this.attachTimers.set(
            hash,
            setTimeout(() => {
                this.attachTimers.delete(hash);
                const attempts = this.attachInFlight.get(hash);
                if (attempts === undefined) return;
                this.attachInFlight.delete(hash);
                if (attempts < MAX_ATTACH_ATTEMPTS) {
                    this.attachQueue.push(hash);
                    this.attachPump();
                } else {
                    console.warn(`[sync] gave up pulling attachment ${hash} after ${attempts} attempts`);
                }
            }, ATTACH_TIMEOUT_MS),
        );
    }

    private clearAttachInFlight(hash: string): void {
        this.attachInFlight.delete(hash);
        const timer = this.attachTimers.get(hash);
        if (timer) {
            clearTimeout(timer);
            this.attachTimers.delete(hash);
        }
    }

    private async onAttachNeed(hash: string): Promise<void> {
        try {
            const bytes = await this.repo.readAttachment(hash);
            if (bytes) this.send({ t: 'attach-data', hash, mime: bytes.mime, data: bytes.data });
            else this.send({ t: 'attach-missing', hash });
        } catch (e) {
            console.error(`[sync] readAttachment(${hash}) failed:`, e);
            this.send({ t: 'attach-missing', hash });
        }
    }

    private async onAttachData(hash: string, mime: string, data: string): Promise<void> {
        this.clearAttachInFlight(hash);
        try {
            await this.repo.saveAttachment(hash, mime, data);
        } catch (e) {
            console.error(`[sync] saveAttachment(${hash}) failed:`, e);
        }
        this.attachPump();
    }

    // --- phase 1 --------------------------------------------------------

    private async onManifest(remote: ManifestEntry[]): Promise<void> {
        if (this.incompatiblePeer) return;

        const local = new Map((await this.repo.listSyncState()).map((e) => [e.id, e]));

        for (const entry of remote) {
            try {
                await this.reconcileEntry(entry, local.get(entry.id));
            } catch (e) {
                console.error(`[sync] reconcile failed for ${entry.id}:`, e);
            }
        }

        this.total = this.queue.length + this.inFlight.size;
        this.settled = 0;
        this.reportProgress();
        this.pump();

        this.localDone = true;
        this.send({ t: 'sync-done' });
        this.maybeFinish();
    }

    private async reconcileEntry(entry: ManifestEntry, local: ManifestEntry | undefined): Promise<void> {
        if (entry.isDeleted) {
            if (!local || !local.isDeleted) {
                await this.repo.applyDelete(entry.id, entry.deletedAt ?? Date.now());
            }
            return;
        }

        if (!local) {
            await this.repo.ensureDoc(entry);
            this.enqueue({ id: entry.id, sv: '', attempts: 0 });
            return;
        }

        // We hold a tombstone for a doc the peer still has live: tombstone wins,
        // our manifest will tell them to delete it. Nothing to pull.
        if (local.isDeleted) return;

        if (entry.titleUpdatedAt > local.titleUpdatedAt) {
            await this.repo.applyRename(entry.id, entry.title, entry.titleUpdatedAt);
        }

        const differ = !local.contentHash || !entry.contentHash || local.contentHash !== entry.contentHash;
        if (differ) {
            const sv = await this.repo.localStateVector(entry.id);
            this.enqueue({ id: entry.id, sv, attempts: 0 });
        }
    }

    // --- phase 2 --------------------------------------------------------

    private enqueue(item: NeedItem): void {
        if (this.inFlight.has(item.id) || this.queue.some((q) => q.id === item.id)) return;
        this.queue.push(item);
    }

    private pump(): void {
        while (this.inFlight.size < MAX_IN_FLIGHT && this.queue.length > 0) {
            const item = this.queue.shift()!;
            item.attempts++;
            this.inFlight.set(item.id, item);
            this.send({ t: 'sync-need', id: item.id, sv: item.sv });
            this.armTimeout(item);
        }
    }

    private armTimeout(item: NeedItem): void {
        const existing = this.timers.get(item.id);
        if (existing) clearTimeout(existing);
        this.timers.set(
            item.id,
            setTimeout(() => {
                this.timers.delete(item.id);
                if (!this.inFlight.delete(item.id)) return;
                if (item.attempts < MAX_NEED_ATTEMPTS) {
                    this.queue.push(item);
                    this.pump();
                } else {
                    console.warn(`[sync] gave up pulling ${item.id} after ${item.attempts} attempts`);
                    this.settle();
                }
            }, NEED_TIMEOUT_MS),
        );
    }

    private async onNeed(id: string, sv: string): Promise<void> {
        try {
            const update = await this.repo.computeDelta(id, sv);
            if (update) this.send({ t: 'sync-delta', id, update });
        } catch (e) {
            console.error(`[sync] computeDelta failed for ${id}:`, e);
        }
    }

    private async onDelta(id: string, update: string): Promise<void> {
        const wasTracked = this.inFlight.delete(id);
        const timer = this.timers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(id);
        }
        try {
            await this.repo.mergeDelta(id, update);
        } catch (e) {
            console.error(`[sync] mergeDelta failed for ${id}:`, e);
        }
        if (wasTracked) this.settle();
        else this.pump();
    }

    private settle(): void {
        this.settled++;
        this.reportProgress();
        this.pump();
        this.maybeFinish();
    }

    private async onLiveCreated(entry: ManifestEntry): Promise<void> {
        await this.repo.ensureDoc(entry);
        // Pull its content out-of-band; not tracked against the finish gate.
        this.send({ t: 'sync-need', id: entry.id, sv: '' });
    }

    // --- progress / completion ----------------------------------------

    private reportProgress(): void {
        const pending = Math.max(0, this.total - this.settled);
        this.sink.onProgress(pending, this.total);
        if (this.total > 0 && pending > 0) this.sink.onPhase('transferring');
    }

    private maybeFinish(): void {
        if (!this.localDone || !this.peerDone) return;
        if (this.queue.length > 0 || this.inFlight.size > 0) return;
        this.sink.onSynced(Date.now());
    }
}
