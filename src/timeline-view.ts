import {openTab, showMessage} from "siyuan";
import type {GtdQuadrant, Task} from "./types";
import type {CompleteResult} from "./task-store";
import {dateKey, shiftDateKey} from "./habit-store";

export interface TimelineViewHost {
    i18n: Record<string, any>;
    app?: any;
    getTasks(): Promise<Task[]>;
    completeNextAction(task: Task): Promise<CompleteResult>;
    deleteTask(task: Task): Promise<void>;
    editTask?(task: Task): void;
    startTaskPomodoro?(task: Task, options?: {completeNext?: boolean}): void;
    setPlanBlock(task: Task, date: string, start: string, end: string): Promise<void>;
    clearPlanBlock(task: Task): Promise<void>;
    openScreening?(): void;
}

export interface TimelineView {
    refresh(): Promise<void>;
    showDate(date: string): void;
    destroy(): void;
}

const DAY_START = 6 * 60;
const DAY_END = 24 * 60;
const PX_PER_MINUTE = 0.9;
const SNAP_MINUTES = 15;
const DEFAULT_DURATION = 60;

const QUADRANTS: Array<{key: GtdQuadrant; label: string; fallback: string}> = [
    {key: "q1", label: "quadrantQ1", fallback: "Important & urgent"},
    {key: "q2", label: "quadrantQ2", fallback: "Important, not urgent"},
    {key: "q3", label: "quadrantQ3", fallback: "Not important, urgent"},
    {key: "q4", label: "quadrantQ4", fallback: "Not important, not urgent"},
];

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: TimelineViewHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const pad = (value: number) => String(value).padStart(2, "0");

const parseClock = (value: string | undefined): number | undefined => {
    const match = String(value || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
};

const formatClock = (minutes: number): string =>
    `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

const snap = (minutes: number): number =>
    Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;

const clampStart = (minutes: number, duration: number): number =>
    Math.max(DAY_START, Math.min(DAY_END - duration, snap(minutes)));

const todayKey = () => dateKey();

const dateLabel = (host: TimelineViewHost, date: string): string => {
    if (date === todayKey()) {
        return `${t(host, "timelineToday", "Today")} · ${date}`;
    }
    if (date === shiftDateKey(todayKey(), 1)) {
        return `${t(host, "timelineTomorrow", "Tomorrow")} · ${date}`;
    }
    return date;
};

interface BlockInfo {
    task: Task;
    start: number;
    end: number;
    lane: number;
    lanes: number;
}

const buildBlocks = (tasks: Task[], date: string): BlockInfo[] => {
    const blocks: BlockInfo[] = [];
    tasks.forEach((task) => {
        if (task.planDate !== date) {
            return;
        }
        const start = parseClock(task.planStart);
        const end = parseClock(task.planEnd);
        if (start === undefined || end === undefined || end <= start) {
            return;
        }
        blocks.push({task, start, end, lane: 0, lanes: 1});
    });
    blocks.sort((a, b) => a.start - b.start || b.end - a.end);
    const laneEnds: number[] = [];
    blocks.forEach((block) => {
        let lane = laneEnds.findIndex((end) => end <= block.start);
        if (lane < 0) {
            lane = laneEnds.length;
            laneEnds.push(block.end);
        } else {
            laneEnds[lane] = block.end;
        }
        block.lane = lane;
    });
    const laneCount = Math.max(1, laneEnds.length);
    blocks.forEach((block) => {
        block.lanes = laneCount;
    });
    return blocks;
};

const blockMarkup = (host: TimelineViewHost, block: BlockInfo) => {
    const task = block.task;
    const top = (block.start - DAY_START) * PX_PER_MINUTE;
    const height = Math.max(32, (block.end - block.start) * PX_PER_MINUTE);
    const width = 100 / block.lanes;
    const left = block.lane * width;
    const quadrant = task.quadrant || "q4";
    const nextAction = task.nextAction && task.nextAction !== task.title ? task.nextAction : "";
    return `<div class="ts-tb__block ts-tb__block--${quadrant}" style="top:${top}px;height:${height}px;left:calc(${left}% + 5px);width:calc(${width}% - 10px)" data-tb-block="${task.id}">
  <div class="ts-tb__block-time">${formatClock(block.start)}–${formatClock(block.end)}</div>
  <div class="ts-tb__block-title" data-tb-open="${task.id}">${escapeHtml(task.title)}</div>
  ${nextAction && height >= 52 ? `<div class="ts-tb__block-next">↳ ${escapeHtml(nextAction)}</div>` : ""}
  <div class="ts-tb__block-actions">
    <button data-tb-action="complete" title="${escapeHtml(t(host, "quadrantCompleteNext", "Complete next step"))}">✓</button>
    <button data-tb-action="pomodoro" title="${escapeHtml(t(host, "pomodoroStart", "Start pomodoro"))}">🍅</button>
    <button data-tb-action="unplan" title="${escapeHtml(t(host, "timelineUnplan", "Remove from timeline"))}">×</button>
  </div>
</div>`;
};

const railItem = (host: TimelineViewHost, task: Task) => {
    const nextAction = task.nextAction && task.nextAction !== task.title ? task.nextAction : "";
    const due = task.dueDate
        ? t(host, "timelineDueOn", "Due ${date}", {date: `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}`})
        : t(host, "timelineNoDue", "No due date");
    return `<div class="ts-tb__rail-item" draggable="true" data-tb-rail="${task.id}" title="${escapeHtml(task.title)}">
  <div class="ts-tb__rail-title">${escapeHtml(task.title)}</div>
  ${nextAction ? `<div class="ts-tb__rail-next">↳ ${escapeHtml(nextAction)}</div>` : ""}
  <div class="ts-tb__rail-meta">${escapeHtml(due)}</div>
</div>`;
};

export const mountTimelineView = (host: TimelineViewHost, container: HTMLElement): TimelineView => {
    let tasks: Task[] = [];
    let selectedDate = todayKey();
    let selectedRailID = "";
    let destroyed = false;

    const executionTasks = () => tasks.filter((task) => task.clarified && !task.archived && task.type === "task");

    const render = () => {
        if (destroyed) {
            return;
        }
        const all = executionTasks();
        const blocks = buildBlocks(all, selectedDate);
        const plannedIds = new Set(all
            .filter((task) => task.planDate && task.planStart && task.planEnd)
            .map((task) => task.id));
        const rail = all
            .filter((task) => !plannedIds.has(task.id))
            .sort((a, b) => a.priority - b.priority || (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.title.localeCompare(b.title));
        const canvasHeight = (DAY_END - DAY_START) * PX_PER_MINUTE;

        const hours = Array.from({length: DAY_END / 60 - DAY_START / 60 + 1}, (_, index) => DAY_START / 60 + index)
            .map((hour) => {
                const top = (hour * 60 - DAY_START) * PX_PER_MINUTE;
                const label = hour < 24 ? `${pad(hour)}:00` : "";
                return `<div class="ts-tb__hour" style="top:${top}px">${label ? `<span>${label}</span>` : ""}</div>`;
            }).join("");

        const railGroups = QUADRANTS.map((quadrant) => ({
            ...quadrant,
            items: rail.filter((task) => task.quadrant === quadrant.key),
        })).filter((group) => group.items.length > 0);
        const unclassified = rail.filter((task) => !task.quadrant);
        const railHtml = rail.length > 0
            ? `${railGroups.map((group) => `<div class="ts-tb__rail-group">
    <div class="ts-tb__rail-group-head"><span class="ts-tb__quad-dot ts-tb__quad-dot--${group.key}"></span>${escapeHtml(t(host, group.label, group.fallback))}<span>${group.items.length}</span></div>
    ${group.items.map((task) => railItem(host, task)).join("")}
  </div>`).join("")}${unclassified.length > 0 ? `<div class="ts-tb__rail-group">
    <div class="ts-tb__rail-group-head">${escapeHtml(t(host, "timelineUnsorted", "Unsorted"))}<span>${unclassified.length}</span></div>
    ${unclassified.map((task) => railItem(host, task)).join("")}
  </div>` : ""}`
            : `<div class="ts-tb__rail-empty">${escapeHtml(t(host, "timelineRailEmpty", "Everything is scheduled."))}</div>`;

        container.innerHTML = `<div class="ts-tb" data-tb-date="${selectedDate}">
  <div class="ts-tb__head">
    <button class="ts-plan__nav" data-tb-nav="-1" title="${escapeHtml(t(host, "timelinePrevDay", "Previous day"))}" aria-label="${escapeHtml(t(host, "timelinePrevDay", "Previous day"))}">‹</button>
    <div class="ts-plan__date">${escapeHtml(dateLabel(host, selectedDate))}</div>
    <button class="ts-plan__nav" data-tb-nav="1" title="${escapeHtml(t(host, "timelineNextDay", "Next day"))}" aria-label="${escapeHtml(t(host, "timelineNextDay", "Next day"))}">›</button>
  </div>
  <div class="ts-tb__quick">
    <button class="ts-plan__quick-btn${selectedDate === todayKey() ? " ts-plan__quick-btn--active" : ""}" data-tb-today>${escapeHtml(t(host, "timelineToday", "Today"))}</button>
    <button class="ts-plan__quick-btn${selectedDate === shiftDateKey(todayKey(), 1) ? " ts-plan__quick-btn--active" : ""}" data-tb-tomorrow>${escapeHtml(t(host, "timelineTomorrow", "Tomorrow"))}</button>
    <span class="ts-tb__summary">${escapeHtml(t(host, "timelineBlockCount", "${count} time blocks", {count: blocks.length}))}</span>
    ${host.openScreening ? `<button class="ts-tb__screen" data-tb-screen title="${escapeHtml(t(host, "screeningOpen", "Present"))}">▶ ${escapeHtml(t(host, "screeningOpen", "Present"))}</button>` : ""}
  </div>
  <div class="ts-tb__body">
    <aside class="ts-tb__rail">
      <div class="ts-tb__rail-head">${escapeHtml(t(host, "timelineRailTitle", "To schedule"))}<span>${rail.length}</span></div>
      <div class="ts-tb__rail-scroll">${railHtml}</div>
    </aside>
    <div class="ts-tb__canvas-wrap">
      <div class="ts-tb__canvas" data-tb-canvas style="height:${canvasHeight}px">
        <div class="ts-tb__hours">${hours}</div>
        <div class="ts-tb__lane-area">${blocks.map((block) => blockMarkup(host, block)).join("")}</div>
        ${selectedRailID ? `<div class="ts-tb__drop-hint">${escapeHtml(t(host, "timelineTapSlot", "Tap a time slot to schedule the selected task."))}</div>` : ""}
      </div>
    </div>
  </div>
</div>`;
    };

    const findTask = (id: string | undefined): Task | undefined =>
        id ? tasks.find((task) => task.id === id) : undefined;

    let dragState: {task: Task; element: HTMLElement; startY: number; start: number; end: number; moved: boolean} | null = null;

    const clearDragListeners = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
    };

    const onPointerMove = (event: PointerEvent) => {
        if (!dragState) {
            return;
        }
        const delta = (event.clientY - dragState.startY) / PX_PER_MINUTE;
        if (Math.abs(event.clientY - dragState.startY) > 3) {
            dragState.moved = true;
        }
        const start = clampStart(dragState.start + delta, dragState.end - dragState.start);
        dragState.element.style.top = `${(start - DAY_START) * PX_PER_MINUTE}px`;
        dragState.element.dataset.tbPreviewStart = String(start);
    };

    const onPointerUp = async () => {
        const state = dragState;
        dragState = null;
        clearDragListeners();
        if (!state) {
            return;
        }
        state.element.classList.remove("ts-tb__block--dragging");
        if (!state.moved) {
            return;
        }
        const preview = Number(state.element.dataset.tbPreviewStart);
        if (!Number.isFinite(preview)) {
            render();
            return;
        }
        const duration = state.end - state.start;
        const start = clampStart(preview, duration);
        try {
            await host.setPlanBlock(state.task, selectedDate, formatClock(start), formatClock(start + duration));
            await refresh();
        } catch (error) {
            showMessage(t(host, "saveFailed", "Failed to save: ${msg}", {msg: errorMessage(error)}), 6000, "error");
            render();
        }
    };

    const onPointerCancel = () => {
        dragState = null;
        clearDragListeners();
        render();
    };

    const onPointerDown = (event: PointerEvent) => {
        const target = event.target as HTMLElement;
        const block = target.closest<HTMLElement>("[data-tb-block]");
        if (!block || target.closest("button, [data-tb-open]")) {
            return;
        }
        const task = findTask(block.dataset.tbBlock);
        const start = parseClock(task?.planStart);
        const end = parseClock(task?.planEnd);
        if (!task || start === undefined || end === undefined) {
            return;
        }
        event.preventDefault();
        dragState = {task, element: block, startY: event.clientY, start, end, moved: false};
        block.classList.add("ts-tb__block--dragging");
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
    };

    const canvasMinutes = (event: MouseEvent | DragEvent, canvas: HTMLElement): number => {
        const rect = canvas.getBoundingClientRect();
        return DAY_START + (event.clientY - rect.top) / PX_PER_MINUTE;
    };

    const scheduleAt = async (task: Task, minutes: number, duration = DEFAULT_DURATION) => {
        const start = clampStart(minutes, duration);
        const end = Math.min(DAY_END, start + duration);
        try {
            await host.setPlanBlock(task, selectedDate, formatClock(start), formatClock(end));
            selectedRailID = "";
            await refresh();
        } catch (error) {
            showMessage(t(host, "saveFailed", "Failed to save: ${msg}", {msg: errorMessage(error)}), 6000, "error");
        }
    };

    const onClick = async (event: Event) => {
        const target = event.target as HTMLElement;
        const nav = target.closest<HTMLElement>("[data-tb-nav]");
        if (nav) {
            selectedDate = shiftDateKey(selectedDate, Number(nav.dataset.tbNav) || 0);
            render();
            return;
        }
        if (target.closest("[data-tb-today]")) {
            selectedDate = todayKey();
            render();
            return;
        }
        if (target.closest("[data-tb-tomorrow]")) {
            selectedDate = shiftDateKey(todayKey(), 1);
            render();
            return;
        }
        if (target.closest("[data-tb-screen]")) {
            host.openScreening?.();
            return;
        }
        const action = target.closest<HTMLElement>("[data-tb-action]");
        if (action) {
            const block = action.closest<HTMLElement>("[data-tb-block]");
            const task = findTask(block?.dataset.tbBlock);
            if (!task) {
                return;
            }
            const kind = action.dataset.tbAction;
            if (kind === "pomodoro") {
                host.startTaskPomodoro?.(task, {completeNext: true});
                return;
            }
            if (kind === "unplan") {
                try {
                    await host.clearPlanBlock(task);
                    await refresh();
                } catch (error) {
                    showMessage(t(host, "saveFailed", "Failed to save: ${msg}", {msg: errorMessage(error)}), 6000, "error");
                }
                return;
            }
            if (kind === "complete") {
                action.setAttribute("disabled", "true");
                try {
                    const result = await host.completeNextAction(task);
                    await refresh();
                    showMessage(
                        result.parentDone
                            ? t(host, "quadrantTaskArchived", "All steps complete; task archived.")
                            : t(host, "quadrantStepDone", "Step complete: ${name}", {name: result.nextAction || ""}),
                        3000,
                    );
                } catch (error) {
                    showMessage(t(host, "taskDoneFailed", "Failed to complete task: ${msg}", {msg: errorMessage(error)}), 6000, "error");
                } finally {
                    action.removeAttribute("disabled");
                }
                return;
            }
        }
        const openTarget = target.closest<HTMLElement>("[data-tb-open]");
        if (openTarget && host.app) {
            openTab({app: host.app, doc: {id: openTarget.dataset.tbOpen, action: ["cb-get-focus", "cb-get-hl"]}});
            return;
        }
        const railTarget = target.closest<HTMLElement>("[data-tb-rail]");
        if (railTarget) {
            selectedRailID = selectedRailID === railTarget.dataset.tbRail ? "" : (railTarget.dataset.tbRail || "");
            render();
            return;
        }
        const canvas = target.closest<HTMLElement>("[data-tb-canvas]");
        if (canvas && !target.closest("[data-tb-block]") && selectedRailID) {
            const task = findTask(selectedRailID);
            if (task) {
                await scheduleAt(task, canvasMinutes(event as MouseEvent, canvas));
            }
        }
    };

    const onDragStart = (event: DragEvent) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>("[data-tb-rail]");
        if (!item) {
            return;
        }
        if (event.dataTransfer) {
            event.dataTransfer.setData("text/plain", item.dataset.tbRail || "");
            event.dataTransfer.effectAllowed = "move";
        }
    };

    const onDragOver = (event: DragEvent) => {
        if ((event.target as HTMLElement).closest("[data-tb-canvas]")) {
            event.preventDefault();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = "move";
            }
        }
    };

    const onDrop = async (event: DragEvent) => {
        const canvas = (event.target as HTMLElement).closest<HTMLElement>("[data-tb-canvas]");
        if (!canvas) {
            return;
        }
        event.preventDefault();
        const task = findTask(event.dataTransfer?.getData("text/plain"));
        if (task) {
            await scheduleAt(task, canvasMinutes(event, canvas));
        }
    };

    const refresh = async () => {
        try {
            tasks = await host.getTasks();
            render();
        } catch (error) {
            if (!destroyed) {
                container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "timelineLoadFailed", "Failed to load the plan: ${msg}", {msg: errorMessage(error)}))}</div>`;
            }
        }
    };

    const onExternalChange = () => {
        void refresh();
    };

    container.addEventListener("click", onClick);
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("dragstart", onDragStart);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);
    window.addEventListener("task-secretary-tasks-changed", onExternalChange);

    container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "loading", "Loading…"))}</div>`;
    void refresh();

    return {
        refresh,
        showDate: (date: string) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return;
            }
            selectedDate = date;
            render();
        },
        destroy: () => {
            destroyed = true;
            clearDragListeners();
            container.removeEventListener("click", onClick);
            container.removeEventListener("pointerdown", onPointerDown);
            container.removeEventListener("dragstart", onDragStart);
            container.removeEventListener("dragover", onDragOver);
            container.removeEventListener("drop", onDrop);
            window.removeEventListener("task-secretary-tasks-changed", onExternalChange);
            container.innerHTML = "";
        },
    };
};
