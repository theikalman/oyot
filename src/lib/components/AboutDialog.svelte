<script lang="ts">
    import { APP_VERSION } from '../version';
    import { RELEASES, CHANGE_KIND_LABELS, type Release } from '../changelog';

    interface Props {
        onClose: () => void;
    }

    let { onClose }: Props = $props();

    // The running release opens expanded; older ones are one click away so the
    // dialog stays readable as the changelog grows.
    let expanded = $state<string[]>(RELEASES.length > 0 ? [RELEASES[0].version] : []);

    function isExpanded(release: Release): boolean {
        return expanded.includes(release.version);
    }

    function toggle(release: Release) {
        expanded = isExpanded(release)
            ? expanded.filter((version) => version !== release.version)
            : [...expanded, release.version];
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            onClose();
        }
    }

    function formatDate(date: string): string {
        const parsed = new Date(`${date}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) return date;
        // Short month: the header has to stay on one line on a phone.
        return parsed.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Only a click on the backdrop itself closes; clicks inside the dialog bubble
     up to here but land on the dialog, not the backdrop. -->
<div
    class="modal-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && onClose()}
>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="about-title" tabindex="-1">
        <header class="about-header">
            <div class="about-title-group">
                <h3 id="about-title">Oyot</h3>
                <span class="version-badge">{APP_VERSION}</span>
            </div>
            <button class="close-btn" onclick={onClose} title="Close" aria-label="Close">
                <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M18 6 6 18M6 6l12 12" />
                </svg>
            </button>
        </header>

        <p class="about-desc">
            A note taking app that keeps your notes on your own devices. Notes and journals sync
            peer to peer between the devices you pair, and never through anyone else's server.
        </p>

        <h4 class="changelog-heading">What's new</h4>

        <div class="changelog">
            {#each RELEASES as release (release.version)}
                <section class="release">
                    <button
                        class="release-header"
                        onclick={() => toggle(release)}
                        aria-expanded={isExpanded(release)}
                    >
                        <svg
                            class="chevron"
                            class:open={isExpanded(release)}
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M9 18l6-6-6-6" />
                        </svg>
                        <span class="release-version">{release.version}</span>
                        {#if release.version === APP_VERSION}
                            <span class="current-tag">current</span>
                        {/if}
                        <span class="release-date">{formatDate(release.date)}</span>
                    </button>

                    {#if isExpanded(release)}
                        <p class="release-summary">{release.summary}</p>
                        <ul class="change-list">
                            {#each release.changes as change, i (i)}
                                <li class="change">
                                    <span class="kind kind-{change.kind}">
                                        {CHANGE_KIND_LABELS[change.kind]}
                                    </span>
                                    <span class="change-text">{change.text}</span>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </section>
            {/each}
        </div>
    </div>
</div>

<style>
    .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: calc(24px + var(--safe-top)) calc(24px + var(--safe-right))
            calc(24px + var(--safe-bottom)) calc(24px + var(--safe-left));
    }

    .modal {
        display: flex;
        flex-direction: column;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        width: 100%;
        max-width: 520px;
        max-height: 100%;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
        color: var(--text-primary);
    }

    .about-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
    }

    .about-title-group {
        display: flex;
        align-items: baseline;
        gap: 10px;
    }

    h3 {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
    }

    .version-badge {
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--accent-bg);
        color: var(--accent-color);
        font-size: 12px;
        font-weight: 600;
    }

    .close-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: var(--text-muted);
        cursor: pointer;
    }

    .close-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .about-desc {
        margin: 12px 0 0 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-secondary);
    }

    .changelog-heading {
        margin: 24px 0 8px 0;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-secondary);
    }

    .changelog {
        overflow-y: auto;
        border: 1px solid var(--border-color);
        border-radius: 10px;
    }

    .release + .release {
        border-top: 1px solid var(--border-color);
    }

    .release-header {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 12px 14px;
        background: transparent;
        border: none;
        cursor: pointer;
        text-align: left;
        color: var(--text-primary);
    }

    .release-header:hover {
        background: var(--bg-hover);
    }

    .chevron {
        flex-shrink: 0;
        color: var(--text-muted);
        transition: transform 0.15s;
    }

    .chevron.open {
        transform: rotate(90deg);
    }

    .release-version {
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
    }

    .current-tag {
        flex-shrink: 0;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--accent-bg);
        color: var(--accent-color);
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .release-date {
        margin-left: auto;
        font-size: 12px;
        color: var(--text-muted);
        white-space: nowrap;
    }

    .release-summary {
        margin: 0;
        padding: 0 14px 10px 38px;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-secondary);
    }

    .change-list {
        margin: 0;
        padding: 0 14px 14px 38px;
        list-style: none;
    }

    .change {
        display: flex;
        gap: 8px;
        padding: 4px 0;
        font-size: 13px;
        line-height: 1.5;
    }

    .kind {
        flex-shrink: 0;
        min-width: 62px;
        height: fit-content;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        text-align: center;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        line-height: 1.6;
    }

    .kind-added {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .kind-improved {
        background: var(--bg-hover);
        color: var(--text-secondary);
    }

    .kind-fixed {
        background: rgba(34, 139, 84, 0.14);
        color: #2f8f5b;
    }

    .kind-security {
        background: rgba(217, 119, 6, 0.14);
        color: #b45309;
    }

    /* Deliberately not red. A removal is news, not a fault, and the error
       colour would read as something having gone wrong. */
    .kind-removed {
        background: rgba(120, 113, 108, 0.16);
        color: #6b6460;
    }

    /* The status colours need lifting on the dark theme to stay readable. */
    :global([data-theme='dark']) .kind-fixed {
        color: #5fbf8a;
    }

    :global([data-theme='dark']) .kind-security {
        color: #e0a355;
    }

    :global([data-theme='dark']) .kind-removed {
        color: #b3aaa4;
    }

    .change-text {
        color: var(--text-primary);
    }

    @media (max-width: 640px) {
        .modal-backdrop {
            padding: 12px;
        }

        .kind {
            min-width: 0;
        }

        .release-summary,
        .change-list {
            padding-left: 14px;
        }
    }
</style>
