<script lang="ts">
    import { toasts } from '$lib/services/toast';
    import {
        FOLDER,
        WEEKDAYS,
        chooseBackupFolder,
        dismissBackupSuggestion,
        fromTimeInput,
        setBackupSchedule,
        settingsOf,
        suggestion,
        toTimeInput,
        type BackupProvider,
        type Frequency,
        type ScheduleSettings,
        type ScheduleView,
    } from '$lib/backup';

    interface Props {
        schedule: ScheduleView;
        /** Every provider this build has, linked or not. */
        providers: BackupProvider[];
        /** The schedule changed; this is how it is now. */
        onChanged: (schedule: ScheduleView) => void;
    }

    let { schedule, providers, onChanged }: Props = $props();

    // Not a destination: the option that opens the folder dialog.
    const CHOOSE_FOLDER = 'choose-folder';

    let saving = $state(false);
    // Bumped when a change is refused or abandoned, so the controls redraw
    // from the schedule as it is rather than keep showing the refused value.
    let redraw = $state(0);

    let linked = $derived(providers.filter((p) => p.account !== null));
    let suggested = $derived(suggestion(schedule, providers));
    let on = $derived(schedule.frequency !== 'off');
    // Whether there is anywhere a schedule could send backups from this
    // device. A phone has no folder, so only a linked account.
    let possible = $derived(linked.length > 0 || schedule.foldersSupported);

    interface Choice {
        value: string;
        label: string;
        disabled?: boolean;
    }

    let destinations = $derived.by(() => {
        const choices: Choice[] = linked.map((p) => ({
            value: p.id,
            label: `${p.name} (${p.account?.email})`,
        }));
        if (schedule.foldersSupported && schedule.folderLabel) {
            choices.push({ value: FOLDER, label: `Folder: ${schedule.folderLabel}` });
        }
        // Where it points even when that cannot be used now, such as an
        // account that was unlinked, so the list does not pretend otherwise.
        const current = schedule.destination;
        if (current && !choices.some((c) => c.value === current)) {
            choices.unshift({
                value: current,
                label: schedule.destinationLabel ?? current,
                disabled: true,
            });
        }
        if (schedule.foldersSupported) {
            choices.push({
                value: CHOOSE_FOLDER,
                label: schedule.folderLabel ? 'Choose another folder…' : 'Choose a folder…',
            });
        }
        return choices;
    });

    // Saves go one after another, each built from the schedule as the one
    // before it left it. Two in flight at once would each send the other's
    // setting back as it was.
    let queue: Promise<void> = Promise.resolve();

    function save(change: Partial<ScheduleSettings>): Promise<void> {
        queue = queue.then(async () => {
            saving = true;
            try {
                onChanged(await setBackupSchedule({ ...settingsOf(schedule), ...change }));
            } catch (error) {
                toasts.error(`Could not save the schedule: ${message(error)}`);
                redraw++;
            } finally {
                saving = false;
            }
        });
        return queue;
    }

    /** Open the folder dialog. The folder becomes where scheduled backups go. */
    async function chooseFolder(): Promise<boolean> {
        saving = true;
        try {
            const chosen = await chooseBackupFolder();
            if (chosen) onChanged(chosen);
            return chosen !== null;
        } catch (error) {
            toasts.error(`Could not use that folder: ${message(error)}`);
            return false;
        } finally {
            saving = false;
        }
    }

    /**
     * Where a schedule being turned on goes: where it pointed before, if that
     * still works, otherwise the first linked account.
     */
    function destinationForOn(): string | null {
        const current = schedule.destination;
        if (current && linked.some((p) => p.id === current)) return current;
        if (current === FOLDER && schedule.folderLabel && schedule.foldersSupported) return FOLDER;
        return linked[0]?.id ?? null;
    }

    async function handleFrequency(event: Event) {
        const frequency = (event.currentTarget as HTMLSelectElement).value as Frequency;
        if (frequency === 'off' || on) {
            await save({ frequency });
            return;
        }
        // Turning it on: it has to go somewhere, and on a computer with no
        // account linked, that is a folder the user picks now.
        let destination = destinationForOn();
        if (!destination && schedule.foldersSupported && (await chooseFolder())) {
            destination = FOLDER;
        }
        if (!destination) {
            redraw++;
            return;
        }
        await save({ frequency, destination });
    }

    async function handleDestination(event: Event) {
        const value = (event.currentTarget as HTMLSelectElement).value;
        if (value === CHOOSE_FOLDER) {
            await chooseFolder();
            // Chosen or not, the list should show what is saved, not "Choose".
            redraw++;
            return;
        }
        await save({ destination: value });
    }

    // On leaving the field, or Enter, not on change: some webviews fire
    // change on every keystroke, so typing 18:30 would save 01:00 first.
    function commitTime(event: Event) {
        const minutes = fromTimeInput((event.currentTarget as HTMLInputElement).value);
        if (minutes === null) {
            redraw++;
            return;
        }
        if (minutes !== schedule.timeOfDay) void save({ timeOfDay: minutes });
    }

    function handleTimeKey(event: KeyboardEvent) {
        if (event.key === 'Enter') commitTime(event);
    }

    function handleWeekday(event: Event) {
        void save({ weekday: Number((event.currentTarget as HTMLSelectElement).value) });
    }

    function handleSkip(event: Event) {
        void save({ skipUnchanged: (event.currentTarget as HTMLInputElement).checked });
    }

    function handleKeep(event: Event) {
        const keep = Number((event.currentTarget as HTMLInputElement).value);
        if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
            toasts.error('Keep between 1 and 100 scheduled backups.');
            redraw++;
            return;
        }
        void save({ keep });
    }

    async function handleTurnOn(provider: BackupProvider) {
        await save({ frequency: 'daily', destination: provider.id });
    }

    async function handleNotNow() {
        try {
            await dismissBackupSuggestion();
            onChanged({ ...schedule, suggestionDismissed: true });
        } catch (error) {
            toasts.error(`Could not save that: ${message(error)}`);
        }
    }

    // A Tauri command rejects with a string, not an Error.
    function message(error: unknown): string {
        if (typeof error === 'string') return error;
        return error instanceof Error ? error.message : 'unknown error';
    }
</script>

<section class="settings-section">
    <h2 class="section-title">Scheduled backups</h2>

    {#if suggested}
        <div class="suggestion">
            <span class="suggestion-text">
                Back up automatically? Oyot can back up to {suggested.name} every day, so there is always
                a recent backup.
            </span>
            <div class="actions">
                <button
                    class="btn primary"
                    onclick={() => suggested && handleTurnOn(suggested)}
                    disabled={saving}
                >
                    Turn on
                </button>
                <button class="btn" onclick={handleNotNow} disabled={saving}>Not now</button>
            </div>
        </div>
    {/if}

    <div class="section-card">
        {#if !possible && !on}
            <div class="row">
                <span class="desc">
                    {#if providers.length === 0}
                        Scheduled backups on a phone go to a linked account, and this version of
                        Oyot cannot link one. Use Back up now to save a copy to a file.
                    {:else}
                        Link an account above to back up on a schedule.
                    {/if}
                </span>
            </div>
        {:else}
            {#key redraw}
                <div class="row">
                    <label class="label" for="backup-frequency">Back up automatically</label>
                    <select
                        id="backup-frequency"
                        value={schedule.frequency}
                        onchange={handleFrequency}
                        disabled={saving}
                    >
                        <option value="off">Off</option>
                        <option value="daily">Every day</option>
                        <option value="weekly">Every week</option>
                    </select>
                </div>

                {#if on}
                    <div class="row">
                        <span class="label">When</span>
                        <div class="controls">
                            {#if schedule.frequency === 'weekly'}
                                <select
                                    aria-label="Day of the week"
                                    value={String(schedule.weekday)}
                                    onchange={handleWeekday}
                                    disabled={saving}
                                >
                                    {#each WEEKDAYS as day, index (day)}
                                        <option value={String(index)}>{day}</option>
                                    {/each}
                                </select>
                                <span class="joiner">at</span>
                            {/if}
                            <input
                                type="time"
                                aria-label="Time of day"
                                value={toTimeInput(schedule.timeOfDay)}
                                onblur={commitTime}
                                onkeydown={handleTimeKey}
                            />
                        </div>
                    </div>

                    <div class="row">
                        <label class="label" for="backup-destination">Where</label>
                        <select
                            id="backup-destination"
                            value={schedule.destination ?? ''}
                            onchange={handleDestination}
                            disabled={saving}
                        >
                            {#each destinations as choice (choice.value)}
                                <option value={choice.value} disabled={choice.disabled}>
                                    {choice.label}
                                </option>
                            {/each}
                        </select>
                    </div>

                    <label class="row">
                        <span class="info">
                            <span class="label">Skip when nothing has changed</span>
                            <span class="desc">
                                No new backup when the last one already holds everything
                            </span>
                        </span>
                        <input
                            type="checkbox"
                            checked={schedule.skipUnchanged}
                            onchange={handleSkip}
                            disabled={saving}
                        />
                    </label>

                    <div class="row">
                        <span class="info">
                            <label class="label" for="backup-keep">Scheduled backups to keep</label>
                            <span class="desc">
                                Older scheduled backups are deleted. Backups you make yourself are
                                never removed.
                            </span>
                        </span>
                        <input
                            id="backup-keep"
                            class="keep"
                            type="number"
                            min="1"
                            max="100"
                            step="1"
                            value={schedule.keep}
                            onchange={handleKeep}
                            disabled={saving}
                        />
                    </div>
                {/if}
            {/key}

            <p class="note">
                {#if schedule.foldersSupported}
                    Scheduled backups run while Oyot is open. One that was missed runs a few minutes
                    after Oyot next opens.
                {:else}
                    Scheduled backups only run while Oyot is open on screen. One that was missed
                    runs a few minutes after Oyot is next opened.
                {/if}
            </p>
        {/if}
    </div>
</section>

<style>
    .settings-section {
        margin-bottom: 32px;
    }

    .section-title {
        margin: 0 0 12px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .section-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        overflow: hidden;
    }

    .suggestion {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
        padding: 14px 16px;
        border: 1px solid var(--accent-color);
        border-radius: 12px;
        background: var(--bg-accent);
    }

    .suggestion-text {
        flex: 1 1 240px;
        font-size: 14px;
        color: var(--text-primary);
    }

    .row {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 12px 16px;
        padding: 14px 16px;
    }

    .row + .row {
        border-top: 1px solid var(--border-color);
    }

    label.row {
        cursor: pointer;
    }

    .info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        flex: 1 1 200px;
    }

    .label {
        font-weight: 500;
        color: var(--text-primary);
        font-size: 15px;
    }

    .desc {
        font-size: 13px;
        color: var(--text-muted);
        overflow-wrap: anywhere;
    }

    .controls {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .joiner {
        font-size: 14px;
        color: var(--text-muted);
    }

    select,
    input[type='time'],
    input[type='number'] {
        min-width: 0;
        max-width: 100%;
        padding: 7px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        font: inherit;
        font-size: 14px;
        color: var(--text-primary);
    }

    select:disabled,
    input:disabled {
        color: var(--text-muted);
    }

    .keep {
        width: 72px;
    }

    input[type='checkbox'] {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        accent-color: var(--accent-color);
    }

    .note {
        margin: 0;
        padding: 12px 16px 14px;
        border-top: 1px solid var(--border-color);
        font-size: 12px;
        color: var(--text-muted);
    }

    .actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
    }

    .btn {
        padding: 8px 16px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 10px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        color: var(--text-primary);
        transition: background-color 0.15s;
        white-space: nowrap;
    }

    .btn:hover:not(:disabled) {
        background: var(--bg-hover);
    }

    .btn:disabled {
        cursor: default;
        color: var(--text-muted);
    }

    .btn.primary {
        background: var(--accent-color);
        border-color: var(--accent-color);
        color: white;
    }

    .btn.primary:hover:not(:disabled) {
        background: var(--accent-hover);
    }
</style>
