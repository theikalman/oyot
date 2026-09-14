// Marks a Yjs transaction as "not something the user just typed".
//
// The editor's update listener rebroadcasts every update it sees except these,
// so anything applied programmatically -- a peer's edit merged in by the sync
// layer, or a snapshot folded back into the live document on save -- has to
// carry this origin or it would be echoed straight back to the peer that sent
// it.
//
// It lives in its own module rather than in `yjs.ts` so the sync layer can
// import it without pulling in Tiptap.
export const REMOTE_ORIGIN = 'oyot:remote';
