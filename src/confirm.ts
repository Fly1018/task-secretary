import {Dialog, getFrontend} from "siyuan";

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger?: boolean;
}

/** Plugin-styled confirmation dialog. Resolves false when the dialog is closed without confirming. */
export const confirmDialog = (options: ConfirmOptions): Promise<boolean> => new Promise((resolve) => {
    let settled = false;
    let dialog: Dialog | undefined;
    const finish = (value: boolean) => {
        if (settled) {
            return;
        }
        settled = true;
        resolve(value);
        dialog?.destroy();
    };
    dialog = new Dialog({
        title: options.title,
        content: `<div class="b3-dialog__content ts-confirm">
  <div class="ts-confirm__message">${escapeHtml(options.message)}</div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-confirm-cancel>${escapeHtml(options.cancelLabel)}</button>
  <div class="fn__space"></div>
  <button class="b3-button ${options.danger === false ? "b3-button--text" : "b3-button--remove"}" data-confirm-ok>${escapeHtml(options.confirmLabel)}</button>
</div>`,
        width: getFrontend().startsWith("mobile") ? "92vw" : "420px",
        destroyCallback: () => {
            if (!settled) {
                settled = true;
                resolve(false);
            }
        },
    });
    dialog.element.querySelector("[data-confirm-cancel]")?.addEventListener("click", () => finish(false));
    dialog.element.querySelector("[data-confirm-ok]")?.addEventListener("click", () => finish(true));
});
