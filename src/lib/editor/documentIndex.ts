import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

// What SQL needs to know about a document that only the editor can see.
//
// Content lives in the CRDT, not in queryable columns, so anything that wants
// to search it, count its todos, or follow its links has to be told. One walk
// of the ProseMirror document on save feeds all three: previously `todo_count`
// was hard-coded to 0, `get_backlinks` had no edge table to consult, and search
// could only match titles.
export interface DocumentIndex {
    /** Plain text, for full-text search. */
    text: string;
    /** Ids of documents this one links to, deduplicated. */
    linkTargets: string[];
    todoCount: number;
    completedTodoCount: number;
}

export function extractDocumentIndex(doc: ProseMirrorNode): DocumentIndex {
    const parts: string[] = [];
    const linkTargets = new Set<string>();
    let todoCount = 0;
    let completedTodoCount = 0;

    doc.descendants((node) => {
        if (node.isText && node.text) {
            parts.push(node.text);
            return true;
        }

        switch (node.type.name) {
            case 'documentLink': {
                const target = node.attrs.targetId;
                if (typeof target === 'string' && target) linkTargets.add(target);
                // The link's own title is worth matching on: it is how the user
                // refers to the other document from inside this one.
                if (typeof node.attrs.title === 'string' && node.attrs.title) {
                    parts.push(node.attrs.title);
                }
                return false; // atom, nothing inside to walk
            }
            case 'taskItem': {
                todoCount++;
                if (node.attrs.checked === true) completedTodoCount++;
                return true;
            }
            case 'image': {
                // Alt text carries the attachment hash, which is noise in a
                // search index.
                return false;
            }
            default:
                return true;
        }
    });

    // Block boundaries are lost by the walk above, so join on a space: FTS
    // tokenises on whitespace, and gluing the last word of one paragraph to the
    // first of the next would make both unmatchable.
    return {
        text: parts.join(' ').replace(/\s+/g, ' ').trim(),
        linkTargets: [...linkTargets],
        todoCount,
        completedTodoCount,
    };
}
