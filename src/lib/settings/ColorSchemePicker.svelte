<script lang="ts">
    import { appStore, theme } from '$lib/stores/app';
    import { saveTheme } from '$lib/services/theme';
    import { toasts } from '$lib/services/toast';
    import { colorSchemeFamilies, type ColorSchemeId } from '$lib/theme/schemes';

    const families = colorSchemeFamilies();

    // Applied at once and saved after, so the choice shows without waiting on
    // Rust; a save that fails leaves it applied for this run and says so.
    async function choose(id: ColorSchemeId) {
        if (id === $theme) return;
        appStore.setTheme(id);
        try {
            await saveTheme(id);
        } catch {
            toasts.error('Could not save the color scheme. It will go back on the next start.');
        }
    }
</script>

<div class="picker" role="radiogroup" aria-label="Color scheme">
    {#each families as { family, schemes } (family)}
        <div class="family">
            <span class="family-name">{family}</span>
            <div class="options">
                {#each schemes as scheme (scheme.id)}
                    <label class="option" class:selected={$theme === scheme.id}>
                        <input
                            type="radio"
                            name="color-scheme"
                            value={scheme.id}
                            checked={$theme === scheme.id}
                            onchange={() => choose(scheme.id)}
                        />
                        <!-- Drawn in the scheme's own colours: its block in
                             schemes.css applies to any element carrying it. -->
                        <span class="preview" data-scheme={scheme.id} aria-hidden="true">
                            <span class="preview-sidebar">
                                <span class="preview-line short"></span>
                                <span class="preview-line accent"></span>
                                <span class="preview-line short"></span>
                            </span>
                            <span class="preview-page">
                                <span class="preview-line title"></span>
                                <span class="preview-line"></span>
                                <span class="preview-line muted"></span>
                                <span class="preview-dots">
                                    <span class="dot ok"></span>
                                    <span class="dot todo"></span>
                                    <span class="dot error"></span>
                                </span>
                            </span>
                        </span>
                        <span class="option-label">
                            <span class="option-name">{scheme.name}</span>
                            <span class="option-appearance">
                                {scheme.appearance === 'light' ? 'Light' : 'Dark'}
                            </span>
                        </span>
                    </label>
                {/each}
            </div>
        </div>
    {/each}
</div>

<style>
    .picker {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 0 16px 16px;
    }

    .family {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .family-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
    }

    .options {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 10px;
    }

    .option {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 8px;
        border: 1px solid var(--border-color);
        border-radius: 10px;
        background: var(--bg-primary);
        cursor: pointer;
        transition: border-color 0.15s;
    }

    @media (hover: hover) {
        .option:hover {
            border-color: var(--border-light);
            background: var(--bg-hover);
        }
    }

    .option.selected {
        border-color: var(--accent-color);
        box-shadow: 0 0 0 1px var(--accent-color);
    }

    /* The radio itself is not drawn, the card is, but it stays in the page
       so arrow keys move between schemes and a screen reader reads them as
       one choice. */
    .option input {
        position: absolute;
        opacity: 0;
        width: 1px;
        height: 1px;
        margin: 0;
    }

    .option:has(input:focus-visible) {
        outline: 2px solid var(--accent-color);
        outline-offset: 2px;
    }

    .preview {
        display: flex;
        height: 56px;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
    }

    .preview-sidebar {
        display: flex;
        flex-direction: column;
        gap: 5px;
        width: 30%;
        padding: 8px 6px;
        background: var(--bg-secondary);
        border-right: 1px solid var(--border-color);
    }

    .preview-page {
        display: flex;
        flex-direction: column;
        gap: 5px;
        flex: 1;
        padding: 8px;
    }

    .preview-line {
        display: block;
        height: 4px;
        border-radius: 2px;
        background: var(--text-secondary);
    }

    .preview-line.short {
        width: 70%;
        background: var(--text-muted);
    }

    .preview-line.accent {
        background: var(--accent-color);
    }

    .preview-line.title {
        width: 60%;
        height: 5px;
        background: var(--text-primary);
    }

    .preview-line.muted {
        width: 80%;
        background: var(--text-muted);
    }

    .preview-dots {
        display: flex;
        gap: 4px;
        margin-top: auto;
    }

    .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
    }

    .dot.ok {
        background: var(--status-ok);
    }

    .dot.todo {
        background: var(--todo-open);
    }

    .dot.error {
        background: var(--status-error);
    }

    .option-label {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 6px;
    }

    .option-name {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
    }

    .option-appearance {
        font-size: 12px;
        color: var(--text-muted);
    }
</style>
