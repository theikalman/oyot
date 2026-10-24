<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { APP_VERSION } from '$lib/version';
    import { RELEASES, CHANGE_KIND_LABELS, type Release } from '$lib/changelog';
    import SettingsShell from '$lib/components/SettingsShell.svelte';
    import Icon from '$lib/components/Icon.svelte';

    // What Oyot is, and what changed in each release, as a timeline. It was a
    // dialog over whatever page was open; it is a page of Settings now, where
    // the version in the sidebar's foot leads.

    // The running release and the one before open expanded; older ones are
    // one click away so the page stays readable as the changelog grows.
    let expanded = $state<string[]>(RELEASES.slice(0, 2).map((r) => r.version));

    function isExpanded(release: Release): boolean {
        return expanded.includes(release.version);
    }

    function toggle(release: Release) {
        expanded = isExpanded(release)
            ? expanded.filter((version) => version !== release.version)
            : [...expanded, release.version];
    }

    function formatDate(date: string): string {
        const parsed = new Date(`${date}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) return date;
        return parsed.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    }
</script>

<SettingsShell title="About Oyot">
    <div class="identity">
        <span class="logo" aria-hidden="true"><span class="logo-o"></span></span>
        <div class="identity-text">
            <div class="name-row">
                <span class="name">Oyot</span>
                <span class="badge accent version">{APP_VERSION}</span>
            </div>
            <p class="about-desc">
                A note-taking app that keeps your notes on your own devices. Notes and journals sync
                peer to peer between the devices you pair, and never through anyone else's server.
            </p>
            <button class="btn" onclick={() => goto(resolve('/help'))}>
                <Icon name="help" size={16} />Help
            </button>
        </div>
    </div>

    <h3 class="whats-new">What's new</h3>

    <ol class="timeline">
        {#each RELEASES as release (release.version)}
            {@const current = release.version === APP_VERSION}
            <li class="release" class:current>
                <button
                    class="release-head"
                    onclick={() => toggle(release)}
                    aria-expanded={isExpanded(release)}
                >
                    <span class="release-version">{release.version}</span>
                    {#if current}
                        <span class="badge accent">You have this</span>
                    {/if}
                    {#if !isExpanded(release)}
                        <span class="release-line">{release.summary}</span>
                    {:else}
                        <span class="grow"></span>
                    {/if}
                    <span class="release-date">{formatDate(release.date)}</span>
                    <span class="chevron" class:open={isExpanded(release)}>
                        <Icon name="chevron-down" size={16} />
                    </span>
                </button>
                {#if isExpanded(release)}
                    <p class="release-summary">{release.summary}</p>
                    <ul class="changes">
                        {#each release.changes as change, i (i)}
                            <li class="change">
                                <span class="badge kind-{change.kind}">
                                    {CHANGE_KIND_LABELS[change.kind]}
                                </span>
                                <span>{change.text}</span>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </li>
        {/each}
    </ol>
</SettingsShell>

<style>
    .identity {
        display: flex;
        gap: 18px;
        padding: 22px;
        border-radius: var(--radius-lg);
        background: var(--bg-raised);
        box-shadow: 0 0 0 1px var(--border-color);
    }

    .logo {
        width: 56px;
        height: 56px;
        border-radius: 15px;
        background: var(--accent-color);
        display: grid;
        place-items: center;
        flex-shrink: 0;
    }

    .logo-o {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 5px solid var(--bg-primary);
    }

    .name-row {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .name {
        font-size: 24px;
        font-weight: 650;
        letter-spacing: -0.02em;
    }

    .version {
        font-family: var(--font-mono);
        font-size: 11.5px;
    }

    .about-desc {
        margin: 6px 0 14px;
        max-width: 540px;
        font-size: 14px;
        line-height: 1.5;
        color: var(--text-secondary);
    }

    .whats-new {
        margin: 32px 0 14px;
        font-size: 20px;
        font-weight: 620;
        letter-spacing: -0.015em;
    }

    .timeline {
        position: relative;
        margin: 0;
        padding: 0 0 0 28px;
        list-style: none;
    }

    .timeline::before {
        content: '';
        position: absolute;
        left: 7px;
        top: 12px;
        bottom: 12px;
        width: 2px;
        border-radius: 1px;
        background: var(--border-color);
    }

    .release {
        position: relative;
        padding-bottom: 6px;
    }

    .release::before {
        content: '';
        position: absolute;
        left: -26px;
        top: 13px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--bg-primary);
        box-shadow: inset 0 0 0 2px var(--control-line);
    }

    .release.current::before {
        background: var(--accent-color);
        box-shadow: 0 0 0 4px var(--accent-bg);
    }

    .release-head {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-height: 38px;
        padding: 0 8px;
        margin-left: -8px;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
    }

    .release-head:hover {
        background: var(--bg-hover);
    }

    .release-version {
        font-weight: 650;
        font-size: 15px;
    }

    .release-line {
        flex: 1;
        min-width: 0;
        font-size: 13px;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .grow {
        flex: 1;
    }

    .release-date {
        flex-shrink: 0;
        font-size: 12.5px;
        color: var(--text-muted);
    }

    .chevron {
        display: grid;
        color: var(--text-muted);
        transition: transform 0.15s;
    }

    .chevron.open {
        transform: rotate(180deg);
    }

    .release-summary {
        margin: 4px 0 8px;
        font-size: 14.5px;
        line-height: 1.5;
    }

    .changes {
        margin: 0 0 14px;
        padding: 0;
        list-style: none;
    }

    .change {
        display: grid;
        grid-template-columns: 84px minmax(0, 1fr);
        gap: 12px;
        align-items: start;
        padding: 6px 0;
        font-size: 13.5px;
        line-height: 1.5;
        color: var(--text-secondary);
    }

    .change .badge {
        justify-content: center;
    }

    .kind-added {
        background: var(--info-bg);
        color: var(--info-text);
        box-shadow: none;
    }

    .kind-improved {
        background: var(--ok-bg);
        color: var(--ok-text);
        box-shadow: none;
    }

    .kind-fixed,
    .kind-removed {
        background: var(--warn-bg);
        color: var(--warn-text);
        box-shadow: none;
    }

    .kind-security {
        background: var(--error-bg);
        color: var(--error-text);
        box-shadow: none;
    }

    @media (max-width: 640px) {
        .release-line,
        .release-date {
            display: none;
        }

        .change {
            grid-template-columns: 1fr;
            gap: 4px;
        }

        .change .badge {
            justify-self: start;
        }
    }
</style>
