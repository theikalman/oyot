/* eslint-disable @typescript-eslint/no-explicit-any */

interface LoroContainer {
    toString(): string;
    insert(index: number, value: string): void;
    delete(index: number, len: number): void;
    length: number;
    get(index: number): any;
}

interface LoroDocInterface {
    free(): void;
    getText(cid: string): LoroContainer;
    getList(cid: string): LoroContainer;
    fromSnapshot(snapshot: Uint8Array): any;
    import(data: Uint8Array): void;
    export(mode: { mode: 'update' } | { mode: 'snapshot' }): Uint8Array;
    exportFrom(version: any): Uint8Array;
    exportSnapshot(): Uint8Array;
    oplogVersion(): any;
    subscribe(f: (event: any) => void): void;
}

export interface DocumentMetadata {
    title: string;
    todo_count: number;
    completed_todo_count: number;
}

let LoroDocClass: any = null;

async function getLoroDocClass(): Promise<any> {
    if (!LoroDocClass) {
        const module = await import('loro-wasm');
        LoroDocClass = module.LoroDoc;
    }
    return LoroDocClass;
}

export class LoroApp {
    private doc: LoroDocInterface | null = null;
    private isInitialized: boolean = false;

    async init(): Promise<void> {
        if (this.isInitialized) return;
        const Loro = await getLoroDocClass();
        this.doc = new Loro();
        this.isInitialized = true;
    }

    loadDocument(crdtState: Uint8Array): void {
        if (!this.doc || crdtState.length === 0) {
            return;
        }
        const loaded = LoroDocClass.fromSnapshot(crdtState);
        this.doc.free();
        this.doc = loaded;
    }

    applyUpdate(update: Uint8Array): void {
        if (!this.doc || update.length === 0) return;
        this.doc.import(update);
    }

    getUpdate(): Uint8Array {
        if (!this.doc) return new Uint8Array();
        return this.doc.export({ mode: 'update' });
    }

    getUpdatesSince(version: Uint8Array): Uint8Array {
        if (!this.doc) return new Uint8Array();
        if (version.length === 0) {
            return this.getUpdate();
        }
        return this.doc.exportFrom(version);
    }

    getStateVector(): Uint8Array {
        if (!this.doc) return new Uint8Array();
        const vv = this.doc.oplogVersion();
        return vv.encode();
    }

    exportSnapshot(): Uint8Array {
        if (!this.doc) return new Uint8Array();
        return this.doc.exportSnapshot();
    }

    getText(container: string): LoroContainer {
        if (!this.doc) return { toString: () => '', insert: () => {}, delete: () => {}, length: 0, get: () => null } as unknown as LoroContainer;
        return this.doc.getText(container) as unknown as LoroContainer;
    }

    getTextAsString(container: string): string {
        const text = this.getText(container);
        return text.toString();
    }

    getJsonContent(): string {
        const content = this.getTextAsString('content');
        try {
            const parsed = JSON.parse(content);
            return JSON.stringify({
                type: 'doc',
                content: parsed.content || []
            });
        } catch {
            return JSON.stringify({
                type: 'doc',
                content: []
            });
        }
    }

    getMetadata(): DocumentMetadata {
        const title = this.getTextAsString('title');
        const todoCount = this.countTodos();
        const completedCount = this.countCompletedTodos();

        return {
            title: title || 'Untitled',
            todo_count: todoCount,
            completed_todo_count: completedCount
        };
    }

    private countTodos(): number {
        if (!this.doc) return 0;
        const list = this.doc.getList('todos');
        return list.length;
    }

    private countCompletedTodos(): number {
        if (!this.doc) return 0;
        const list = this.doc.getList('todos');
        let count = 0;
        for (let i = 0; i < list.length; i++) {
            const item = list.get(i);
            if (item && typeof item === 'object' && 'map' in item) {
                const map = item.map as Record<string, unknown>;
                if (map.done === true) {
                    count++;
                }
            }
        }
        return count;
    }

    setTitle(title: string): void {
        if (!this.doc) return;
        const text = this.doc.getText('title');
        const len = text.toString().length;
        if (len > 0) {
            text.delete(0, len);
        }
        text.insert(0, title);
    }

    subscribe(callback: (event: any) => void): void {
        if (!this.doc) return;
        this.doc.subscribe(callback);
    }

    destroy(): void {
        if (this.doc) {
            this.doc.free();
            this.doc = null;
        }
        this.isInitialized = false;
    }
}

export function bytesToJson(data: number[] | Uint8Array): string {
    return new TextDecoder().decode(new Uint8Array(data));
}

export function jsonToBytes(json: string): Uint8Array {
    return new TextEncoder().encode(json);
}