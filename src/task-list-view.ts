import {openTab, showMessage} from "siyuan";
import type {GtdQuadrant, Task} from "./types";
import type {CompleteResult} from "./task-store";
import {confirmDialog} from "./confirm";

export interface TaskListViewHost {
    i18n: Record<string, any>;
    app?: any;
    getTasks(): Promise<Task[]>;
    completeNextAction(task: Task): Promise<CompleteResult>;
    deleteTask(task: Task): Promise<void>;
    editTask?(task: Task): void;
    startTaskPomodoro?(task: Task, options?: {completeNext?: boolean}): void;
}

export interface TaskListView {
    refresh(): Promise<void>;
    destroy(): void;
}

const QUADRANTS: Array<{key: GtdQuadrant; fallback: string; tagKey: string; tagFallback: string}> = [
    {key: "q1", fallback: "Important & urgent", tagKey: "quadrantQ1Tag", tagFallback: "Do now"},
    {key: "q2", fallback: "Important, not urgent", tagKey: "quadrantQ2Tag", tagFallback: "Schedule"},
    {key: "q3", fallback: "Not important, urgent", tagKey: "quadrantQ3Tag", tagFallback: "Delegate"},
    {key: "q4", fallback: "Not important, not urgent", tagKey: "quadrantQ4Tag", tagFallback: "Do less"},
];

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: TaskListViewHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const quadrantMeta = (task: Task) => QUADRANTS.find((quadrant) => quadrant.key === task.quadrant);

const valueLabel = (host: TaskListViewHost, priority: number): string => priority === 1
    ? t(host, "priorityHigh", "High value")
    : priority === 3
        ? t(host, "priorityLow", "Low value")
        : t(host, "priorityMedium", "Neutral");

const dueLabel = (host: TaskListViewHost, task: Task): string => {
    if (task.planDate && task.planStart) {
        return `${task.planDate} ${task.planStart}${task.planEnd ? `–${task.planEnd}` : ""}`;
    }
    if (task.dueDate) {
        return `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}`;
    }
    return t(host, "timelineNoDue", "No due date");
};

const taskRow = (host: TaskListViewHost, task: Task) => {
    const quadrant = quadrantMeta(task);
    const hasSteps = task.stepCount > 0;
    const nextAction = task.nextAction && task.nextAction !== task.title ? task.nextAction : "";
    const completeTitle = hasSteps
        ? t(host, "quadrantCompleteNext", "Complete next step")
        : t(host, "quadrantCompleteTask", "Complete task");
    return `<div class="ts-tasklist__row${task.overdue ? " ts-tasklist__row--overdue" : ""}" data-task-id="${task.id}">
  <button class="ts-tasklist__done" data-task-done="${task.id}" title="${escapeHtml(completeTitle)}" aria-label="${escapeHtml(completeTitle)}"></button>
  <div class="ts-tasklist__body">
    <div class="ts-tasklist__title">
      <span class="ts-tasklist__name" data-task-open="${task.id}" title="${escapeHtml(t(host, "timelineOpenTask", "Open task block"))}">${escapeHtml(task.title)}</span>
      ${quadrant ? `<span class="ts-tasklist__quad ts-tasklist__quad--${quadrant.key}">${escapeHtml(t(host, quadrant.tagKey, quadrant.tagFallback))}</span>` : ""}
      ${hasSteps ? `<span class="ts-tasklist__steps">${escapeHtml(t(host, "quadrantStepsLeft", "${count} steps left", {count: task.stepCount}))}</span>` : ""}
    </div>
    ${nextAction ? `<div class="ts-tasklist__next">↳ ${escapeHtml(nextAction)}</div>` : ""}
    <div class="ts-tasklist__meta">
      <span class="${task.overdue ? "ts-due--overdue" : ""}">${escapeHtml(dueLabel(host, task))}</span>
      <span class="ts-tasklist__sep">·</span>
      <span class="ts-tasklist__priority ts-tasklist__priority--p${task.priority}" title="${escapeHtml(t(host, "quickPriority", "Value"))}">${escapeHtml(valueLabel(host, task.priority))}</span>
    </div>
  </div>
  <div class="ts-tasklist__actions">
    <button data-task-pomodoro="${task.id}" title="${escapeHtml(t(host, "pomodoroStart", "Start pomodoro"))}">🍅</button>
    <button data-task-edit="${task.id}" title="${escapeHtml(t(host, "taskEditButton", "Edit"))}"><svg><use xlink:href="#iconEdit"></use></svg></button>
    <button data-task-delete="${task.id}" title="${escapeHtml(t(host, "taskDeleteButton", "Delete"))}"><svg><use xlink:href="#iconTrashcan"></use></svg></button>
  </div>
</div>`;
};

export const mountTaskListView = (host: TaskListViewHost, container: HTMLElement): TaskListView => {
    let tasks: Task[] = [];
    let destroyed = false;

    const render = () => {
        if (destroyed) {
            return;
        }
        const visible = tasks.filter((task) => task.clarified && !task.archived && task.type === "task");
        const byId = new Map(visible.map((task) => [task.id, task]));
        const roots = visible.filter((task) => !task.parentID || !byId.has(task.parentID));
        roots.sort((a, b) =>
            (a.planDate || a.dueDate || "9999").localeCompare(b.planDate || b.dueDate || "9999")
            || a.priority - b.priority
            || a.title.localeCompare(b.title));
        container.innerHTML = `<div class="ts-tasklist">
  <div class="ts-tasklist__head">
    <div class="ts-tasklist__heading">
      <div class="ts-tasklist__title-main">${escapeHtml(t(host, "taskListTitle", "Tasks"))}</div>
      <div class="ts-tasklist__summary">${escapeHtml(t(host, "taskListSummary", "${count} arranged tasks", {count: roots.length}))}</div>
    </div>
  </div>
  ${roots.length > 0
        ? `<div class="ts-tasklist__scroll">${roots.map((task) => taskRow(host, task)).join("")}</div>`
        : `<div class="ts-empty ts-tasklist__empty">
  <div class="ts-tasklist__empty-title">${escapeHtml(t(host, "taskListEmptyTitle", "No arranged tasks yet"))}</div>
  <div>${escapeHtml(t(host, "taskListEmptyHint", "Clarify an inbox item to move it here."))}</div>
</div>`}
</div>`;
    };

    const onClick = async (event: Event) => {
        const target = event.target as HTMLElement;
        const openTarget = target.closest<HTMLElement>("[data-task-open]");
        if (openTarget && host.app) {
            openTab({app: host.app, doc: {id: openTarget.dataset.taskOpen, action: ["cb-get-focus", "cb-get-hl"]}});
            return;
        }
        const findTask = (id: string | undefined) => id ? tasks.find((task) => task.id === id) : undefined;
        const done = target.closest<HTMLElement>("[data-task-done]");
        if (done) {
            const task = findTask(done.dataset.taskDone);
            if (!task) {
                return;
            }
            done.setAttribute("disabled", "true");
            try {
                const result = await host.completeNextAction(task);
                await refresh();
                showMessage(
                    result.parentDone
                        ? t(host, "quadrantTaskArchived", "All steps complete; task archived.")
                        : t(host, "quadrantStepDone", "Advanced to: ${name}", {name: result.nextAction || ""}),
                    3000,
                );
            } catch (error) {
                showMessage(t(host, "taskDoneFailed", "Failed to complete task: ${msg}", {msg: errorMessage(error)}), 6000, "error");
            } finally {
                done.removeAttribute("disabled");
            }
            return;
        }
        const pomodoro = target.closest<HTMLElement>("[data-task-pomodoro]");
        if (pomodoro) {
            const task = findTask(pomodoro.dataset.taskPomodoro);
            if (task) {
                host.startTaskPomodoro?.(task, {completeNext: true});
            }
            return;
        }
        const edit = target.closest<HTMLElement>("[data-task-edit]");
        if (edit) {
            const task = findTask(edit.dataset.taskEdit);
            if (task) {
                host.editTask?.(task);
            }
            return;
        }
        const remove = target.closest<HTMLElement>("[data-task-delete]");
        if (remove) {
            const task = findTask(remove.dataset.taskDelete);
            if (!task) {
                return;
            }
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
        }
    };

    const refresh = async () => {
        try {
            tasks = await host.getTasks();
            render();
        } catch (error) {
            if (!destroyed) {
                container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "taskListLoadFailed", "Failed to load tasks: ${msg}", {msg: errorMessage(error)}))}</div>`;
            }
        }
    };

    const onExternalChange = () => {
        void refresh();
    };

    container.addEventListener("click", onClick);
    window.addEventListener("task-secretary-tasks-changed", onExternalChange);
    container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "loading", "Loading…"))}</div>`;
    void refresh();

    return {
        refresh,
        destroy: () => {
            destroyed = true;
            container.removeEventListener("click", onClick);
            window.removeEventListener("task-secretary-tasks-changed", onExternalChange);
            container.innerHTML = "";
        },
    };
};
