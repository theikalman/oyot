<script lang="ts">
    // The page's title, at the start of the header. On a phone or a tablet
    // a title too long for one line is cut short with an ellipsis. It used
    // to wrap onto as many lines as it took, and a note's title could fill
    // a third of a phone's screen before a word of the note. A tap on it
    // shows all of it, and the next tap, on the title or anywhere else,
    // cuts it short again.
    interface Props {
        title: string;
    }

    let { title }: Props = $props();

    let text = $state<HTMLSpanElement | null>(null);
    let toggle = $state<HTMLButtonElement | null>(null);

    // Whether the title is cut short, which only a small screen does. Only
    // then is it something to press: a title that fits has nothing more to
    // show, and a button that did nothing would still be read out as one,
    // and still be a stop for Tab.
    let truncated = $state(false);

    // The title shown in full, if any. The title rather than a flag, so the
    // next document's comes up cut short, the way the document page's
    // `editingId` gives each document its own reading or editing.
    let shownInFull = $state<string | null>(null);
    let expanded = $derived(shownInFull !== null && shownInFull === title);

    // Measured when the title is cut short again, and whenever its box
    // changes size, which is every reason it could start or stop fitting:
    // another title, a phone turned on its side, the sidebar opening beside
    // it, the tools after it changing width. Not while shown in full, when
    // nothing overflows.
    $effect(() => {
        const el = text;
        if (!el || expanded) return;
        const measure = () => {
            truncated = el.scrollWidth > el.clientWidth;
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    });

    function toggleShown() {
        shownInFull = expanded ? null : title;
    }

    // A tap anywhere else cuts it short again. Taken on the click, not the
    // press: the header shrinks with the title and the page moves up, and
    // done on the press, the click that follows would land on whatever had
    // moved under the finger, a link or a tick box, instead of what was
    // tapped. By the click, what was tapped has been settled.
    function cutShortOnClickElsewhere(event: MouseEvent) {
        if (expanded && !toggle?.contains(event.target as Node)) shownInFull = null;
    }

    // So does Tab moving on from it. Taken on the key rather than on focus
    // leaving, because a press on anything else that takes focus moves it
    // before that press's click, and cutting the title short there would
    // move what was pressed out from under the pointer.
    function cutShortOnTab(event: KeyboardEvent) {
        if (event.key === 'Tab') shownInFull = null;
    }
</script>

<svelte:window onclickcapture={cutShortOnClickElsewhere} />

{#snippet titleText()}
    <span class="title-text" bind:this={text}>{title}</span>
{/snippet}

<h1 class="page-title" class:expanded>
    {#if truncated || expanded}
        <button
            bind:this={toggle}
            class="title-toggle"
            aria-expanded={expanded}
            onclick={toggleShown}
            onkeydown={cutShortOnTab}
        >
            {@render titleText()}
        </button>
    {:else}
        {@render titleText()}
    {/if}
</h1>

<style>
    /* 32px lines, the height of everything else in the header, so the
       header's buttons can line up with the first line however many there
       are. */
    .page-title {
        min-width: 0;
        margin: 0;
        font-size: 24px;
        line-height: 32px;
        color: var(--text-primary);
    }

    .title-text {
        display: block;
    }

    /* Nothing of a button but the pointer, so the title looks the same
       whether or not it is one. */
    .title-toggle {
        display: block;
        width: 100%;
        margin: 0;
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: inherit;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
    }

    /* Phones and tablets, and a window as narrow as one, which is when the
       sidebar gets out of the way by itself too. */
    @media (max-width: 768px), (pointer: coarse) {
        .page-title:not(.expanded) .title-text {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }
    }
</style>
