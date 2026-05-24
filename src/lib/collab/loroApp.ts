import * as Y from 'yjs';

export interface DocumentMetadata {
    title: string;
    todo_count: number;
    completed_todo_count: number;
}

export class LoroApp {
    private doc: Y.Doc | null = null;
    private isInitialized: boolean = false;

    async init(): Promise<void> {
        if (this.isInitialized) return;
        this.doc = new Y.Doc();
        this.isInitialized = true;
    }

    loadDocument(crdtState: Uint8Array): void {
        if (!this.doc || crdtState.length === 0) return;
        Y.applyUpdate(this.doc, crdtState);
    }

    applyUpdate(update: Uint8Array): void {
        if (!this.doc || update.length === 0) return;
        Y.applyUpdate(this.doc, update);
    }

    getUpdate(): Uint8Array {
        if (!this.doc) return new Uint8Array();
        return Y.encodeStateAsUpdate(this.doc);
    }

    getUpdatesSince(version: Uint8Array): Uint8Array {
        if (!this.doc) return new Uint8Array();
        if (version.length === 0) return this.getUpdate();
        return Y.encodeStateAsUpdate(this.doc, version);
    }

    getStateVector(): Uint8Array {
        if (!this.doc) return new Uint8Array();
        return Y.encodeStateVector(this.doc);
    }

    exportSnapshot(): Uint8Array {
        if (!this.doc) return new Uint8Array();
        return Y.encodeStateAsUpdate(this.doc);
    }

    getText(container: string): Y.Text {
        if (!this.doc) {
            return new Y.Doc().getText(container);
        }
        return this.doc.getText(container);
    }

    getTextAsString(container: string): string {
        return this.getText(container).toString();
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
        return this.doc.getArray('todos').length;
    }

    private countCompletedTodos(): number {
        if (!this.doc) return 0;
        const list = this.doc.getArray<Y.Map<unknown>>('todos');
        let count = 0;
        for (let i = 0; i < list.length; i++) {
            const item = list.get(i);
            if (item instanceof Y.Map && item.get('done') === true) {
                count++;
            }
        }
        return count;
    }

    setTitle(title: string): void {
        if (!this.doc) return;
        const text = this.doc.getText('title');
        const len = text.length;
        if (len > 0) {
            text.delete(0, len);
        }
        text.insert(0, title);
    }

    subscribe(callback: (update: Uint8Array) => void): void {
        if (!this.doc) return;
        this.doc.on('update', callback);
    }

    destroy(): void {
        if (this.doc) {
            this.doc.destroy();
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
