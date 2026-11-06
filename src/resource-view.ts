import {openTab} from "siyuan";
import type {GtdQuadrant, InboxItem} from "./types";
import type {NextActionCandidate} from "./task-store";
import {openClarifyDialog} from "./clarify-dialog";
import {openKnowledgeDialog} from "./knowledge-dialog";

export type ResourceKind = "knowledge" | "cold";

export interface ResourceViewHost {
    i18n: Record<string, any>;
    app?: any;
    getKnowledgeItems(): Promise<InboxItem[]>;
    getColdItems(): Promise<InboxItem[]>;
    getNextActionCandidate(id: string): Promise<NextActionCandidate>;
    clarifyItem(item: InboxItem, quadrant: GtdQuadrant, nextAction?: string): Promise<void>;
    archiveAsKnowledge(item: InboxItem, targetDocID: string): Promise<void>;
}

export interface ResourceView {
    refresh(): Promise<void>;
    destroy(): void;
}

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: ResourceViewHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const cleanText = (item: InboxItem): string =>
    item.text.replace(/\s*@(?:GTD|知识|阅读|以后)(?=\s|$|[，。；、,.!?])/gi, " ").replace(/\s{2,}/g, " ").trim() || item.text;

const sourceLabel = (host: ResourceViewHost, item: InboxItem): string => {
    if (item.source === "daily") {
        return t(host, "inboxSourceDaily", "Daily note");
    }
    if (item.source === "custom") {
        return t(host, "inboxSourceCustom", "Specified");
    }
    return t(host, "inboxSourceTask", "Legacy task");
};

const triggerLabel = (host: ResourceViewHost, item: InboxItem, kind: ResourceKind): string => {
    if (item.cold && kind === "cold") {
        return t(host, "coldTriggerCold", "Cold storage");
    }
    if (item.trigger === "knowledge") {
        return t(host, "knowledgeTrigger", "Knowledge");
    }
    if (item.trigger === "read") {
        return t(host, "coldTriggerRead", "Read later");
    }
    if (item.trigger === "later") {
        return t(host, "coldTriggerLater", "Later");
    }
    return t(host, "coldTriggerCold", "Cold storage");
};

const ageText = (host: ResourceViewHost, item: InboxItem): string => {
    if (item.ageHours < 1) {
        return t(host, "resourceAgeNow", "Just now");
    }
    if (item.ageHours < 24) {
        return t(host, "resourceAgeHours", "${hours} hours ago", {hours: Math.floor(item.ageHours)});
    }
    return t(host, "resourceAge", "${days} days ago", {days: Math.floor(item.ageHours / 24)});
};

const card = (host: ResourceViewHost, item: InboxItem, kind: ResourceKind) => {
    const actions = kind === "knowledge"
        ? `<button class="ts-inbox__action ts-inbox__action--primary" data-resource-archive="${item.id}">${escapeHtml(t(host, "knowledgeSave", "Archive"))}</button>`
        : `<button class="ts-inbox__action ts-inbox__action--primary" data-resource-arrange="${item.id}">${escapeHtml(t(host, "coldArrange", "Arrange"))}</button>
           <button class="ts-inbox__action" data-resource-archive="${item.id}">${escapeHtml(t(host, "knowledgeSave", "Archive"))}</button>`;
    return `<article class="ts-inbox__item ts-inbox__item--resource" data-resource-id="${item.id}">
  <div class="ts-inbox__body">
    <div class="ts-inbox__text" data-resource-open="${item.id}">${escapeHtml(cleanText(item))}</div>
    <div class="ts-inbox__meta">
      <span class="ts-resource__trigger">${escapeHtml(triggerLabel(host, item, kind))}</span>
      <span class="ts-inbox__source ts-inbox__source--${item.source}">${escapeHtml(sourceLabel(host, item))}</span>
      <span class="ts-inbox__age">${escapeHtml(ageText(host, item))}</span>
    </div>
  </div>
  <div class="ts-inbox__actions">${actions}</div>
</article>`;
};

export const mountResourceView = (
    kind: ResourceKind,
    host: ResourceViewHost,
    container: HTMLElement,
): ResourceView => {
    let items: InboxItem[] = [];
    let destroyed = false;

    const getItems = () => kind === "knowledge" ? host.getKnowledgeItems() : host.getColdItems();

    const render = () => {
        if (destroyed) {
            return;
        }
        const title = kind === "knowledge"
            ? t(host, "knowledgeTitle", "Knowledge to archive")
            : t(host, "coldTitle", "Cold storage");
        const summary = kind === "knowledge"
            ? t(host, "knowledgeSummary", "${count} items waiting to be archived", {count: items.length})
            : t(host, "coldSummary", "${count} items parked here", {count: items.length});
        const emptyTitle = kind === "knowledge"
            ? t(host, "knowledgeEmptyTitle", "No knowledge waiting")
            : t(host, "coldEmptyTitle", "Cold storage is empty");
        const emptyHint = kind === "knowledge"
            ? t(host, "knowledgeEmptyHint", "Write @知识 in a daily note to send something here.")
            : t(host, "coldEmptyHint", "Write @阅读 or @以后 in a daily note, or use Cold storage in the inbox.");
        container.innerHTML = `<div class="ts-inbox">
  <div class="ts-inbox__head">
    <div class="ts-inbox__heading">
      <div class="ts-inbox__title">${escapeHtml(title)}</div>
      <div class="ts-inbox__summary">${escapeHtml(summary)}</div>
    </div>
  </div>
  ${items.length > 0
        ? `<div class="ts-inbox__list">${items.map((item) => card(host, item, kind)).join("")}</div>`
        : `<div class="ts-empty ts-inbox__empty">
  <div class="ts-inbox__empty-title">${escapeHtml(emptyTitle)}</div>
  <div>${escapeHtml(emptyHint)}</div>
</div>`}
</div>`;
    };

    const onClick = async (event: Event) => {
        const target = event.target as HTMLElement;
        const arrangeButton = target.closest<HTMLElement>("[data-resource-arrange]");
        if (arrangeButton) {
            const item = items.find((entry) => entry.id === arrangeButton.dataset.resourceArrange);
            if (!item) {
                return;
            }
            arrangeButton.setAttribute("disabled", "true");
            try {
                await openClarifyDialog(host, item, () => void refresh());
            } finally {
                arrangeButton.removeAttribute("disabled");
            }
            return;
        }
        const archiveButton = target.closest<HTMLElement>("[data-resource-archive]");
        if (archiveButton) {
            const item = items.find((entry) => entry.id === archiveButton.dataset.resourceArchive);
            if (!item) {
                return;
            }
            archiveButton.setAttribute("disabled", "true");
            try {
                await openKnowledgeDialog(host, item, () => void refresh());
            } finally {
                archiveButton.removeAttribute("disabled");
            }
            return;
        }
        const openTarget = target.closest<HTMLElement>("[data-resource-open]");
        if (openTarget && host.app) {
            openTab({app: host.app, doc: {id: openTarget.dataset.resourceOpen, action: ["cb-get-focus", "cb-get-hl"]}});
        }
    };

    const refresh = async () => {
        try {
            items = await getItems();
            render();
        } catch (error) {
            if (!destroyed) {
                container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "resourceLoadFailed", "Failed to load: ${msg}", {msg: errorMessage(error)}))}</div>`;
            }
        }
    };

    const onExternalChange = () => {
        void refresh();
    };

    container.addEventListener("click", onClick);
    window.addEventListener("task-secretary-tasks-changed", onExternalChange);
    window.addEventListener("task-secretary-inbox-changed", onExternalChange);
    window.addEventListener("task-secretary-resources-changed", onExternalChange);
    container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "loading", "Loading…"))}</div>`;
    void refresh();

    return {
        refresh,
        destroy: () => {
            destroyed = true;
            container.removeEventListener("click", onClick);
            window.removeEventListener("task-secretary-tasks-changed", onExternalChange);
            window.removeEventListener("task-secretary-inbox-changed", onExternalChange);
            window.removeEventListener("task-secretary-resources-changed", onExternalChange);
            container.innerHTML = "";
        },
    };
};
