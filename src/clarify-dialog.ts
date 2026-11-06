import {Dialog, getFrontend, showMessage} from "siyuan";
import type {GtdQuadrant, InboxItem} from "./types";
import type {NextActionCandidate} from "./task-store";

export interface ClarifyHost {
    i18n: Record<string, any>;
    getNextActionCandidate(id: string): Promise<NextActionCandidate>;
    clarifyItem(item: InboxItem, quadrant: GtdQuadrant, nextAction?: string): Promise<void>;
}

const QUADRANTS: Array<{key: GtdQuadrant; label: string; fallback: string; tag: string; tagFallback: string; desc: string; descFallback: string}> = [
    {
        key: "q1",
        label: "quadrantQ1",
        fallback: "Important & urgent",
        tag: "quadrantQ1Tag",
        tagFallback: "Do now",
        desc: "clarifyQ1Desc",
        descFallback: "Do it now; it is important and time-sensitive.",
    },
    {
        key: "q2",
        label: "quadrantQ2",
        fallback: "Important, not urgent",
        tag: "quadrantQ2Tag",
        tagFallback: "Schedule",
        desc: "clarifyQ2Desc",
        descFallback: "Schedule a time block; this is where long-term value lives.",
    },
    {
        key: "q3",
        label: "quadrantQ3",
        fallback: "Not important, urgent",
        tag: "quadrantQ3Tag",
        tagFallback: "Delegate",
        desc: "clarifyQ3Desc",
        descFallback: "Handle quickly, delegate, or batch it.",
    },
    {
        key: "q4",
        label: "quadrantQ4",
        fallback: "Not important, not urgent",
        tag: "quadrantQ4Tag",
        tagFallback: "Do less",
        desc: "clarifyQ4Desc",
        descFallback: "Park it or drop it; do not let it crowd the important work.",
    },
];

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: ClarifyHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export const openClarifyDialog = async (
    host: ClarifyHost,
    item: InboxItem,
    onSaved: () => void,
): Promise<void> => {
    let selected: GtdQuadrant | undefined;
    let candidate: NextActionCandidate | undefined;
    const dialog = new Dialog({
        title: t(host, "clarifyTitle", "Clarify item"),
        width: getFrontend().startsWith("mobile") ? "92vw" : "540px",
        content: `<div class="b3-dialog__content ts-clarify">
  <div class="ts-clarify__original-label">${escapeHtml(t(host, "clarifyOriginal", "Original capture"))}</div>
  <div class="ts-clarify__original">${escapeHtml(item.text)}</div>
  <div class="ts-field">
    <label>${escapeHtml(t(host, "clarifyNextAction", "Next action"))}</label>
    <input class="b3-text-field fn__block" data-clarify-action value="${escapeHtml(t(host, "loading", "Loading…"))}" disabled>
    <div class="ts-clarify__hint" data-clarify-hint></div>
  </div>
  <div class="ts-field">
    <label>${escapeHtml(t(host, "clarifyQuadrant", "Quadrant (required)"))}</label>
    <div class="ts-clarify__quadrants">
      ${QUADRANTS.map((quadrant) => `<button type="button" class="ts-clarify__quad ts-clarify__quad--${quadrant.key}" data-clarify-quadrant="${quadrant.key}">
        <span class="ts-clarify__quad-head"><span class="ts-clarify__dot"></span><span>${escapeHtml(t(host, quadrant.label, quadrant.fallback))}</span><span class="ts-clarify__tag">${escapeHtml(t(host, quadrant.tag, quadrant.tagFallback))}</span></span>
        <span class="ts-clarify__quad-desc">${escapeHtml(t(host, quadrant.desc, quadrant.descFallback))}</span>
      </button>`).join("")}
    </div>
  </div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-clarify-cancel>${escapeHtml(t(host, "cancel", "Cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-clarify-save disabled>${escapeHtml(t(host, "clarifySave", "Clarify"))}</button>
</div>`,
    });

    const actionInput = dialog.element.querySelector<HTMLInputElement>("[data-clarify-action]")!;
    const hint = dialog.element.querySelector<HTMLElement>("[data-clarify-hint]")!;
    const saveButton = dialog.element.querySelector<HTMLButtonElement>("[data-clarify-save]")!;
    const quadButtons = [...dialog.element.querySelectorAll<HTMLElement>("[data-clarify-quadrant]")];

    try {
        candidate = await host.getNextActionCandidate(item.id);
        actionInput.value = candidate.text;
        actionInput.disabled = false;
        actionInput.readOnly = candidate.hasChildren;
        hint.textContent = candidate.hasChildren
            ? t(host, "clarifyMultiStepHint", "Using the first unfinished child block. Completing the card advances to the next child.")
            : t(host, "clarifySingleStepHint", "Single-step task; you can adjust the next action text.");
    } catch (error) {
        showMessage(t(host, "clarifyLoadFailed", "Failed to load the next action: ${msg}", {msg: errorMessage(error)}), 6000, "error");
        actionInput.value = item.text;
        actionInput.disabled = false;
        hint.textContent = t(host, "clarifySingleStepHint", "Single-step task; you can adjust the next action text.");
    }

    const updateSave = () => {
        saveButton.disabled = !selected;
    };

    quadButtons.forEach((button) => {
        button.addEventListener("click", () => {
            selected = button.dataset.clarifyQuadrant as GtdQuadrant;
            quadButtons.forEach((itemButton) => itemButton.classList.toggle("ts-clarify__quad--active", itemButton === button));
            updateSave();
        });
    });

    dialog.element.querySelector("[data-clarify-cancel]")?.addEventListener("click", () => dialog.destroy());
    saveButton.addEventListener("click", async () => {
        if (!selected) {
            showMessage(t(host, "clarifyQuadrantRequired", "Choose a quadrant before clarifying."), 4000, "error");
            return;
        }
        const action = actionInput.value.trim();
        saveButton.disabled = true;
        try {
            await host.clarifyItem(item, selected, candidate?.hasChildren ? undefined : action);
            dialog.destroy();
            onSaved();
        } catch (error) {
            showMessage(t(host, "clarifyFailed", "Failed to clarify: ${msg}", {msg: errorMessage(error)}), 6000, "error");
            saveButton.disabled = false;
        }
    });
};
