// A node's JSON as a test writes it, with the blocks nobody indented written
// the short way. Every paragraph and heading carries an indent, null until
// it is moved in (ADR 0040), so a document's own JSON says `indent: null` on
// each of them, which says nothing a test means to check. An indented block
// keeps its indent.

import type { Node } from '@tiptap/pm/model';

type Json = { attrs?: Record<string, unknown>; content?: Json[]; [key: string]: unknown };
// Typed as ProseMirror types a node's own JSON, so a test reads into it as
// freely as it did before.
type NodeJson = ReturnType<Node['toJSON']>;

function withoutUnsetIndent(json: Json): Json {
    const out: Json = { ...json };
    if (out.attrs && out.attrs.indent === null) {
        const { indent: _, ...rest } = out.attrs;
        if (Object.keys(rest).length > 0) out.attrs = rest;
        else delete out.attrs;
    }
    if (out.content) out.content = out.content.map(withoutUnsetIndent);
    return out;
}

/** `node`'s JSON, without an indent on the blocks that have none. */
export function jsonOf(node: Node): NodeJson {
    return withoutUnsetIndent(node.toJSON());
}

/** The JSON of `node`'s children, as `jsonOf` writes them. */
export function blocksOf(node: Node): NodeJson {
    return jsonOf(node).content;
}
