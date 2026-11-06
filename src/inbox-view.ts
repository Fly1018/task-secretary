import {openTab, showMessage} from "siyuan";
import type {GtdQuadrant, InboxItem} from "./types";
import type {NextActionCandidate} from "./task-store";
import {openClarifyDialog} from "./clarify-dialog";
import {openKnowledgeDialog} from "./knowledge-dialog";

export interface InboxViewHost {
    i18n: Record<string, any>;
    app?: any;
    getInbox(): Promise<InboxItem[]>;
    getColdItems(): Promise<InboxItem[]>;
    getNextActionCandidate(id: string): Promise<NextActionCandidate>;
    clarifyItem(item: InboxItem, quadrant: GtdQuadrant, nextAction?: string): Promise<void>;
    archiveAsKnowledge(item: InboxItem, targetDocID: string): Promise<void>;
    coldItem(item: InboxItem): Promise<void>;
    openFullscreen?(): void;
}

export interface InboxView {
    refresh(): Promise<void>;
    destroy(): void;
}

type InboxFilter = "all" | "daily" | "custom" | "task" | "cold";

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: InboxViewHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const ageLevel = (item: InboxItem): "new" | "warn" | "late" => {
    if (item.ageHours >= 48) {
        return "late";
    }
    if (item.ageHours >= 24) {
        return "warn";
    }
    return "new";
};

const ageLabel = (host: InboxViewHost, item: InboxItem): string => {
    const level = ageLevel(item);
    if (level === "late") {
        return t(host, "inboxAgeLate", "Waiting ${days} days", {days: Math.floor(item.ageHours / 24)});
    }
    if (level === "warn") {
        return t(host, "inboxAgeWarn", "Waiting ${hours} hours", {hours: Math.floor(item.ageHours)});
    }
    return t(host, "inboxAgeNew", "New capture");
};

const cleanInboxText = (text: string): string =>
    text.replace(/\s*@(?:GTD|知识|阅读|以后)(?=\s|$|[，。；、,.!?])/gi, " ").replace(/\s{2,}/g, " ").trim() || text;

const coldTriggerLabel = (host: InboxViewHost, item: InboxItem): string => {
    if (item.cold) {
        return t(host, "coldTriggerCold", "Cold storage");
    }
    if (item.trigger === "read") {
        return t(host, "coldTriggerRead", "Read later");
    }
    if (item.trigger === "later") {
        return t(host, "coldTriggerLater", "Later");
    }
    return t(host, "coldTriggerCold", "Cold storage");
};

const neutralAgeLabel = (host: InboxViewHost, item: InboxItem): string => {
    if (item.ageHours < 1) {
        return t(host, "resourceAgeNow", "Just now");
    }
    if (item.ageHours < 24) {
        return t(host, "resourceAgeHours", "${hours} hours ago", {hours: Math.floor(item.ageHours)});
    }
    return t(host, "resourceAge", "${days} days ago", {days: Math.floor(item.ageHours / 24)});
};

const coldCard = (host: InboxViewHost, item: InboxItem) => {
    const sourceLabel = item.source === "daily"
        ? t(host, "inboxSourceDaily", "Daily note")
        : item.source === "custom"
            ? t(host, "inboxSourceCustom", "Specified")
            : t(host, "inboxSourceTask", "Legacy task");
    return `<article class="ts-inbox__item ts-inbox__item--resource" data-inbox-id="${item.id}">
  <div class="ts-inbox__body">
    <div class="ts-inbox__text" data-inbox-open="${item.id}">${escapeHtml(cleanInboxText(item.text))}</div>
    <div class="ts-inbox__meta">
      <span class="ts-resource__trigger">${escapeHtml(coldTriggerLabel(host, item))}</span>
      <span class="ts-inbox__source ts-inbox__source--${item.source}">${escapeHtml(sourceLabel)}</span>
      <span class="ts-inbox__age">${escapeHtml(neutralAgeLabel(host, item))}</span>
    </div>
  </div>
  <div class="ts-inbox__actions">
    <button class="ts-inbox__action ts-inbox__action--primary" data-inbox-cold-arrange="${item.id}">${escapeHtml(t(host, "coldArrange", "Arrange"))}</button>
    <button class="ts-inbox__action" data-inbox-cold-archive="${item.id}">${escapeHtml(t(host, "knowledgeSave", "Archive"))}</button>
  </div>
</article>`;
};

const itemHints = (host: InboxViewHost, item: InboxItem): string => {
    const hints: string[] = [];
    if (/https?:\/\//i.test(item.text)) {
        hints.push(`<span class="ts-inbox__hint" title="${escapeHtml(t(host, "inboxHintRead", "Looks like something to read later"))}">🔖</span>`);
    }
    if (item.text.length >= 80) {
        hints.push(`<span class="ts-inbox__hint" title="${escapeHtml(t(host, "inboxHintKnowledge", "Looks like reference material"))}">📖</span>`);
    }
    return hints.join("");
};

const itemCard = (host: InboxViewHost, item: InboxItem) => {
    const level = ageLevel(item);
    const sourceLabel = item.source === "daily"
        ? t(host, "inboxSourceDaily", "Daily note")
        : item.source === "custom"
            ? t(host, "inboxSourceCustom", "Specified")
            : t(host, "inboxSourceTask", "Legacy task");
    return `<article class="ts-inbox__item ts-inbox__item--${level}" data-inbox-id="${item.id}">
  <div class="ts-inbox__body">
    <div class="ts-inbox__text" data-inbox-open="${item.id}">${escapeHtml(item.text)}</div>
    <div class="ts-inbox__meta">
      <span class="ts-inbox__source ts-inbox__source--${item.source}">${escapeHtml(sourceLabel)}</span>
      <span class="ts-inbox__age">${escapeHtml(ageLabel(host, item))}</span>
      ${itemHints(host, item)}
    </div>
  </div>
  <div class="ts-inbox__actions">
    <button class="ts-inbox__action ts-inbox__action--primary" data-inbox-clarify="${item.id}">${escapeHtml(t(host, "inboxClarify", "Plan"))}</button>
    <button class="ts-inbox__action" data-inbox-knowledge="${item.id}">${escapeHtml(t(host, "inboxKnowledge", "Knowledge"))}</button>
    <button class="ts-inbox__action" data-inbox-cold="${item.id}">${escapeHtml(t(host, "inboxCold", "Cold"))}</button>
  </div>
</article>`;
};

export const mountInboxView = (host: InboxViewHost, container: HTMLElement): InboxView => {
    let items: InboxItem[] = [];
    let coldItems: InboxItem[] = [];
    let filter: InboxFilter = "all";
    let destroyed = false;

    const filtered = () => {
        if (filter === "cold") {
            return coldItems;
        }
        return filter === "all" ? items : items.filter((item) => item.source === filter);
    };

    const render = () => {
        if (destroyed) {
            return;
        }
        const visible = filtered();
        const counts = {
            all: items.length,
            daily: items.filter((item) => item.source === "daily").length,
            custom: items.filter((item) => item.source === "custom").length,
            task: items.filter((item) => item.source === "task").length,
            cold: coldItems.length,
        };
        const filterButton = (key: InboxFilter, label: string) =>
            `<button class="ts-inbox__filter${filter === key ? " ts-inbox__filter--active" : ""}" data-inbox-filter="${key}">${escapeHtml(label)} <span>${counts[key]}</span></button>`;
        container.innerHTML = `<div class="ts-inbox">
  <div class="ts-inbox__head">
    <div class="ts-inbox__heading">
      <div class="ts-inbox__title">${escapeHtml(t(host, "tabInbox", "Inbox"))}</div>
      <div class="ts-inbox__summary">${escapeHtml(filter === "cold"
        ? t(host, "inboxSummaryCold", "${count} items in cold storage", {count: coldItems.length})
        : t(host, "inboxSummary", "${count} items waiting to be planned", {count: items.length}))}</div>
    </div>
  </div>
  <div class="ts-inbox__filters">
    ${filterButton("all", t(host, "inboxFilterAll", "All"))}
    ${filterButton("daily", t(host, "inboxFilterDaily", "Daily"))}
    ${filterButton("custom", t(host, "inboxFilterCustom", "Specified"))}
    ${counts.task > 0 ? filterButton("task", t(host, "inboxFilterTask", "Legacy")) : ""}
    ${counts.cold > 0 ? filterButton("cold", t(host, "inboxFilterCold", "Cold")) : ""}
  </div>
  ${visible.length > 0
        ? `<div class="ts-inbox__list">${visible.map((item) => filter === "cold" ? coldCard(host, item) : itemCard(host, item)).join("")}</div>`
        : `<div class="ts-empty ts-inbox__empty">
  <div class="ts-inbox__empty-title">${escapeHtml(t(host, "inboxEmptyTitle", "Inbox is clear"))}</div>
  <div>${escapeHtml(t(host, "inboxEmptyHint", "Write @GTD in today's daily note to capture something new."))}</div>
</div>`}
  <div class="ts-inbox__capture-hint">${escapeHtml(t(host, "inboxCaptureHint", "Capture: - [ ] what to do @GTD"))}</div>
</div>`;
    };

    const onClick = async (event: Event) => {
        const target = event.target as HTMLElement;
        const filterButton = target.closest<HTMLElement>("[data-inbox-filter]");
        if (filterButton) {
            filter = (filterButton.dataset.inboxFilter || "all") as InboxFilter;
            render();
            return;
        }
        const clarifyButton = target.closest<HTMLElement>("[data-inbox-clarify]");
        if (clarifyButton) {
            const id = clarifyButton.dataset.inboxClarify;
            const item = items.find((entry) => entry.id === id);
            if (!item) {
                return;
            }
            clarifyButton.setAttribute("disabled", "true");
            try {
                await openClarifyDialog(host, item, () => {
                    void refresh();
                });
            } finally {
                clarifyButton.removeAttribute("disabled");
            }
            return;
        }
        const coldArrange = target.closest<HTMLElement>("[data-inbox-cold-arrange]");
        if (coldArrange) {
            const item = coldItems.find((entry) => entry.id === coldArrange.dataset.inboxColdArrange);
            if (!item) {
                return;
            }
            coldArrange.setAttribute("disabled", "true");
            try {
                await openClarifyDialog(host, item, () => void refresh());
            } finally {
                coldArrange.removeAttribute("disabled");
            }
            return;
        }
        const coldArchive = target.closest<HTMLElement>("[data-inbox-cold-archive]");
        if (coldArchive) {
            const item = coldItems.find((entry) => entry.id === coldArchive.dataset.inboxColdArchive);
            if (!item) {
                return;
            }
            coldArchive.setAttribute("disabled", "true");
            try {
                await openKnowledgeDialog(host, item, () => void refresh());
            } finally {
                coldArchive.removeAttribute("disabled");
            }
            return;
        }
        const knowledgeButton = target.closest<HTMLElement>("[data-inbox-knowledge]");
        if (knowledgeButton) {
            const item = items.find((entry) => entry.id === knowledgeButton.dataset.inboxKnowledge);
            if (!item) {
                return;
            }
            knowledgeButton.setAttribute("disabled", "true");
            try {
                await openKnowledgeDialog(host, item, () => void refresh());
            } finally {
                knowledgeButton.removeAttribute("disabled");
            }
            return;
        }
        const coldButton = target.closest<HTMLElement>("[data-inbox-cold]");
        if (coldButton) {
            const item = items.find((entry) => entry.id === coldButton.dataset.inboxCold);
            if (!item) {
                return;
            }
            coldButton.setAttribute("disabled", "true");
            try {
                await host.coldItem(item);
                await refresh();
                showMessage(t(host, "inboxColdDone", "Moved to cold storage."), 3000);
            } catch (error) {
                showMessage(t(host, "inboxColdFailed", "Failed to move to cold storage: ${msg}", {msg: errorMessage(error)}), 6000, "error");
            } finally {
                coldButton.removeAttribute("disabled");
            }
            return;
        }
        const openTarget = target.closest<HTMLElement>("[data-inbox-open]");
        const openID = openTarget?.dataset.inboxOpen;
        if (openID && host.app) {
            openTab({app: host.app, doc: {id: openID, action: ["cb-get-focus", "cb-get-hl"]}});
        }
    };

    const refresh = async () => {
        try {
            const [inbox, cold] = await Promise.all([
                host.getInbox(),
                host.getColdItems().catch(() => [] as InboxItem[]),
            ]);
            items = inbox;
            coldItems = cold;
            render();
        } catch (error) {
            if (!destroyed) {
                container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "inboxLoadFailed", "Failed to load the inbox: ${msg}", {msg: errorMessage(error)}))}</div>`;
            }
        }
    };

    const onExternalChange = () => {
        void refresh();
    };

    container.addEventListener("click", onClick);
    window.addEventListener("task-secretary-tasks-changed", onExternalChange);
    window.addEventListener("task-secretary-inbox-changed", onExternalChange);
    container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "loading", "Loading…"))}</div>`;
    void refresh();

    return {
        refresh,
        destroy: () => {
            destroyed = true;
            container.removeEventListener("click", onClick);
            window.removeEventListener("task-secretary-tasks-changed", onExternalChange);
            window.removeEventListener("task-secretary-inbox-changed", onExternalChange);
            container.innerHTML = "";
        },
    };
};
