<script lang="ts">
    import type { Editor } from '@tiptap/core';
    import { insertImageFromFile } from '$lib/tiptap';

    interface Props {
        editor: Editor | null;
    }

    let { editor }: Props = $props();

    function handleImageInsert() {
        if (editor) {
            insertImageFromFile(editor);
        }
    }
</script>

<div class="toolbar visible">
    <button onclick={() => editor?.chain().focus().toggleBold().run()} title="Bold">
        <strong>B</strong>
    </button>
    <button onclick={() => editor?.chain().focus().toggleItalic().run()} title="Italic">
        <em>I</em>
    </button>
    <button onclick={() => editor?.chain().focus().toggleStrike().run()} title="Strikethrough">
        <s>S</s>
    </button>
    <span class="separator"></span>
    <button onclick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1">
        H1
    </button>
    <button onclick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
        H2
    </button>
    <button onclick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">
        H3
    </button>
    <span class="separator"></span>
    <button onclick={() => editor?.chain().focus().toggleBulletList().run()} title="Bullet List">
        •
    </button>
    <button onclick={() => editor?.chain().focus().toggleOrderedList().run()} title="Ordered List">
        1.
    </button>
    <button onclick={() => editor?.chain().focus().toggleTaskList().run()} title="Task List">
        ☑
    </button>
    <span class="separator"></span>
    <button onclick={() => editor?.chain().focus().toggleBlockquote().run()} title="Quote">
        "
    </button>
    <button onclick={() => editor?.chain().focus().toggleCodeBlock().run()} title="Code Block">
        &lt;/&gt;
    </button>
    <button onclick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3 }).run()} title="Table">
        ⊞
    </button>
    <button onclick={handleImageInsert} title="Insert Image">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A1A1A1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="m4.272 20.728 6.597-6.597c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668l6.553 6.553M14 15l2.869-2.869c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668L22 15M10 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6.8 21h10.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C22 18.72 22 17.88 22 16.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C19.72 3 18.88 3 17.2 3H6.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C2 5.28 2 6.12 2 7.8v8.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C4.28 21 5.12 21 6.8 21"/>
        </svg>
    </button>
    <span class="separator"></span>
    <button onclick={() => editor?.chain().focus().undo().run()} title="Undo">
        ↩
    </button>
    <button onclick={() => editor?.chain().focus().redo().run()} title="Redo">
        ↪
    </button>
</div>

<style>
    .toolbar {
        display: flex;
        padding: 8px 16px;
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border-color);
        gap: 4px;
        flex-wrap: wrap;
    }

    .toolbar button {
        padding: 6px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border-light);
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        min-width: 32px;
        color: var(--text-primary);
    }

    .toolbar button:hover {
        background: var(--bg-hover);
    }

    .separator {
        width: 1px;
        background: var(--border-light);
        margin: 0 4px;
    }
</style>