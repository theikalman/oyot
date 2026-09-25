<script lang="ts">
    import { modIsCommand } from '$lib/editor/editorMode';
    import { SYNC_TONE_COLORS, syncBadge, type BadgeInputs } from '$lib/sync/syncBadge';
    import { isMobile } from '$lib/utils/platform';
    import {
        AROUND_WORDS,
        DIVIDER,
        INSERT_COMMANDS,
        LINE_STARTS,
        SHORTCUT_GROUPS,
        SYMBOLS,
    } from '$lib/help/shortcuts';
    import { HELP_KEYS } from '$lib/help/helpShortcut';
    import CalendarLegend from '$lib/help/CalendarLegend.svelte';
    import Keys from '$lib/help/Keys.svelte';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';

    // How to use Oyot, in one page: what its colours mean, every keyboard
    // shortcut, and what is worth knowing before it has to be found out.
    //
    // Whatever the app itself decides, the page asks the app rather than
    // repeating it: the calendar's days are drawn by the calendar's own
    // component, the sync states are named by the rule that names them on
    // the badge, and the keys are written by the function the tooltips use.
    // The shortcut list is held to the editor's bindings by its tests.

    // Whether Mod is Command here, as it is on Apple devices. Asked once, so
    // every key on the page is written for the keyboard in front of the user.
    const command = modIsCommand();

    // Each state the sync badge can be in, named the way the badge names it.
    const SYNC_STATES: { inputs: BadgeInputs; meaning: string }[] = [
        {
            inputs: { peers: 1, phase: 'synced', reachable: true },
            meaning: 'Connected to your other devices, and they all have everything.',
        },
        {
            inputs: { peers: 1, phase: 'transferring', reachable: true },
            meaning: 'Connected, and changes are still on their way between devices.',
        },
        {
            inputs: { peers: 1, phase: 'error', reachable: true },
            meaning: 'Connected, but something went wrong. Oyot keeps trying.',
        },
        {
            inputs: { peers: 0, phase: 'idle', reachable: true },
            meaning: 'Oyot is looking, but none of your paired devices is in reach right now.',
        },
        {
            inputs: { peers: 0, phase: 'idle', reachable: false },
            meaning:
                'This device has no way to look for your other devices right now, for example because it is not on a network.',
        },
    ];

    const syncStates = SYNC_STATES.map(({ inputs, meaning }) => ({
        ...syncBadge(inputs),
        meaning,
    }));

    const SECTIONS = [
        { id: 'basics', title: 'The basics' },
        { id: 'colors', title: 'Colors' },
        { id: 'shortcuts', title: 'Keyboard shortcuts' },
        { id: 'writing', title: 'Writing' },
        { id: 'finding', title: 'Finding things' },
        { id: 'data', title: 'Devices and data' },
        { id: 'tips', title: 'Good to know' },
    ];
</script>

<WorkspaceShell title="Help">
    <div class="help">
        <div class="help-body">
            <p class="lead">
                How Oyot works, what its colors mean, and every keyboard shortcut it has. Press
                <Keys keys={[HELP_KEYS]} {command} /> from anywhere to come back here.
            </p>

            <nav class="toc" aria-label="On this page">
                {#each SECTIONS as section (section.id)}
                    <a href="#{section.id}">{section.title}</a>
                {/each}
            </nav>

            <section id="basics" aria-labelledby="basics-title">
                <h2 id="basics-title">The basics</h2>
                <ul class="points">
                    <li>
                        <strong>Today's journal is waiting.</strong> Oyot opens on today's journal, so
                        there is nowhere to file anything before you start. Every day has its own journal,
                        named for its date.
                    </li>
                    <li>
                        <strong>Notes are for everything else.</strong> Start one with the + beside Pinned
                        notes in the sidebar, or with New note on the Notes page. A note you have just
                        made opens ready to write in.
                    </li>
                    <li>
                        <strong>Everything opens for reading.</strong> A stray tap cannot change a
                        note you are only reading. To write, press Edit, the pencil at the top
                        right, or <Keys keys={['Mod-Shift-e']} {command} />. Done, or the same keys,
                        goes back to reading. Tasks can still be ticked off while you read.
                    </li>
                    <li>
                        <strong>There is nothing to save.</strong> What you write is saved as you type.
                    </li>
                    <li>
                        <strong>Your notes stay yours.</strong> They are kept on this device and on the
                        devices you pair it with. There is no account, and no server in between.
                    </li>
                </ul>
            </section>

            <section id="colors" aria-labelledby="colors-title">
                <h2 id="colors-title">What the colors mean</h2>

                <h3>The calendar</h3>
                <p>
                    The calendar at the top of the sidebar shows a month at a time. Each day tells
                    you what its journal holds:
                </p>
                <CalendarLegend />
                <ul class="points">
                    <li>
                        Click any day to open its journal, which starts one if there is none yet.
                    </li>
                    <li>
                        The arrows move a month at a time. Today goes back to this month and opens
                        today's journal.
                    </li>
                    <li>
                        Opening a journal any other way, from search or the Journals page, moves the
                        calendar to its month.
                    </li>
                </ul>

                <h3>The sync indicator</h3>
                <p>
                    At the top right, a dot and a word say how this device is getting on with your
                    others. Click it to open the sync settings.
                </p>
                <ul class="states">
                    {#each syncStates as state (state.label)}
                        <li class="state">
                            <span class="state-badge">
                                <span
                                    class="status-dot"
                                    style="background-color: {SYNC_TONE_COLORS[state.tone]}"
                                ></span>
                                {state.label}
                            </span>
                            <span class="state-meaning">{state.meaning}</span>
                        </li>
                    {/each}
                </ul>

                <h3>Your devices</h3>
                <p>
                    Under Connected Devices in the sidebar, each device you have paired has a dot:
                    <span class="inline-dot online" aria-hidden="true"></span> green while it is
                    connected, and <span class="inline-dot" aria-hidden="true"></span> grey while it is
                    not. The words beside it say more, such as Syncing… or Offline. Its ⋮ menu has Reconnect,
                    to try reaching it straight away.
                </p>

                <h3>Links and tags</h3>
                <p>
                    In a note, a link to another note is a blue chip, such as
                    <span class="chip link">Reading list</span>. Click it to go there. If the note
                    it points to has been deleted, the chip turns grey and is crossed out:
                    <span class="chip link missing">Old plans</span>. A tag is a rounded grey chip,
                    such as <span class="chip tag">#home</span>.
                </p>
            </section>

            <section id="shortcuts" aria-labelledby="shortcuts-title">
                <h2 id="shortcuts-title">Keyboard shortcuts</h2>
                <p>
                    The keys are shown the way this device's keyboard labels them{#if command}: ⌘ is
                        Command, ⌥ is Option, and ⇧ is Shift{/if}.
                    {#if isMobile}On a phone or tablet, they need a keyboard attached.{/if}
                </p>

                <div class="groups">
                    {#each SHORTCUT_GROUPS as group (group.id)}
                        <div class="group">
                            <h3>{group.title}</h3>
                            <p class="where">{group.where}</p>
                            <table class="shortcut-table">
                                <tbody>
                                    {#each group.shortcuts as shortcut (shortcut.action)}
                                        <tr>
                                            <td class="action">{shortcut.action}</td>
                                            <td class="shortcut-keys">
                                                <Keys keys={shortcut.keys} {command} />
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    {/each}
                </div>

                <h3>Shortcuts you type</h3>
                <p>
                    While editing, some things you type turn into formatting as you go. If one
                    catches you out, press <Keys keys={['Backspace']} {command} /> straight after to undo
                    it.
                </p>

                <div class="typed">
                    <div class="typed-group">
                        <p class="where">At the start of a line, then a space</p>
                        <table class="shortcut-table">
                            <tbody>
                                {#each LINE_STARTS as item (item.typed)}
                                    <tr>
                                        <td class="typed-text"><code>{item.typed}</code></td>
                                        <td class="action">{item.becomes}</td>
                                    </tr>
                                {/each}
                                <tr>
                                    <td class="typed-text"><code>{DIVIDER.typed}</code></td>
                                    <td class="action">{DIVIDER.becomes}, no space needed</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="typed-group">
                        <p class="where">Around a few words</p>
                        <table class="shortcut-table">
                            <tbody>
                                {#each AROUND_WORDS as item (item.typed)}
                                    <tr>
                                        <td class="typed-text"><code>{item.typed}</code></td>
                                        <td class="action">{item.becomes}</td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>

                        <p class="where">Symbols</p>
                        <table class="shortcut-table">
                            <tbody>
                                {#each SYMBOLS as item (item.typed)}
                                    <tr>
                                        <td class="typed-text"><code>{item.typed}</code></td>
                                        <td class="action symbol">{item.becomes}</td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                        <p class="aside">
                            Straight quotes turn into curly ones, and two hyphens into a long dash.
                        </p>
                    </div>
                </div>
            </section>

            <section id="writing" aria-labelledby="writing-title">
                <h2 id="writing-title">Writing</h2>

                <h3>The insert menu</h3>
                <p>
                    While editing, type <Keys keys={['/']} {command} /> at the start of a line or after
                    a space, and pick what to insert:
                </p>
                <dl class="commands">
                    {#each INSERT_COMMANDS as item (item.id)}
                        <div class="command">
                            <dt>{item.label}</dt>
                            <dd>{item.does}</dd>
                        </div>
                    {/each}
                </dl>

                <ul class="points">
                    <li>
                        <strong>Images.</strong> Paste one, drag one in, or use Insert image on the toolbar.
                        PNG, JPEG, GIF and WebP work, up to 10 MB each. While editing, click an image
                        to resize it by its handles. Images go to your other devices along with the note.
                    </li>
                    <li>
                        <strong>Links between notes.</strong> A note that other notes link to lists them
                        under Linked from, at the bottom of the page.
                    </li>
                    <li>
                        <strong>Tags.</strong> Every tag is on the Tags page, with everything that carries
                        it. Renaming a tag there renames it in every note that has it.
                    </li>
                    <li>
                        <strong>Tasks.</strong> Every task still to do, in every note and journal, is
                        on the Todos page. Click one to open its note right at it, lit up for a moment
                        so it is easy to find.
                    </li>
                </ul>
            </section>

            <section id="finding" aria-labelledby="finding-title">
                <h2 id="finding-title">Finding things</h2>
                <ul class="points">
                    <li>
                        <strong>Search.</strong> The box at the top of the sidebar searches the words
                        in every note and journal, not just their titles.
                    </li>
                    <li>
                        <strong>Pinned notes.</strong> The sidebar lists only the notes you pin. Pin one
                        with the pin beside its title, or from the Notes page. A note started with the
                        + beside Pinned notes is pinned from the start.
                    </li>
                    <li>
                        <strong>The Index.</strong> Each page under Index in the sidebar lists one kind
                        of thing, with how many beside it. Beside Todos, that is the tasks still to do.
                    </li>
                    <li>
                        <strong>Notes</strong> lists every note, newest first. Its filter finds a note
                        by title or by tag; start with # to look at tags alone, so #home finds the notes
                        tagged home and not one called Homework.
                    </li>
                    <li>
                        <strong>Journals</strong> lists every day you have a journal for, newest first,
                        and can hide the days with nothing written.
                    </li>
                    <li>
                        <strong>Todos</strong> lists every task still to do, and can show the
                        finished ones too. <strong>Tags</strong> lists every tag.
                    </li>
                </ul>
            </section>

            <section id="data" aria-labelledby="data-title">
                <h2 id="data-title">Your devices and your data</h2>
                <ul class="points">
                    <li>
                        <strong>Syncing.</strong> Pair your devices in Settings, under Sync. On the same
                        network they find each other by themselves. A device somewhere else can be reached
                        at an address you give it, such as one from a VPN you already use. Notes go straight
                        from one device to the other, never through a server.
                    </li>
                    <li>
                        <strong>iPhone and iPad.</strong> They cannot find devices on their own network
                        yet, but they sync with any device you give them an address for.
                    </li>
                    <li>
                        <strong>Backups.</strong> Settings, under Backup, saves your whole library, images
                        included, to a file, or on a computer to Google Drive once you link an account.
                        Importing a backup merges it into what is already here and never removes a note.
                        On a computer, backups can also run by themselves, daily or weekly, while Oyot
                        is open.
                    </li>
                    <li>
                        <strong>Export.</strong> Settings, under Data, saves every note as a Markdown
                        file, with its images, in one zip.
                    </li>
                </ul>
            </section>

            <section id="tips" aria-labelledby="tips-title">
                <h2 id="tips-title">Good to know</h2>
                <ul class="points">
                    <li>
                        <strong>Dark mode.</strong> Settings, under Appearance, switches between light
                        and dark.
                    </li>
                    <li>
                        <strong>More room to write.</strong> The « beside the search box hides the sidebar,
                        and » at the bottom left brings it back. On a small screen the sidebar gets out
                        of the way by itself once you pick something.
                    </li>
                    <li>
                        <strong>Days with nothing in them.</strong> Clicking a day in the calendar starts
                        a journal for it even if you write nothing. The Journals page can hide those days.
                    </li>
                    <li>
                        <strong>Renaming, pinning and deleting.</strong> A note's ⋮ menu does all three.
                        Deleting cannot be undone, and deletes the note on your paired devices too.
                    </li>
                    <li>
                        <strong>What's new.</strong> The version number at the bottom of the sidebar opens
                        the changes in each release.
                    </li>
                </ul>
            </section>
        </div>
    </div>
</WorkspaceShell>

<style>
    .help {
        flex: 1;
        overflow-y: auto;
        padding: 16px 24px 48px;
    }

    .help-body {
        max-width: 720px;
        color: var(--text-primary);
        font-size: 14px;
        line-height: 1.6;
    }

    .lead {
        margin: 0 0 12px;
        font-size: 15px;
        color: var(--text-secondary);
    }

    .toc {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
    }

    .toc a {
        padding: 4px 10px;
        border: 1px solid var(--border-light);
        border-radius: 14px;
        color: var(--text-secondary);
        font-size: 13px;
        text-decoration: none;
    }

    .toc a:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    section {
        padding-top: 16px;
        scroll-margin-top: 8px;
    }

    h2 {
        margin: 16px 0 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border-color);
        font-size: 18px;
        font-weight: 600;
    }

    h3 {
        margin: 20px 0 6px;
        font-size: 15px;
        font-weight: 600;
    }

    p {
        margin: 0 0 10px;
    }

    .points {
        margin: 10px 0;
        padding-left: 20px;
    }

    .points li {
        margin: 6px 0;
    }

    .points li::marker {
        color: var(--text-muted);
    }

    /* ── Sync states ── */
    .states {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .state {
        display: flex;
        align-items: baseline;
        gap: 12px;
        padding: 6px 0;
    }

    /* Drawn the way the badge itself is. */
    .state-badge {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        width: 116px;
        padding: 4px 10px;
        border: 1px solid var(--border-light);
        border-radius: 16px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
    }

    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .state-meaning {
        color: var(--text-secondary);
    }

    /* The sidebar's device dot, green while connected. */
    .inline-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        margin: 0 2px;
        border-radius: 50%;
        background: var(--text-muted);
        vertical-align: 1px;
    }

    .inline-dot.online {
        background: var(--status-ok, #22c55e);
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
    }

    /* The editor's link and tag chips, for the look of them. */
    .chip {
        display: inline-block;
        padding: 0 8px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 500;
        line-height: 1.6;
        white-space: nowrap;
    }

    .chip.link {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .chip.link.missing {
        background: var(--bg-hover);
        color: var(--text-muted);
        text-decoration: line-through;
    }

    .chip.tag {
        border: 1px solid var(--border-light);
        border-radius: 10px;
        background: var(--bg-hover);
        color: var(--text-secondary);
    }

    /* ── Shortcut tables ── */
    /* Columns rather than a grid, so a group of one row does not leave a
       hole beside a group of ten. */
    .groups {
        column-width: 300px;
        column-gap: 32px;
    }

    /* Spaced by padding, not the heading's margin: a margin at the top of a
       column is dropped, which would leave the columns' first headings at
       different heights. */
    .group {
        break-inside: avoid;
        padding: 12px 0 8px;
    }

    .group h3 {
        margin: 0;
    }

    /* Secondary rather than muted grey: it says where the keys work, so it
       has to be read, and muted text is under 3:1 in both themes. */
    .where {
        margin: 2px 0 6px;
        font-size: 12px;
        color: var(--text-secondary);
    }

    .shortcut-table {
        width: 100%;
        border-collapse: collapse;
    }

    .shortcut-table td {
        padding: 5px 0;
        border-bottom: 1px solid var(--border-color);
        vertical-align: middle;
    }

    .shortcut-table tr:last-child td {
        border-bottom: none;
    }

    .action {
        padding-right: 12px;
        color: var(--text-primary);
    }

    .shortcut-keys {
        text-align: right;
    }

    .typed {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 4px 32px;
    }

    .typed-group .where {
        margin-top: 12px;
    }

    .typed-text {
        width: 96px;
    }

    code {
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--code-bg);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        white-space: pre;
    }

    .symbol {
        font-size: 16px;
    }

    .aside {
        margin-top: 8px;
        font-size: 13px;
        color: var(--text-secondary);
    }

    /* ── The insert menu ── */
    .commands {
        margin: 0 0 12px;
    }

    .command {
        display: flex;
        gap: 12px;
        padding: 6px 0;
        border-bottom: 1px solid var(--border-color);
    }

    .command:last-child {
        border-bottom: none;
    }

    .command dt {
        flex-shrink: 0;
        width: 116px;
        font-weight: 500;
    }

    .command dd {
        margin: 0;
        color: var(--text-secondary);
    }

    /* On a phone, the words under the thing they describe rather than beside
       it, which would leave each a narrow column. */
    @media (max-width: 640px) {
        .help {
            padding: 12px 16px 40px;
        }

        .state,
        .command {
            flex-direction: column;
            gap: 4px;
        }
    }
</style>
