import {openTab, showMessage} from "siyuan";
import type {GtdQuadrant, Task} from "./types";
import type {CompleteResult} from "./task-store";
import {confirmDialog} from "./confirm";

export type QuadrantKey = GtdQuadrant;

export interface QuadrantViewHost {
    i18n: Record<string, any>;
    app?: any;
    getTasks(): Promise<Task[]>;
    completeNextAction(task: Task): Promise<CompleteResult>;
    deleteTask(task: Task): Promise<void>;
    editTask?(task: Task): void;
    moveTask?(task: Task, quadrant: QuadrantKey): Promise<void>;
    startTaskPomodoro?(task: Task, options?: {completeNext?: boolean}): void;
}

export interface QuadrantView {
    refresh(): Promise<void>;
    destroy(): void;
}

const QUADRANTS: Array<{key: QuadrantKey; labelKey: string; fallback: string; tagKey: string; tagFallback: string}> = [
    {key: "q1", labelKey: "quadrantQ1", fallback: "Important & urgent", tagKey: "quadrantQ1Tag", tagFallback: "Do now"},
    {key: "q2", labelKey: "quadrantQ2", fallback: "Important, not urgent", tagKey: "quadrantQ2Tag", tagFallback: "Schedule"},
    {key: "q3", labelKey: "quadrantQ3", fallback: "Not important, urgent", tagKey: "quadrantQ3Tag", tagFallback: "Delegate"},
    {key: "q4", labelKey: "quadrantQ4", fallback: "Not important, not urgent", tagKey: "quadrantQ4Tag", tagFallback: "Do less"},
];

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: QuadrantViewHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const valueLabel = (host: QuadrantViewHost, priority: number): string => priority === 1
    ? t(host, "priorityHigh", "High value")
    : priority === 3
        ? t(host, "priorityLow", "Low value")
        : t(host, "priorityMedium", "Neutral");

const dueLabel = (host: QuadrantViewHost, task: Task): string => {
    if (task.planDate && task.planStart) {
        return `${task.planDate} ${task.planStart}${task.planEnd ? `–${task.planEnd}` : ""}`;
    }
    if (!task.dueDate) {
        return t(host, "groupNone", "No due date");
    }
    return `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}`;
};

const taskCard = (host: QuadrantViewHost, task: Task) => {
    const hasSteps = task.stepCount > 0;
    const nextAction = task.nextAction && task.nextAction !== task.title ? task.nextAction : "";
    const completeTitle = hasSteps
        ? t(host, "quadrantCompleteNext", "Complete next step")
        : t(host, "quadrantCompleteTask", "Complete task");
    return `<div class="ts-qcard${task.overdue ? " ts-qcard--overdue" : ""}" data-task-id="${task.id}" draggable="true">
  <div class="ts-qcard__main">
    <button class="ts-qcard__done" data-q-action="complete" title="${escapeHtml(completeTitle)}" aria-label="${escapeHtml(completeTitle)}"></button>
    <div class="ts-qcard__body">
      <div class="ts-qcard__title"><span class="ts-qcard__ref" data-q-open="${task.id}" title="${escapeHtml(t(host, "timelineOpenTask", "Open task block"))}">${escapeHtml(task.title)}</span>${hasSteps ? `<span class="ts-qcard__step-count">${escapeHtml(t(host, "quadrantStepsLeft", "${count} steps left", {count: task.stepCount}))}</span>` : ""}</div>
      ${nextAction ? `<div class="ts-qcard__next">↳ ${escapeHtml(nextAction)}</div>` : ""}
      <div class="ts-qcard__meta">
        <span class="ts-priority ts-priority--p${task.priority}" title="${escapeHtml(t(host, "quickPriority", "Value"))}">${escapeHtml(valueLabel(host, task.priority))}</span>
        <span class="ts-qcard__due${task.overdue ? " ts-due--overdue" : ""}">${escapeHtml(dueLabel(host, task))}</span>
      </div>
    </div>
    <div class="ts-qcard__actions">
      <button data-q-action="pomodoro" title="${escapeHtml(t(host, "pomodoroStart", "Start pomodoro"))}">🍅</button>
      <button data-q-action="edit" title="${escapeHtml(t(host, "taskEditButton", "Edit"))}"><svg><use xlink:href="#iconEdit"></use></svg></button>
      <button data-q-action="delete" title="${escapeHtml(t(host, "taskDeleteButton", "Delete"))}"><svg><use xlink:href="#iconTrashcan"></use></svg></button>
    </div>
  </div>
</div>`;
};

export const mountQuadrantView = (host: QuadrantViewHost, container: HTMLElement): QuadrantView => {
    let tasks: Task[] = [];
    let destroyed = false;

    const render = () => {
        if (destroyed) {
            return;
        }
        const buckets: Record<QuadrantKey, Task[]> = {q1: [], q2: [], q3: [], q4: []};
        const visible = tasks.filter((task) => task.clarified && !task.archived && task.quadrant && task.type === "task");
        const byId = new Map(visible.map((task) => [task.id, task]));
        const roots = visible.filter((task) => !task.parentID || !byId.has(task.parentID));
        roots.forEach((task) => {
            if (task.quadrant) {
                buckets[task.quadrant].push(task);
            }
        });
        (Object.keys(buckets) as QuadrantKey[]).forEach((key) => {
            buckets[key].sort((a, b) =>
                (a.planDate || a.dueDate || "9999").localeCompare(b.planDate || b.dueDate || "9999")
                || a.priority - b.priority
                || a.title.localeCompare(b.title));
        });

        container.innerHTML = `<div class="ts-quadrant">
  <div class="ts-quadrant__hint">${escapeHtml(t(host, "quadrantGtdHint", "Clarified tasks only. Completing a card advances its next step; the task is archived when every step is done."))}</div>
  <div class="ts-quadrant__grid">
    ${QUADRANTS.map((quadrant) => `<section class="ts-quadrant__cell ts-quadrant__cell--${quadrant.key}" data-quadrant="${quadrant.key}">
      <div class="ts-quadrant__head">
        <span class="ts-quadrant__head-main">
          <span class="ts-quadrant__dot" aria-hidden="true"></span>
          <span class="ts-quadrant__name">${escapeHtml(t(host, quadrant.labelKey, quadrant.fallback))}</span>
          <span class="ts-quadrant__tag">${escapeHtml(t(host, quadrant.tagKey, quadrant.tagFallback))}</span>
        </span>
        <span class="ts-quadrant__head-actions">
          <span class="ts-quadrant__count">${buckets[quadrant.key].length}</span>
        </span>
      </div>
      <div class="ts-quadrant__items">
        ${buckets[quadrant.key].length > 0
        ? buckets[quadrant.key].map((task) => taskCard(host, task)).join("")
        : `<div class="ts-quadrant__empty">${escapeHtml(t(host, "quadrantEmpty", "No tasks"))}</div>`}
      </div>
    </section>`).join("")}
  </div>
</div>`;
    };

    const onClick = async (event: Event) => {
        const target = event.target as HTMLElement;
        const openTarget = target.closest<HTMLElement>("[data-q-open]");
        if (openTarget && host.app) {
            openTab({app: host.app, doc: {id: openTarget.dataset.qOpen, action: ["cb-get-focus", "cb-get-hl"]}});
            return;
        }
        const actionButton = target.closest<HTMLElement>("[data-q-action]");
        if (!actionButton) {
            return;
        }
        const card = actionButton.closest<HTMLElement>("[data-task-id]");
        const task = card ? tasks.find((item) => item.id === card.dataset.taskId) : undefined;
        if (!task) {
            return;
        }
        const action = actionButton.dataset.qAction;
        if (action === "edit") {
            host.editTask?.(task);
            return;
        }
        if (action === "pomodoro") {
            host.startTaskPomodoro?.(task, {completeNext: true});
            return;
        }
        if (action === "delete") {
            const confirmed = await confirmDialog({
                title: t(host, "taskDeleteTitle", "Delete task"),
                message: t(host, "deleteTaskConfirm", "Delete \"${name}\"? This removes the task block from your notes.", {name: task.title}),
                confirmLabel: t(host, "taskDeleteButton", "Delete"),
                cancelLabel: t(host, "cancel", "Cancel"),
                danger: true,
            });
            if (!confirmed) {
                return;
            }
            try {
                await host.deleteTask(task);
                await refresh();
                showMessage(t(host, "taskDeleted", "Task deleted."), 3000);
            } catch (error) {
                showMessage(t(host, "taskDeleteFailed", "Failed to delete task: ${msg}", {msg: errorMessage(error)}), 6000, "error");
            }
            return;
        }
        if (action === "complete") {
            actionButton.setAttribute("disabled", "true");
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
                actionButton.removeAttribute("disabled");
            }
        }
    };

    let draggedTaskID = "";

    const clearDragState = () => {
        draggedTaskID = "";
        container.querySelectorAll(".ts-qcard--dragging").forEach((element) => element.classList.remove("ts-qcard--dragging"));
        container.querySelectorAll(".ts-quadrant__cell--dragover").forEach((element) => element.classList.remove("ts-quadrant__cell--dragover"));
    };

    const onDragStart = (event: DragEvent) => {
        const card = (event.target as HTMLElement).closest<HTMLElement>('.ts-qcard[draggable="true"]');
        const id = card?.dataset.taskId;
        if (!card || !id) {
            return;
        }
        draggedTaskID = id;
        card.classList.add("ts-qcard--dragging");
        if (event.dataTransfer) {
            event.dataTransfer.setData("text/plain", id);
            event.dataTransfer.effectAllowed = "move";
        }
    };

    const onDragOver = (event: DragEvent) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-quadrant]");
        if (!cell) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
        }
        container.querySelectorAll(".ts-quadrant__cell--dragover").forEach((element) => {
            if (element !== cell) {
                element.classList.remove("ts-quadrant__cell--dragover");
            }
        });
        cell.classList.add("ts-quadrant__cell--dragover");
    };

    const onDragLeave = (event: DragEvent) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-quadrant]");
        if (cell && !cell.contains(event.relatedTarget as Node)) {
            cell.classList.remove("ts-quadrant__cell--dragover");
        }
    };

    const onDrop = async (event: DragEvent) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-quadrant]");
        if (!cell) {
            return;
        }
        event.preventDefault();
        const id = event.dataTransfer?.getData("text/plain") || draggedTaskID;
        const quadrant = cell.dataset.quadrant as QuadrantKey;
        clearDragState();
        const task = tasks.find((item) => item.id === id);
        if (!task || !quadrant || task.quadrant === quadrant) {
            return;
        }
        try {
            await host.moveTask?.(task, quadrant);
            await refresh();
        } catch (error) {
            showMessage(t(host, "saveFailed", "Failed to save: ${msg}", {msg: errorMessage(error)}), 6000, "error");
        }
    };

    container.addEventListener("click", onClick);
    container.addEventListener("dragstart", onDragStart);
    container.addEventListener("dragend", clearDragState);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("dragleave", onDragLeave);
    container.addEventListener("drop", onDrop);

    const refresh = async () => {
        try {
            tasks = await host.getTasks();
            render();
        } catch (error) {
            if (!destroyed) {
                container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "quadrantLoadFailed", "Failed to load tasks: ${msg}", {msg: errorMessage(error)}))}</div>`;
            }
        }
    };

    const onExternalChange = () => {
        void refresh();
    };
    window.addEventListener("task-secretary-tasks-changed", onExternalChange);

    container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "loading", "Loading…"))}</div>`;
    void refresh();

    return {
        refresh,
        destroy: () => {
            destroyed = true;
            container.removeEventListener("click", onClick);
            container.removeEventListener("dragstart", onDragStart);
            container.removeEventListener("dragend", clearDragState);
            container.removeEventListener("dragover", onDragOver);
            container.removeEventListener("dragleave", onDragLeave);
            container.removeEventListener("drop", onDrop);
            window.removeEventListener("task-secretary-tasks-changed", onExternalChange);
            container.innerHTML = "";
        },
    };
};
