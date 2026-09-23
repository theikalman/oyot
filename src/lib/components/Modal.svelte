<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        title: string;
        onClose: () => void;
        children: Snippet;
        /** The buttons. Kept separate so every dialog puts them in the same place. */
        actions?: Snippet;
    }

    let { title, onClose, children, actions }: Props = $props();

    let dialog = $state<HTMLDivElement | null>(null);

    // Focus moves into the dialog when it opens and returns to whatever had it
    // when the dialog closes. None of the five hand-rolled dialogs this
    // replaces did either, so opening one left the keyboard behind in the page
    // underneath and closing one left it nowhere in particular.
    $effect(() => {
        const previous = document.activeElement as HTMLElement | null;
        // Prefer the first control, so Enter does the obvious thing; fall back
        // to the dialog itself, which is focusable for exactly this reason.
        const first = dialog?.querySelector<HTMLElement>(
            'input, textarea, select, button:not([data-secondary])',
        );
        (first ?? dialog)?.focus();
        return () => previous?.focus?.();
    });

    // Tab cycles within the dialog. Without this, tabbing walks out into the
    // page behind it, which is both confusing and a way to activate things
    // the dialog is supposed to be blocking.
    function trapFocus(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
            return;
        }
        if (event.key !== 'Tab' || !dialog) return;

        const focusable = [
            ...dialog.querySelectorAll<HTMLElement>(
                'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
            ),
        ].filter((el) => !el.hasAttribute('disabled'));
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (event.shiftKey && (active === first || active === dialog)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;
</script>

<!-- The backdrop closes on click but is not itself interactive, so it carries
     no role that would suggest otherwise. -->
<div class="modal-overlay" role="presentation" onclick={onClose}>
    <div
        class="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabindex="-1"
        bind:this={dialog}
        onclick={(e) => e.stopPropagation()}
        onkeydown={trapFocus}
    >
        <h3 id={titleId}>{title}</h3>
        {@render children()}
        {#if actions}
            <div class="modal-actions">{@render actions()}</div>
        {/if}
    </div>
</div>

<style>
    .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    }

    .modal-content {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        min-width: 320px;
        max-width: 420px;
        width: 90%;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    }

    .modal-content h3 {
        margin: 0 0 16px 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .modal-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 20px;
    }
</style>
