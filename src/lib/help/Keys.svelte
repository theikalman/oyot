<script lang="ts">
    import { shortcutLabel } from '$lib/editor/editorMode';

    // A shortcut's keys, written the way the tooltips write them, so the
    // help page and a button's tooltip never name one key two ways. More
    // than one set reads as a list: "⇧⌘Z or ⌘Y".
    interface Props {
        /** In the editor's notation (`Mod-Shift-z`). */
        keys: readonly string[];
        /** Whether Mod is Command here. Asked once by the page. */
        command: boolean;
    }

    let { keys, command }: Props = $props();

    function separator(i: number): string {
        if (i === 0) return '';
        return i === keys.length - 1 ? ' or ' : ', ';
    }
</script>

<span class="keys">
    {#each keys as key, i (key)}{separator(i)}<kbd>{shortcutLabel(key, command)}</kbd>{/each}
</span>

<style>
    .keys {
        white-space: nowrap;
        color: var(--text-secondary);
        font-size: 12px;
    }

    kbd {
        display: inline-block;
        min-width: 24px;
        padding: 2px 6px;
        border: 1px solid var(--border-light);
        border-bottom-width: 2px;
        border-radius: 5px;
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-family: inherit;
        font-size: 12px;
        font-weight: 500;
        line-height: 16px;
        text-align: center;
    }
</style>
