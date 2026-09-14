// Release notes shown in the About dialog. Newest release first: the first
// entry is the one the app is currently running, and version.test.ts checks it
// against package.json.
//
// When you bump the version, add an entry here in the same commit.

export type ChangeKind = 'added' | 'improved' | 'fixed' | 'security';

export interface Change {
    kind: ChangeKind;
    /** One user-facing sentence. Describe the effect, not the commit. */
    text: string;
}

export interface Release {
    /** Must match package.json, tauri.conf.json and Cargo.toml for the newest release. */
    version: string;
    /** Release date, ISO `YYYY-MM-DD`. */
    date: string;
    /** A line or two on what this release is about. */
    summary: string;
    changes: Change[];
}

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
    added: 'New',
    improved: 'Improved',
    fixed: 'Fixed',
    security: 'Security',
};

export const RELEASES: Release[] = [
    {
        version: '0.0.9-alpha',
        date: '2026-09-14',
        summary:
            'Search that reaches into what you wrote, signed device pairing, and a sync path that only sends what changed.',
        changes: [
            {
                kind: 'added',
                text: 'Search looks inside note bodies and journals, not just titles.',
            },
            {
                kind: 'added',
                text: 'Every note lists the notes that link back to it.',
            },
            {
                kind: 'added',
                text: 'Todo counts and document links are derived as you type.',
            },
            {
                kind: 'added',
                text: 'You can give this device a name of your own in sync settings.',
            },
            {
                kind: 'added',
                text: 'The sidebar starts collapsed on phones and small tablets.',
            },
            {
                kind: 'security',
                text: 'Signaling messages are signed and verified, and device identity is now derived from a key pair rather than a claimed name.',
            },
            {
                kind: 'security',
                text: 'Pairing validates device IDs before it accepts them.',
            },
            {
                kind: 'security',
                text: 'The editor no longer has filesystem access, and SVG attachments are rejected.',
            },
            {
                kind: 'improved',
                text: 'Sync sends only what changed instead of the whole document, and saving no longer reloads the document you are editing.',
            },
            {
                kind: 'fixed',
                text: 'Switching documents no longer drops the last edit.',
            },
            {
                kind: 'fixed',
                text: 'Reopening a deleted journal date revives it instead of failing.',
            },
            {
                kind: 'fixed',
                text: 'The broker address field keeps what you type.',
            },
            {
                kind: 'fixed',
                text: 'Attachment transfers retry properly and stalled transfers no longer block later ones.',
            },
            {
                kind: 'fixed',
                text: 'Android builds start correctly again and ship their debug symbols.',
            },
        ],
    },
    {
        version: '0.0.8-alpha',
        date: '2026-08-29',
        summary:
            'Images travel between your devices, and reconnecting is something you can ask for.',
        changes: [
            {
                kind: 'added',
                text: 'Image attachments transfer between paired devices.',
            },
            {
                kind: 'added',
                text: 'Paired devices have a manual "Reconnect" action.',
            },
            {
                kind: 'fixed',
                text: 'A forced reconnect now actually reconnects.',
            },
            {
                kind: 'fixed',
                text: 'Sync no longer stalls when one side has nothing to send back.',
            },
            {
                kind: 'improved',
                text: 'The sync handshake was simplified, so connecting takes one round trip less.',
            },
        ],
    },
    {
        version: '0.0.5-alpha',
        date: '2026-08-29',
        summary: 'The first alphas: notes, journals, and peer-to-peer sync.',
        changes: [
            {
                kind: 'added',
                text: 'Notes and dated journal entries in a rich-text editor with slash commands.',
            },
            {
                kind: 'added',
                text: 'Peer-to-peer sync between paired devices over WebRTC, with MQTT only for finding each other.',
            },
            {
                kind: 'added',
                text: 'The whole document set is reconciled every time devices connect.',
            },
            {
                kind: 'added',
                text: 'Paired devices reconnect on their own after a drop.',
            },
        ],
    },
];
