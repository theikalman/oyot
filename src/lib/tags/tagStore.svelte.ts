import { loadAllTags, loadDocumentsForTag } from '$lib/services/tags';
import type { TagSummary } from '$lib/tiptap/tags';
import type { DocumentSummary } from '$lib/types';

/**
 * The state behind the tag index page.
 *
 * Its own module for the reason the todo index's is: a sequence number and two
 * flags that have to stay in step, which they do not reliably do as loose
 * variables inside a component that is also doing layout.
 */
export function createTagIndex() {
    let tags = $state<TagSummary[]>([]);
    // Starts true: the first render is before the first query has answered, and
    // saying "no tags yet" there is a lie the user sees every time they open
    // the page.
    let loading = $state(true);
    // A failed load must not render as an empty list, which reads as an answer
    // when it is the absence of one.
    let failed = $state(false);

    let seq = 0;

    async function load(): Promise<void> {
        const mine = ++seq;
        loading = true;
        try {
            const rows = await loadAllTags();
            // Drop a response something newer has already superseded. Edits
            // arrive while this is in flight, and each one triggers a reload.
            if (mine !== seq) return;
            tags = rows;
            failed = false;
        } catch (err) {
            if (mine !== seq) return;
            console.error('[tags] failed to load the index:', err);
            tags = [];
            failed = true;
        } finally {
            if (mine === seq) loading = false;
        }
    }

    return {
        get tags() {
            return tags;
        },
        get loading() {
            return loading;
        },
        get failed() {
            return failed;
        },
        get isEmpty() {
            return tags.length === 0;
        },
        load,
    };
}

export type TagIndex = ReturnType<typeof createTagIndex>;

/**
 * The state behind one tag's page: the documents that mention it.
 *
 * Separate from the index above rather than a mode of it. They answer different
 * questions, they reload on different things, and a single store would have to
 * hold a tag name that is only meaningful half the time.
 */
export function createTaggedDocuments() {
    let documents = $state<DocumentSummary[]>([]);
    let loading = $state(true);
    let failed = $state(false);

    let seq = 0;

    async function load(name: string): Promise<void> {
        const mine = ++seq;
        loading = true;
        try {
            const rows = await loadDocumentsForTag(name);
            if (mine !== seq) return;
            documents = rows;
            failed = false;
        } catch (err) {
            if (mine !== seq) return;
            console.error(`[tags] failed to load the notes for #${name}:`, err);
            documents = [];
            failed = true;
        } finally {
            if (mine === seq) loading = false;
        }
    }

    return {
        get documents() {
            return documents;
        },
        get journals() {
            return documents.filter((doc) => doc.doc_type === 'journal');
        },
        get notes() {
            return documents.filter((doc) => doc.doc_type !== 'journal');
        },
        get loading() {
            return loading;
        },
        get failed() {
            return failed;
        },
        get isEmpty() {
            return documents.length === 0;
        },
        load,
    };
}

export type TaggedDocuments = ReturnType<typeof createTaggedDocuments>;
