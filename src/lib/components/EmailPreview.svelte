<script lang="ts">
    import { invoke } from '@tauri-apps/api/core';
    import { createFrame, fitToWholePage } from '$lib/editor/htmlPreview/frame';
    import { onAttachmentReady, requestAttachment } from '$lib/tiptap/attachments';
    import { NO_SUBJECT } from '$lib/tiptap/nodes/EmailAttachmentNode';
    import { fileSize, headerLines, type EmailPart, type EmailView } from '$lib/email/view';
    import { toasts } from '$lib/services/toast';

    interface Props {
        hash: string;
        /** What the chip said, shown until the email itself is read. */
        subject: string | null;
        onClose: () => void;
    }

    let { hash, subject, onClose }: Props = $props();

    type Status = 'loading' | 'pending' | 'ready' | 'failed';
    let status = $state<Status>('loading');
    let view = $state<EmailView | null>(null);
    let failure = $state('');
    let closeButton = $state<HTMLButtonElement | null>(null);
    /** The file being saved, so its button cannot be pressed twice. */
    let saving = $state<number | null>(null);

    const title = $derived(view?.subject ?? subject ?? NO_SUBJECT);

    async function load(): Promise<void> {
        try {
            const read = await invoke<EmailView | null>('read_email', { hash });
            if (read) {
                view = read;
                status = 'ready';
            } else {
                // Not on this device yet. Asked for, and read again when it
                // arrives, without the user having to open it again.
                status = 'pending';
                requestAttachment(hash);
            }
        } catch (error) {
            failure = typeof error === 'string' ? error : 'This email could not be opened.';
            status = 'failed';
        }
    }

    $effect(() => {
        void load();
        return onAttachmentReady(hash, () => void load());
    });

    // Focus comes in with the view and goes back to the note when it closes,
    // as a dialog's does (see Modal).
    $effect(() => {
        const previous = document.activeElement as HTMLElement | null;
        closeButton?.focus();
        return () => previous?.focus?.();
    });

    function onKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
        }
    }

    /** The email's own HTML, in a frame that runs nothing (ADR 0043). */
    /**
     * Save one of the email's files. Rust asks where and writes it, so the
     * page never holds the path or the bytes.
     */
    async function save(part: EmailPart): Promise<void> {
        if (saving !== null) return;
        saving = part.index;
        try {
            const savedAs = await invoke<string | null>('save_email_part', {
                hash,
                index: part.index,
            });
            if (savedAs) toasts.success(`Saved ${savedAs}`);
        } catch (error) {
            toasts.error(typeof error === 'string' ? error : `Could not save ${part.name}`);
        } finally {
            saving = null;
        }
    }

    function showPage(holder: HTMLElement, html: string) {
        const frame = createFrame(html);
        frame.title = 'Email';
        fitToWholePage(frame);
        holder.append(frame);
        return { destroy: () => frame.remove() };
    }
</script>

<div
    class="email-preview"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onkeydown={onKeydown}
>
    <header class="bar">
        <button
            class="close"
            type="button"
            aria-label="Close"
            title="Close"
            bind:this={closeButton}
            onclick={onClose}
        >
            <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg
            >
        </button>
        <span class="bar-title">{title}</span>
    </header>

    <div class="scroll">
        <article class="sheet">
            <h1 class="subject">{title}</h1>

            {#if view}
                <dl class="headers">
                    {#each headerLines(view) as line (line.label)}
                        <dt>{line.label}</dt>
                        <dd>{line.value}</dd>
                    {/each}
                </dl>
            {/if}

            {#if status === 'loading'}
                <p class="notice">Opening the email…</p>
            {:else if status === 'pending'}
                <p class="notice">
                    This email is not on this device yet. It shows here as soon as one of your other
                    devices sends it.
                </p>
            {:else if status === 'failed'}
                <p class="notice notice-error">{failure}</p>
            {:else if view}
                {#if view.html}
                    <div class="body body-page" use:showPage={view.html}></div>
                {:else if view.text?.trim()}
                    <div class="body body-text">{view.text}</div>
                {:else}
                    <p class="notice">This email has no message.</p>
                {/if}

                {#if view.parts.length > 0}
                    <section class="files" aria-label="Files in this email">
                        <h2>
                            {view.parts.length === 1 ? '1 file' : `${view.parts.length} files`}
                        </h2>
                        <ul>
                            {#each view.parts as part (part.index)}
                                <li class="file">
                                    <svg
                                        class="file-icon"
                                        width="18"
                                        height="18"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        aria-hidden="true"
                                        ><path
                                            d="m21.152 10.9-9.015 9.015a5.25 5.25 0 0 1-7.425-7.425l9.016-9.015a3.5 3.5 0 0 1 4.95 4.95l-8.662 8.662a1.75 1.75 0 1 1-2.475-2.475l7.601-7.602"
                                        /></svg
                                    >
                                    <span class="file-name">{part.name}</span>
                                    <span class="file-size">{fileSize(part.size)}</span>
                                    <button
                                        class="file-save"
                                        type="button"
                                        disabled={saving !== null}
                                        aria-label={`Save ${part.name}`}
                                        onclick={() => save(part)}
                                    >
                                        {saving === part.index ? 'Saving…' : 'Save'}
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    </section>
                {/if}
            {/if}
        </article>
    </div>
</div>

<style>
    .email-preview {
        position: fixed;
        inset: 0;
        z-index: 1100;
        display: flex;
        flex-direction: column;
        background: var(--bg-primary);
        color: var(--text-primary);
        outline: none;
        animation: email-in 120ms ease-out;
    }

    .bar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
        padding: calc(var(--safe-top, 0px) + 8px) calc(var(--safe-right, 0px) + 12px) 8px
            calc(var(--safe-left, 0px) + 8px);
        border-bottom: 1px solid var(--border-light);
        background: var(--bg-secondary);
    }

    .close {
        width: 36px;
        height: 36px;
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
    }

    .close:hover,
    .close:focus-visible {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .bar-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 550;
        color: var(--text-secondary);
    }

    .scroll {
        flex: 1;
        overflow-y: auto;
        overscroll-behavior: contain;
    }

    .sheet {
        box-sizing: border-box;
        max-width: 860px;
        margin: 0 auto;
        padding: 24px calc(var(--safe-right, 0px) + 16px) calc(var(--safe-bottom, 0px) + 40px)
            calc(var(--safe-left, 0px) + 16px);
    }

    .subject {
        margin: 0 0 16px;
        font-size: 1.5rem;
        line-height: 1.3;
        overflow-wrap: anywhere;
    }

    .headers {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        margin: 0 0 20px;
        font-size: 0.9rem;
    }

    .headers dt {
        color: var(--text-muted);
    }

    .headers dd {
        margin: 0;
        min-width: 0;
        overflow-wrap: anywhere;
        color: var(--text-secondary);
    }

    .notice {
        color: var(--text-muted);
    }

    .notice-error {
        color: var(--error-text);
    }

    .body {
        margin-bottom: 24px;
    }

    .body-page :global(iframe) {
        display: block;
        width: 100%;
        border: 0;
        border-radius: 6px;
        /* An email that sets no background was written for a white one. */
        background: #fff;
        color-scheme: light;
    }

    .body-text {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        line-height: 1.6;
    }

    .files h2 {
        margin: 0 0 8px;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .files ul {
        margin: 0;
        padding: 0;
        list-style: none;
        border: 1px solid var(--border-color);
        border-radius: 8px;
    }

    .file {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
    }

    .file + .file {
        border-top: 1px solid var(--border-light);
    }

    .file-icon {
        flex: none;
        color: var(--text-muted);
    }

    .file-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .file-save {
        flex: none;
        padding: 4px 12px;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: 0.85rem;
        cursor: pointer;
    }

    .file-save:hover:not(:disabled),
    .file-save:focus-visible {
        background: var(--bg-hover);
    }

    .file-save:disabled {
        cursor: default;
        opacity: 0.6;
    }

    .file-size {
        flex: none;
        font-size: 0.85rem;
        color: var(--text-muted);
    }

    @keyframes email-in {
        from {
            opacity: 0;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .email-preview {
            animation: none;
        }
    }
</style>
