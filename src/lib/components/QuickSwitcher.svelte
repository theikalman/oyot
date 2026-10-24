<script lang="ts">
    import { tick } from 'svelte';
    import { goto } from '$app/navigation';
    import { documents } from '$lib/stores/app';
    import { openDocument, openTag } from '$lib/services/navigation';
    import { openJournal } from '$lib/services/journals';
    import { createNote } from '$lib/services/documentActions';
    import { loadAllTags } from '$lib/services/tags';
    import { openNextForEditing } from '$lib/editor/editorMode';
    import { journalTitleFor, longJournalTitle } from '$lib/calendar/calendar';
    import { switcher } from '$lib/switcher/switcher.svelte';
    import { highlight, rank } from '$lib/switcher/rank';
    import { toasts } from '$lib/services/toast';
    import type { TagSummary } from '$lib/tiptap/tags';
    import Icon, { type IconName } from './Icon.svelte';

    // Jump anywhere by typing: a note or a journal by its title, a tag, or a
    // place in the app, with a way to make a note of the words or search
    // everything for them. Opened from anywhere by its keys (Ctrl K) or the
    // search box at the top of the sidebar.

    interface Item {
        key: string;
        group: 'Notes' | 'Journals' | 'Tags' | 'Go to' | 'Actions';
        icon: IconName;
        title: string;
        detail?: string;
        run: () => void | Promise<void>;
    }

    const PLACES: { title: string; path: string; icon: IconName }[] = [
        { title: 'Journals', path: '/journals', icon: 'journals' },
        { title: 'Notes', path: '/notes', icon: 'notes' },
        { title: 'Todos', path: '/todos', icon: 'todos' },
        { title: 'Tags', path: '/tags', icon: 'tags' },
        { title: 'Search', path: '/search', icon: 'search' },
        { title: 'Help', path: '/help', icon: 'help' },
        { title: 'Settings', path: '/settings', icon: 'settings' },
        { title: 'Devices & sync', path: '/settings/sync', icon: 'sync' },
        { title: 'Backup', path: '/settings/backup', icon: 'backup' },
        { title: 'Keyboard shortcuts', path: '/settings/shortcuts', icon: 'keyboard' },
        { title: 'About Oyot', path: '/settings/about', icon: 'info' },
    ];

    let query = $state('');
    let selected = $state(0);
    let input = $state<HTMLInputElement | null>(null);
    let tags = $state<TagSummary[]>([]);

    // Each time it opens: empty, focused, with the tags read afresh.
    $effect(() => {
        if (!switcher.open) return;
        query = '';
        selected = 0;
        void tick().then(() => input?.focus());
        void loadAllTags().then((loaded) => (tags = loaded));
    });

    function close() {
        switcher.hide();
    }

    function go(path: string) {
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- fixed app paths
        void goto(path);
    }

    let items = $derived.by((): Item[] => {
        const q = query.trim();
        const today = journalTitleFor(new Date());
        const out: Item[] = [];

        if (!q) {
            out.push({
                key: 'today',
                group: 'Go to',
                icon: 'today',
                title: "Today's journal",
                run: () => openJournal(today),
            });
            for (const place of PLACES.slice(0, 4)) {
                out.push({
                    key: place.path,
                    group: 'Go to',
                    icon: place.icon,
                    title: place.title,
                    run: () => go(place.path),
                });
            }
            const recent = [...$documents]
                .filter((d) => d.doc_type === 'note')
                .sort((a, b) => b.updated_at - a.updated_at)
                .slice(0, 5);
            for (const doc of recent) {
                out.push({
                    key: doc.id,
                    group: 'Notes',
                    icon: 'note',
                    title: doc.title,
                    detail: doc.pinned ? 'Pinned' : undefined,
                    run: () => openDocument(doc.id),
                });
            }
            return out;
        }

        const notes = $documents.filter((d) => d.doc_type === 'note');
        for (const doc of rank(notes, q, (d) => d.title, 6)) {
            out.push({
                key: doc.id,
                group: 'Notes',
                icon: 'note',
                title: doc.title,
                detail: doc.pinned ? 'Pinned' : undefined,
                run: () => openDocument(doc.id),
            });
        }

        // A journal answers to its day written out, or as stored.
        const journals = $documents.filter((d) => d.doc_type === 'journal');
        const dayText = (title: string) =>
            `${longJournalTitle(title) ?? ''} ${title}${title === today ? ' today' : ''}`;
        for (const doc of rank(journals, q, (d) => dayText(d.title), 4)) {
            out.push({
                key: doc.id,
                group: 'Journals',
                icon: 'journals',
                title: longJournalTitle(doc.title) ?? doc.title,
                detail: doc.title === today ? 'Today' : undefined,
                run: () => openDocument(doc.id),
            });
        }

        for (const tag of rank(tags, q.replace(/^#/, ''), (t) => t.name, 4)) {
            out.push({
                key: `#${tag.name}`,
                group: 'Tags',
                icon: 'tags',
                title: `#${tag.name}`,
                detail: tag.documentCount === 1 ? '1 note' : `${tag.documentCount} notes`,
                run: () => openTag(tag.name),
            });
        }

        for (const place of rank(PLACES, q, (p) => p.title, 3)) {
            out.push({
                key: place.path,
                group: 'Go to',
                icon: place.icon,
                title: place.title,
                run: () => go(place.path),
            });
        }

        out.push({
            key: 'create',
            group: 'Actions',
            icon: 'plus',
            title: `Create a note called “${q}”`,
            run: async () => {
                try {
                    const doc = await createNote(q);
                    openNextForEditing(doc.id);
                    await openDocument(doc.id);
                } catch (error) {
                    console.error('[switcher] could not create a note:', error);
                    toasts.error('Could not create this note');
                }
            },
        });
        out.push({
            key: 'search',
            group: 'Actions',
            icon: 'search',
            title: `Search everything for “${q}”`,
            run: () => go(`/search?q=${encodeURIComponent(q)}`),
        });
        return out;
    });

    // Back to the first row whenever the words change.
    $effect(() => {
        void query;
        selected = 0;
    });

    async function choose(item: Item | undefined) {
        if (!item) return;
        close();
        await item.run();
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            selected = Math.min(selected + 1, items.length - 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selected = Math.max(selected - 1, 0);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            void choose(items[selected]);
        }
    }

    // Keep the row the keys are on in sight.
    $effect(() => {
        void selected;
        void tick().then(() =>
            document.querySelector('.qs-item.selected')?.scrollIntoView({ block: 'nearest' }),
        );
    });
</script>

{#if switcher.open}
    <div class="qs-scrim" role="presentation" onclick={close}></div>
    <div class="qs" role="dialog" aria-modal="true" aria-label="Quick switcher">
        <label class="qs-field">
            <Icon name="search" size={20} />
            <input
                bind:this={input}
                bind:value={query}
                onkeydown={handleKeydown}
                placeholder="Jump to a note, journal, tag or page"
                aria-label="Jump to"
                aria-controls="qs-list"
                aria-activedescendant={items[selected] ? `qs-${selected}` : undefined}
                autocomplete="off"
                spellcheck="false"
            />
            <span class="kbd">Esc</span>
        </label>
        <div class="qs-list" id="qs-list" role="listbox">
            {#each items as item, i (item.key)}
                {#if i === 0 || items[i - 1].group !== item.group}
                    <div class="qs-group">{item.group}</div>
                {/if}
                <button
                    id="qs-{i}"
                    class="qs-item"
                    class:selected={i === selected}
                    role="option"
                    aria-selected={i === selected}
                    onclick={() => choose(item)}
                    onmousemove={() => (selected = i)}
                >
                    <span class="qs-icon"><Icon name={item.icon} size={16} /></span>
                    <span class="qs-title">
                        {#each highlight(item.title, query.trim().replace(/^#/, '')) as run, r (r)}
                            {#if run.match}<em>{run.text}</em>{:else}{run.text}{/if}
                        {/each}
                    </span>
                    {#if item.detail}
                        <span class="qs-detail">{item.detail}</span>
                    {/if}
                    {#if i === selected}
                        <span class="kbd">Enter</span>
                    {/if}
                </button>
            {/each}
        </div>
        <div class="qs-foot">
            <span><span class="kbd">↑</span> <span class="kbd">↓</span> move</span>
            <span><span class="kbd">Enter</span> open</span>
            <span><span class="kbd">Esc</span> close</span>
        </div>
    </div>
{/if}

<style>
    .qs-scrim {
        position: fixed;
        inset: 0;
        z-index: 900;
        background: var(--scrim);
    }

    .qs {
        position: fixed;
        z-index: 901;
        top: calc(var(--safe-top) + 12vh);
        left: 50%;
        transform: translateX(-50%);
        width: min(640px, calc(100vw - 32px));
        max-height: calc(100dvh - var(--safe-top) - 16vh);
        display: flex;
        flex-direction: column;
        background: var(--bg-raised);
        border-radius: 16px;
        box-shadow: var(--shadow-pop);
        overflow: hidden;
        animation: qs-in 0.12s ease-out;
    }

    @keyframes qs-in {
        from {
            opacity: 0;
            transform: translateX(-50%) translateY(-6px) scale(0.98);
        }
    }

    .qs-field {
        display: flex;
        align-items: center;
        gap: 12px;
        height: 58px;
        padding: 0 16px 0 18px;
        border-bottom: 1px solid var(--border-color);
        color: var(--text-muted);
    }

    .qs-field input {
        flex: 1;
        min-width: 0;
        border: none;
        outline: none;
        background: transparent;
        color: var(--text-primary);
        font-size: 17px;
    }

    .qs-field input::placeholder {
        color: var(--text-muted);
    }

    .qs-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px 8px 8px;
    }

    .qs-group {
        padding: 10px 10px 4px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-muted);
    }

    .qs-item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 44px;
        padding: 0 10px;
        border: none;
        border-radius: 10px;
        background: none;
        color: var(--text-primary);
        font-size: 14px;
        text-align: left;
        cursor: pointer;
    }

    .qs-item.selected {
        background: var(--accent-bg);
    }

    .qs-icon {
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        border-radius: var(--radius-md);
        background: var(--code-bg);
        box-shadow: inset 0 0 0 1px var(--border-color);
        color: var(--text-secondary);
    }

    .qs-title {
        flex: 1;
        min-width: 0;
        font-weight: 550;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .qs-title em {
        font-style: normal;
        color: var(--accent-color);
        font-weight: 650;
    }

    .qs-detail {
        flex-shrink: 0;
        font-size: 12.5px;
        color: var(--text-muted);
    }

    .qs-foot {
        display: flex;
        gap: 16px;
        height: 40px;
        align-items: center;
        padding: 0 18px;
        border-top: 1px solid var(--border-color);
        background: var(--code-bg);
        font-size: 12px;
        color: var(--text-muted);
    }

    @media (pointer: coarse) {
        .qs-foot {
            display: none;
        }

        .qs {
            top: calc(var(--safe-top) + 12px);
        }
    }
</style>
