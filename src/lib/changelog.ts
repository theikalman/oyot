// Release notes shown in the About dialog. Newest release first: the first
// entry is the one the app is currently running, and version.test.ts checks it
// against package.json.
//
// When you bump the version, add an entry here in the same commit.

// 'removed' was added for 0.0.17-alpha. Taking a feature away under
// "Improved" would be the changelog telling the user what we want them to
// think rather than what happened, and a release whose headline is a removal
// needs somewhere honest to put it.
export type ChangeKind = 'added' | 'improved' | 'fixed' | 'security' | 'removed';

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
    removed: 'Removed',
};

export const RELEASES: Release[] = [
    {
        version: '0.0.20-alpha',
        date: '2026-09-24',
        summary:
            'The sidebar keeps only the notes you pin, and every note is on a new Notes page. Notes and journals open for reading, with Edit one press away.',
        changes: [
            {
                kind: 'added',
                text: 'The sidebar lists only the notes you pin, under Pinned notes, instead of every note. Nothing is pinned when you first update, so the list starts empty, but no note has gone anywhere: every one is on the new Notes page, under Index. Pin a note with the pin beside its title while it is open, or from the Notes page. A note started with the + beside Pinned notes is pinned from the start, which the dialog shows as a "Pin to the sidebar" box you can untick.',
            },
            {
                kind: 'added',
                text: 'Notes, under Index in the sidebar, lists every note, newest first, with its tags and what is still open on it. The filter finds a note by its title or by one of its tags, and starting with # looks at tags alone, so "#home" finds the notes tagged home and not one titled "Homework". Each row can pin, rename or delete its note, and the page has its own New note button.',
            },
            {
                kind: 'added',
                text: 'Pinning or unpinning a note on one device does the same on your paired devices, once they are all on this version, so the sidebar is the same on each. A backup keeps which notes are pinned, and importing it brings the pins back.',
            },
            {
                kind: 'added',
                text: 'Notes and journals now open for reading, however you reach them, so on a phone the tap that scrolls a note no longer puts the caret in it and brings the keyboard up. Press Edit, beside the sync indicator, to change one, and Done to go back to reading; on a phone the button is just a pencil, and a tick while editing. The keyboard shortcut is ⇧⌘E on Apple devices and Ctrl+Shift+E elsewhere. Editing lasts until you leave: opening anything else, or coming back, starts reading again.',
            },
            {
                kind: 'added',
                text: 'A note you have just made is the one exception, and opens ready to write in, with the caret already in it. Tasks can be ticked off, or unticked, while you are reading, without pressing Edit first.',
            },
            {
                kind: 'improved',
                text: "The editor toolbar is one set of icons instead of a row of boxed letters and symbols. A tool shows pressed while the text at the caret already has it, so you can see whether Bold will bold or unbold before you press it, and the same goes for headings, lists, quotes and code. Undo and Redo grey out when there is nothing to undo or redo, and each tooltip names the tool's keyboard shortcut, where it has one.",
            },
            {
                kind: 'improved',
                text: 'On a touch screen every toolbar button is a finger-sized target, and the buttons meet, so a tap between two of them no longer lands on nothing. When the toolbar is wider than the screen, only the formatting tools scroll: Undo and Redo stay at the end of the row, and the row fades at an edge with more tools beyond it.',
            },
            {
                kind: 'fixed',
                text: 'Pressing a toolbar button keeps the caret in the note. The selection used to blink away for a moment, and on a phone the keyboard could drop and come back up between one tool and the next.',
            },
            {
                kind: 'fixed',
                text: 'The ⋮ button that opens the menu on a note or a device in the sidebar is always shown. It used to appear only under a mouse pointer, so on a phone or tablet those menus could not be found. On a touch screen it is sized for a finger too, so a tap just beside it no longer opens the note instead.',
            },
            {
                kind: 'fixed',
                text: 'Deleting the note on screen, here or on another device, no longer reports "Failed to load document". The delete had worked; the app was going back for the note it had just removed.',
            },
            {
                kind: 'fixed',
                text: 'The "Linked from" bar under a note keeps its links on one row, scrolling sideways when they do not fit, and lines up with the foot of the sidebar beside it.',
            },
        ],
    },
    {
        version: '0.0.19-alpha',
        date: '2026-09-24',
        summary:
            'Back up your whole library and bring it back: to a file you keep, to Google Drive, or on its own every day or week.',
        changes: [
            {
                kind: 'added',
                text: 'Settings, Backup saves every note, journal and image to one file wherever you choose, and imports one back. An import adds to what is already here and never removes a note, so it is safe to run on a device you are still using. You see what it will bring in before anything changes.',
            },
            {
                kind: 'added',
                text: 'Backups can go to Google Drive. Link your Google account once, then back up, restore or delete backups from Settings. Oyot can only see the files it puts there, in an "Oyot Backups" folder you can see too. Unlinking one device leaves your other devices linked.',
            },
            {
                kind: 'added',
                text: 'Backups can run on their own, every day or every week, to Google Drive or, on a computer, to a folder you pick. They run while Oyot is open, and one that was missed runs a few minutes after Oyot next opens. When nothing has changed, no new backup is made. The newest scheduled backups are kept, 10 unless you choose otherwise, and backups you make yourself are never removed.',
            },
            {
                kind: 'added',
                text: 'The Backup page shows when the last backup was made, when the next one is due, and what a backup had to leave out. If scheduled backups keep failing or have stopped, Oyot says so when it opens.',
            },
        ],
    },
    {
        version: '0.0.18-alpha',
        date: '2026-09-23',
        summary:
            'Devices that are not on the same network can sync again, over a VPN you already run, and on phones and tablets the app no longer sits under the status bar.',
        changes: [
            {
                kind: 'added',
                text: 'A device somewhere else can be reached at an address you give it, such as its address on a VPN like Tailscale. When pairing, choose "Somewhere else" and enter its ID and address once; add the address on both devices. Being on the same VPN does not let anyone in on its own: a device still has to be paired, and every message is still signed and checked.',
            },
            {
                kind: 'added',
                text: 'Each paired device lists the addresses it is reached at on its own row, with whether each one has answered. A device that is off and an address that is wrong no longer look the same, and "Check now" asks straight away instead of waiting for the next retry.',
            },
            {
                kind: 'fixed',
                text: "On Android phones and tablets, a note's title and the top of every screen were drawn underneath the status bar. They now start below it, and the sidebar, toasts and dialogs keep clear of the gesture bar at the bottom too.",
            },
        ],
    },
    {
        version: '0.0.17-alpha',
        date: '2026-09-22',
        summary:
            'Oyot now syncs only between devices on the same network. The broker is gone, and with it the server you had to run, secure and keep running for your notes to reach your other devices.',
        changes: [
            {
                kind: 'removed',
                text: 'Devices that are not on the same network no longer sync. A phone on mobile data and a laptop at home reconcile again the moment they are both on one wifi, and until then the other device simply reads as offline rather than pretending to be reachable.',
            },
            {
                kind: 'removed',
                text: 'Settings > Sync no longer has a broker address, username or password, and no longer asks you to choose between Automatic and Local network only. There is one way devices connect now, so there is nothing to configure: open Oyot on two devices on the same wifi and pair them.',
            },
            {
                kind: 'removed',
                text: 'iPhone and iPad do not sync in this release. They could only ever reach other devices through the broker, because finding devices on a local network needs an Apple permission the app does not have yet. Your notes on those devices are untouched, and nothing is lost; they just stop receiving from your other devices until that lands.',
            },
            {
                kind: 'security',
                text: 'Nothing outside your own devices can see when they pair, or which devices they pair with. Keeping that true with a broker meant writing a rule and a password into the broker for every single device, by hand; anyone else on that broker could watch if you got it wrong. Note content was always encrypted between the two devices and still is.',
            },
            {
                kind: 'improved',
                text: 'When a device cannot be paired with, the message says which of the two problems it is: this device is not searching the network yet, usually a firewall prompt waiting to be answered, or the other device has not appeared on the network.',
            },
            {
                kind: 'improved',
                text: 'The sync indicator can no longer read "Sync error" for a reason that has nothing to do with your devices, because the broker it used to complain about does not exist.',
            },
        ],
    },
    {
        version: '0.0.16-alpha',
        date: '2026-09-22',
        summary:
            'Tags: a way to say what a note is about that cuts across titles and links, with a page for every tag. Plus an index of every journal day, and an export of the whole corpus as Markdown.',
        changes: [
            {
                kind: 'added',
                text: 'Type /tag in a note to put a tag on it. The picker lists the tags you already use, most used first, and offers to create a new one. A tag is one chip in the line rather than loose text, so backspace takes the whole of it.',
            },
            {
                kind: 'added',
                text: 'Tags joins Todos under Index in the sidebar. It lists every tag in the corpus with how many notes carry it, and opening one shows the journals and notes that mention it. A tag is a link, so it survives a reload and the back button undoes it.',
            },
            {
                kind: 'added',
                text: 'A tag can be renamed everywhere it appears, including in notes that are not open. Renaming onto a tag that already exists merges the two, and the dialog says so, and says what will actually be stored, before it happens.',
            },
            {
                kind: 'added',
                text: "Journals under Index lists every day there is a journal for, newest first and gathered under its month, with the weekday, that day's tags and what is still open on it. Days with nothing written can be hidden.",
            },
            {
                kind: 'added',
                text: 'Settings > Data writes every note out as its own Markdown file, with the images they embed, in one zip you pick the location for. An image whose bytes have not reached this device is noted in a warning rather than linked to a file the archive does not contain.',
            },
            {
                kind: 'improved',
                text: 'The Todos page opens with completed items hidden. It is there to show what is still to do, and unticking the box brings the full history back.',
            },
            {
                kind: 'improved',
                text: 'The sidebar shows how many tags there are, the way it already showed how many todos.',
            },
            {
                kind: 'improved',
                text: 'The journal index says what its numbers count. "2 open" now reads "2 open todos" and the line above the list reads "7 days with a journal, 5 written in", rather than leaving a column of bare numbers to be worked out.',
            },
        ],
    },
    {
        version: '0.0.15-alpha',
        date: '2026-09-15',
        summary:
            'Sync over the local network, with no internet and no broker in the middle. iPhone and iPad still go through a broker.',
        changes: [
            {
                kind: 'added',
                text: 'Devices on the same network find each other and sync directly, with no internet connection and no broker. Pairing works there too, so two devices can be introduced with nothing but the network they are both on.',
            },
            {
                kind: 'added',
                text: 'Settings > Sync can be set to use the local network only, in which case the app never contacts a broker at all and devices elsewhere stop syncing until they are back on your network.',
            },
            {
                kind: 'improved',
                text: 'A paired device now says whether it was reached over the local network or through the broker.',
            },
            {
                kind: 'improved',
                text: 'Losing the broker no longer stops the app trying to reconnect. Anything it can still reach, it still reaches.',
            },
            {
                kind: 'fixed',
                text: 'The Node ID box on the pairing screen keeps what you type or scan into it. It was clearing itself as you typed, which left no way to pair from that screen at all.',
            },
            {
                kind: 'fixed',
                text: 'Notes list the notes that link to them again. The query behind that list was not valid and failed on every note, so the list was always empty.',
            },
            {
                kind: 'fixed',
                text: 'The sync indicator no longer reads "Sync error" while your devices are syncing happily over the local network. It was reporting an unreachable broker as a fault even when nothing needed one.',
            },
            {
                kind: 'fixed',
                text: 'Two devices on one network reconnect after one of them is closed and reopened. A local connection that failed once was set aside for a minute, and with no broker to fall back to there was nothing left to try, so both devices sat on "Connecting..." indefinitely.',
            },
            {
                kind: 'fixed',
                text: 'Pairing waits for the other device to be found on the network rather than failing the moment you paste an ID, and when it cannot find it, it says whether nothing was on the network, or the broker was not connected.',
            },
            {
                kind: 'fixed',
                text: 'Choosing a note from the /document list inserts a link to it. Clicking one did nothing at all, and never had.',
            },
            {
                kind: 'fixed',
                text: 'The todo page shows the note a task links to as part of the task. "Ask [Groceries] about milk" was listed as "Ask about milk", and a task that was nothing but a link was listed as an empty row. Tasks already written correct themselves on the next launch.',
            },
        ],
    },
    {
        version: '0.0.10-alpha',
        date: '2026-09-14',
        summary: 'The editor toolbar stays on one row and scrolls sideways on small screens.',
        changes: [
            {
                kind: 'improved',
                text: 'On phones and tablets the editor toolbar scrolls sideways with a swipe instead of stacking into several rows and eating the space you write in.',
            },
        ],
    },
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
