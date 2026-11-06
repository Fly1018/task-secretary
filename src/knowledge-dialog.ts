import {Dialog, fetchSyncPost, getFrontend, showMessage} from "siyuan";
import type {InboxItem} from "./types";

export interface KnowledgeHost {
    i18n: Record<string, any>;
    archiveAsKnowledge(item: InboxItem, targetDocID: string): Promise<void>;
}

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: KnowledgeHost, key: string, fallback: string) =>
    String(host.i18n?.[key] ?? fallback);

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const ID_RE = /^\d{14}-[a-z0-9]{7}$/;

let lastNotebook = "";
let lastDoc = "";

export const openKnowledgeDialog = async (
    host: KnowledgeHost,
    item: InboxItem,
    onSaved: () => void,
): Promise<void> => {
    const dialog = new Dialog({
        title: t(host, "knowledgeDialogTitle", "Archive as knowledge"),
        width: getFrontend().startsWith("mobile") ? "92vw" : "500px",
        content: `<div class="b3-dialog__content ts-knowledge">
  <div class="ts-knowledge__preview-label">${escapeHtml(t(host, "knowledgePreview", "Content preview"))}</div>
  <div class="ts-knowledge__preview">${escapeHtml(item.text)}</div>
  <div class="ts-field">
    <label>${escapeHtml(t(host, "knowledgeNotebook", "Notebook"))}</label>
    <select class="b3-select fn__block" data-knowledge-notebook>
      <option value="">${escapeHtml(t(host, "knowledgeNotebookPlaceholder", "Choose a notebook"))}</option>
    </select>
  </div>
  <div class="ts-field">
    <label>${escapeHtml(t(host, "knowledgeDoc", "Target document"))}</label>
    <select class="b3-select fn__block" data-knowledge-doc disabled>
      <option value="">${escapeHtml(t(host, "knowledgeDocPlaceholder", "Choose a document"))}</option>
    </select>
    <div class="ts-knowledge__hint" data-knowledge-hint></div>
  </div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-knowledge-cancel>${escapeHtml(t(host, "cancel", "Cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-knowledge-save disabled>${escapeHtml(t(host, "knowledgeSave", "Archive"))}</button>
</div>`,
    });

    const notebookSelect = dialog.element.querySelector<HTMLSelectElement>("[data-knowledge-notebook]")!;
    const docSelect = dialog.element.querySelector<HTMLSelectElement>("[data-knowledge-doc]")!;
    const hint = dialog.element.querySelector<HTMLElement>("[data-knowledge-hint]")!;
    const saveButton = dialog.element.querySelector<HTMLButtonElement>("[data-knowledge-save]")!;

    const updateSave = () => {
        saveButton.disabled = !ID_RE.test(docSelect.value);
    };

    const loadDocs = async () => {
        const notebook = notebookSelect.value;
        docSelect.disabled = true;
        docSelect.innerHTML = `<option value="">${escapeHtml(t(host, "knowledgeDocPlaceholder", "Choose a document"))}</option>`;
        hint.textContent = "";
        updateSave();
        if (!ID_RE.test(notebook)) {
            return;
        }
        try {
            const response = await fetchSyncPost("/api/query/sql", {
                stmt: `SELECT id, hpath FROM blocks WHERE type = 'd' AND box = '${notebook}' ORDER BY hpath ASC LIMIT 500`,
            });
            if (response.code !== 0) {
                throw new Error(response.msg || `SQL error: ${response.code}`);
            }
            const docs = (response.data || []) as Array<{id: string; hpath?: string}>;
            docSelect.innerHTML = `<option value="">${escapeHtml(t(host, "knowledgeDocPlaceholder", "Choose a document"))}</option>`
                + docs.map((doc) => `<option value="${escapeHtml(doc.id)}">${escapeHtml(doc.hpath || doc.id)}</option>`).join("");
            docSelect.disabled = docs.length === 0;
            if (lastDoc && docs.some((doc) => doc.id === lastDoc)) {
                docSelect.value = lastDoc;
            }
            hint.textContent = docs.length === 0
                ? t(host, "knowledgeNoDocs", "This notebook has no documents yet.")
                : "";
            updateSave();
        } catch (error) {
            hint.textContent = t(host, "knowledgeLoadFailed", "Failed to load documents: ${msg}")
                .replace("${msg}", errorMessage(error));
        }
    };

    try {
        const response = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const data = response.data as any;
        const notebooks = ((data?.notebooks || []) as Array<{id: string; name: string; closed?: boolean}>)
            .filter((notebook) => !notebook.closed);
        notebookSelect.innerHTML = `<option value="">${escapeHtml(t(host, "knowledgeNotebookPlaceholder", "Choose a notebook"))}</option>`
            + notebooks.map((notebook) => `<option value="${escapeHtml(notebook.id)}">${escapeHtml(notebook.name)}</option>`).join("");
        if (lastNotebook && notebooks.some((notebook) => notebook.id === lastNotebook)) {
            notebookSelect.value = lastNotebook;
        }
    } catch (error) {
        showMessage(t(host, "knowledgeLoadFailed", "Failed to load documents: ${msg}")
            .replace("${msg}", errorMessage(error)), 5000, "error");
    }

    notebookSelect.addEventListener("change", () => void loadDocs());
    docSelect.addEventListener("change", updateSave);
    dialog.element.querySelector("[data-knowledge-cancel]")?.addEventListener("click", () => dialog.destroy());
    saveButton.addEventListener("click", async () => {
        const docID = docSelect.value;
        if (!ID_RE.test(docID)) {
            showMessage(t(host, "knowledgeNoDoc", "Choose a target document."), 4000, "error");
            return;
        }
        saveButton.disabled = true;
        try {
            await host.archiveAsKnowledge(item, docID);
            lastNotebook = notebookSelect.value;
            lastDoc = docID;
            dialog.destroy();
            showMessage(t(host, "knowledgeSaved", "Archived to the selected document."), 3000);
            onSaved();
        } catch (error) {
            showMessage(t(host, "knowledgeFailed", "Failed to archive: ${msg}")
                .replace("${msg}", errorMessage(error)), 6000, "error");
            saveButton.disabled = false;
        }
    });

    if (notebookSelect.value) {
        await loadDocs();
    }
};
