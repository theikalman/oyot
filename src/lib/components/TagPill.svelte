<script lang="ts">
    import { tagHueStyle } from '$lib/tags/tagHue';

    // A tag as the lists show it: a quiet pill with its # in the tag's own
    // hue, the same one the editor gives it. A button when it leads
    // somewhere, which on every list is the tag's own page.
    interface Props {
        name: string;
        onclick?: () => void;
        /** Shown after the name, such as how many there are. */
        count?: number;
    }

    let { name, onclick, count }: Props = $props();
</script>

{#if onclick}
    <button class="tag-pill" style={tagHueStyle(name)} {onclick} title="Everything tagged #{name}">
        <span class="hash">#</span>{name}{#if count !== undefined}<span class="count">{count}</span
            >{/if}
    </button>
{:else}
    <span class="tag-pill" style={tagHueStyle(name)}>
        <span class="hash">#</span>{name}{#if count !== undefined}<span class="count">{count}</span
            >{/if}
    </span>
{/if}

<style>
    button.tag-pill {
        border: none;
        cursor: pointer;
    }

    button.tag-pill:hover {
        color: var(--text-primary);
        box-shadow: inset 0 0 0 1px var(--border-light);
    }

    .count {
        margin-left: 5px;
        color: var(--text-muted);
    }
</style>
