<script lang="ts">
    import { toasts, type Toast } from '$lib/services/toast';

    let activeToasts = $derived($toasts);

    function getTypeStyles(type: Toast['type']): { bg: string; border: string; text: string } {
        switch (type) {
            case 'success':
                return { bg: '#f0fdf4', border: '#22c55e', text: '#166534' };
            case 'error':
                return { bg: '#fef2f2', border: '#ef4444', text: '#991b1b' };
            case 'warning':
                return { bg: '#fffbeb', border: '#f59e0b', text: '#92400e' };
            case 'info':
            default:
                return { bg: '#eff6ff', border: '#3b82f6', text: '#1e40af' };
        }
    }

    function handleClose(id: string) {
        toasts.remove(id);
    }
</script>

{#if activeToasts.length > 0}
    <div class="toast-container">
        {#each activeToasts as toast (toast.id)}
            {@const styles = getTypeStyles(toast.type)}
            <div
                class="toast"
                style="background-color: {styles.bg}; border-color: {styles.border}; color: {styles.text};"
                role="alert"
            >
                <span class="toast-icon">
                    {#if toast.type === 'success'}
                        ✓
                    {:else if toast.type === 'error'}
                        ✕
                    {:else if toast.type === 'warning'}
                        ⚠
                    {:else}
                        ℹ
                    {/if}
                </span>
                <span class="toast-message">{toast.message}</span>
                <button
                    class="toast-close"
                    onclick={() => handleClose(toast.id)}
                    aria-label="Close notification"
                >
                    ×
                </button>
            </div>
        {/each}
    </div>
{/if}

<style>
    .toast-container {
        position: fixed;
        bottom: 24px;
        right: 24px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 9999;
        pointer-events: none;
    }

    .toast {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        border: 1px solid;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        font-size: 14px;
        font-weight: 500;
        min-width: 280px;
        max-width: 400px;
        pointer-events: all;
        animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }

    .toast-icon {
        font-size: 16px;
        flex-shrink: 0;
    }

    .toast-message {
        flex: 1;
    }

    .toast-close {
        background: none;
        border: none;
        font-size: 18px;
        cursor: pointer;
        opacity: 0.6;
        padding: 0 4px;
        line-height: 1;
        flex-shrink: 0;
    }

    .toast-close:hover {
        opacity: 1;
    }

    :global([data-theme="dark"]) .toast {
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
</style>