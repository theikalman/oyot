// The Yjs field a document's content lives in.
//
// The Collaboration extension binds the editor to it, the headless indexer
// reads it, and the tag rename edits it. All three have to name the same
// field: bound to one name and read under another, a document indexes as
// empty and a rename finds nothing to rename, both silently.
//
// Its own module rather than a constant in the editor, for the reason
// ./origin.ts is one: the sync layer needs it and must not pull in Tiptap to
// get it.
export const CONTENT_FIELD = 'content';
