import {Dialog, getFrontend, showMessage} from "siyuan";
import type {HabitViewHost, HabitView} from "./habit-view";
import {mountHabitView} from "./habit-view";
import {mountInboxView, type InboxView} from "./inbox-view";
import {mountTimelineView, type TimelineView, type TimelineViewHost} from "./timeline-view";
import {mountQuadrantView, type QuadrantView, type QuadrantViewHost} from "./quadrant-view";
import {mountTaskListView, type TaskListView} from "./task-list-view";
import {mountResourceView, type ResourceView} from "./resource-view";
import type {CompleteResult, NextActionCandidate} from "./task-store";
import type {GtdQuadrant, InboxItem, NewTaskInput, Priority, Task, TaskType} from "./types";
import {dateKey} from "./habit-store";

export type Workspace = "inbox" | "tasks" | "habits" | "knowledge";
export type TaskMode = "list" | "quadrant" | "timeline";
export type TaskTab = Workspace;

export interface TaskDialogHost extends HabitViewHost {
    app: any;
    getTasks(): Promise<Task[]>;
    getInbox(): Promise<InboxItem[]>;
    getKnowledgeItems(): Promise<InboxItem[]>;
    getColdItems(): Promise<InboxItem[]>;
    archiveAsKnowledge(item: InboxItem, targetDocID: string): Promise<void>;
    coldItem(item: InboxItem): Promise<void>;
    getNextActionCandidate(id: string): Promise<NextActionCandidate>;
    clarifyItem(item: InboxItem, quadrant: GtdQuadrant, nextAction?: string): Promise<void>;
    completeNextAction(task: Task): Promise<CompleteResult>;
    openFullscreen?(tab: TaskTab): void;
    openScreening?(): void;
    startTaskPomodoro?(task: Task, options?: {completeNext?: boolean}): void;
    markTaskDone(task: Task): Promise<void>;
    saveTaskMeta(task: Task, dueDate: string, dueTime: string, priority: Priority, reminderMinutes: number | null): Promise<void>;
    updateTask(task: Task, title: string, type: TaskType, dueDate: string, dueTime: string, priority: Priority, reminderMinutes: number | null): Promise<void>;
    addTask(input: NewTaskInput): Promise<void>;
    deleteTask(task: Task): Promise<void>;
    setPlanBlock(task: Task, date: string, start: string, end: string): Promise<void>;
    clearPlanBlock(task: Task): Promise<void>;
    setTaskQuadrant(task: Task, quadrant: GtdQuadrant): Promise<void>;
}

export interface TaskView {
    refresh(): Promise<void>;
    destroy(): void;
}

export interface TaskViewOptions {
    showClose?: boolean;
    showFullscreen?: boolean;
    initialTab?: TaskTab;
    onClose?: () => void;
}

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const TOPBAR_ICONS: Record<string, string> = {
    refresh: `<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v6h-6"/>`,
    fullscreen: `<path d="M9 4H4v5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M4 15v5h5"/>`,
    close: `<path d="M6 6l12 12"/><path d="M18 6 6 18"/>`,
};

const NAV_ICONS: Record<Workspace, string> = {
    inbox: `<path d="M4 5h16v14H4z"/><path d="M4 13h4l2 3h4l2-3h4"/>`,
    tasks: `<path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>`,
    habits: `<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`,
    knowledge: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`,
};

const topbarIcon = (name: keyof typeof TOPBAR_ICONS) =>
    `<svg class="ts-topbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOPBAR_ICONS[name]}</svg>`;

const navIcon = (name: Workspace) =>
    `<svg class="ts-mainnav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[name]}</svg>`;

const t = (host: TaskDialogHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export const mountTaskView = (
    host: TaskDialogHost,
    contentRoot: HTMLElement,
    actionRoot: HTMLElement,
    _initialTasks: Task[],
    options: TaskViewOptions = {},
): TaskView => {
    const initialTab: Workspace = options.initialTab ?? "inbox";
    let activeWorkspace: Workspace | "" = "";
    let activeTaskMode: TaskMode = "list";
    let inboxView: InboxView | undefined;
    let taskListView: TaskListView | undefined;
    let timelineView: TimelineView | undefined;
    let quadrantView: QuadrantView | undefined;
    let habitView: HabitView | undefined;
    let knowledgeView: ResourceView | undefined;

    const actionButton = (action: string, icon: keyof typeof TOPBAR_ICONS, label: string) =>
        `<button class="ts-topbar__btn" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${topbarIcon(icon)}</button>`;
    const topbarActions = [
        actionButton("refresh", "refresh", t(host, "refresh", "Refresh")),
        options.showFullscreen ? actionButton("fullscreen", "fullscreen", t(host, "fullscreen", "Fullscreen")) : "",
        options.showClose ? actionButton("close", "close", t(host, "close", "Close")) : "",
    ].join("");

    contentRoot.innerHTML = `<div class="ts-view">
  <div class="ts-topbar">
    <div class="ts-mainnav">
      <button class="ts-mainnav__btn" data-workspace="inbox">${navIcon("inbox")}<span>${escapeHtml(t(host, "tabInbox", "Inbox"))}</span></button>
      <button class="ts-mainnav__btn" data-workspace="tasks">${navIcon("tasks")}<span>${escapeHtml(t(host, "tabTasks", "Tasks"))}</span></button>
      <button class="ts-mainnav__btn" data-workspace="habits">${navIcon("habits")}<span>${escapeHtml(t(host, "tabHabits", "Habits"))}</span></button>
      <button class="ts-mainnav__btn" data-workspace="knowledge">${navIcon("knowledge")}<span>${escapeHtml(t(host, "tabKnowledge", "Knowledge"))}</span></button>
    </div>
    <div class="ts-topbar__actions">${topbarActions}</div>
  </div>
  <div class="ts-page fn__none" data-page="inbox"></div>
  <div class="ts-page fn__none" data-page="tasks">
    <div class="ts-subnav">
      <button class="ts-subnav__btn" data-task-mode="list">${escapeHtml(t(host, "taskViewList", "List"))}</button>
      <button class="ts-subnav__btn" data-task-mode="quadrant">${escapeHtml(t(host, "tabQuadrant", "Quadrants"))}</button>
      <button class="ts-subnav__btn" data-task-mode="timeline">${escapeHtml(t(host, "tabTimeline", "Timeline"))}</button>
    </div>
    <div class="ts-taskpage" data-taskmode-page="list"></div>
    <div class="ts-taskpage fn__none" data-taskmode-page="quadrant"></div>
    <div class="ts-taskpage fn__none" data-taskmode-page="timeline"></div>
  </div>
  <div class="ts-page fn__none" data-page="habits"></div>
  <div class="ts-page fn__none" data-page="knowledge"></div>
</div>`;

    actionRoot.innerHTML = "";
    actionRoot.style.display = "none";

    const pages: Record<Workspace, HTMLElement> = {
        inbox: contentRoot.querySelector<HTMLElement>('[data-page="inbox"]')!,
        tasks: contentRoot.querySelector<HTMLElement>('[data-page="tasks"]')!,
        habits: contentRoot.querySelector<HTMLElement>('[data-page="habits"]')!,
        knowledge: contentRoot.querySelector<HTMLElement>('[data-page="knowledge"]')!,
    };
    const taskPages: Record<TaskMode, HTMLElement> = {
        list: contentRoot.querySelector<HTMLElement>('[data-taskmode-page="list"]')!,
        quadrant: contentRoot.querySelector<HTMLElement>('[data-taskmode-page="quadrant"]')!,
        timeline: contentRoot.querySelector<HTMLElement>('[data-taskmode-page="timeline"]')!,
    };
    const workspaceButtons = [...contentRoot.querySelectorAll<HTMLElement>("[data-workspace]")];
    const taskModeButtons = [...contentRoot.querySelectorAll<HTMLElement>("[data-task-mode]")];

    const quadrantHost: QuadrantViewHost = {
        i18n: host.i18n,
        app: host.app,
        getTasks: host.getTasks,
        completeNextAction: host.completeNextAction,
        deleteTask: host.deleteTask,
        editTask: (task) => openTaskEditDialog(host, task, () => {
            void quadrantView?.refresh();
            void taskListView?.refresh();
            void timelineView?.refresh();
        }),
        moveTask: async (task, quadrant) => {
            await host.setTaskQuadrant(task, quadrant);
        },
        startTaskPomodoro: host.startTaskPomodoro,
    };

    const timelineHost: TimelineViewHost = {
        i18n: host.i18n,
        app: host.app,
        getTasks: host.getTasks,
        completeNextAction: host.completeNextAction,
        deleteTask: host.deleteTask,
        editTask: (task) => openTaskEditDialog(host, task, () => {
            void timelineView?.refresh();
            void taskListView?.refresh();
            void quadrantView?.refresh();
        }),
        startTaskPomodoro: host.startTaskPomodoro,
        setPlanBlock: host.setPlanBlock,
        clearPlanBlock: host.clearPlanBlock,
        openScreening: host.openScreening,
    };

    const taskListHost = {
        i18n: host.i18n,
        app: host.app,
        getTasks: host.getTasks,
        completeNextAction: host.completeNextAction,
        deleteTask: host.deleteTask,
        editTask: (task: Task) => openTaskEditDialog(host, task, () => {
            void taskListView?.refresh();
            void quadrantView?.refresh();
            void timelineView?.refresh();
        }),
        startTaskPomodoro: host.startTaskPomodoro,
    };

    const knowledgeHost = {
        i18n: host.i18n,
        app: host.app,
        getKnowledgeItems: host.getKnowledgeItems,
        getColdItems: host.getColdItems,
        getNextActionCandidate: host.getNextActionCandidate,
        clarifyItem: host.clarifyItem,
        archiveAsKnowledge: host.archiveAsKnowledge,
    };

    const switchTaskMode = (mode: TaskMode, force = false) => {
        if (mode === activeTaskMode && !force) {
            return;
        }
        activeTaskMode = mode;
        taskModeButtons.forEach((button) => {
            button.classList.toggle("ts-subnav__btn--active", button.dataset.taskMode === mode);
        });
        (Object.keys(taskPages) as TaskMode[]).forEach((key) => {
            taskPages[key].classList.toggle("fn__none", key !== mode);
        });
        if (mode === "list") {
            if (!taskListView) {
                taskListView = mountTaskListView(taskListHost, taskPages.list);
            } else {
                void taskListView.refresh();
            }
            return;
        }
        if (mode === "quadrant") {
            if (!quadrantView) {
                quadrantView = mountQuadrantView(quadrantHost, taskPages.quadrant);
            } else {
                void quadrantView.refresh();
            }
            return;
        }
        if (!timelineView) {
            timelineView = mountTimelineView(timelineHost, taskPages.timeline);
        } else {
            void timelineView.refresh();
        }
    };

    const switchWorkspace = (workspace: Workspace) => {
        if (workspace === activeWorkspace) {
            return;
        }
        activeWorkspace = workspace;
        workspaceButtons.forEach((button) => {
            button.classList.toggle("ts-mainnav__btn--active", button.dataset.workspace === workspace);
        });
        (Object.keys(pages) as Workspace[]).forEach((key) => {
            pages[key].classList.toggle("fn__none", key !== workspace);
        });
        if (workspace === "inbox") {
            if (!inboxView) {
                inboxView = mountInboxView({
                    i18n: host.i18n,
                    app: host.app,
                    getInbox: host.getInbox,
                    getColdItems: host.getColdItems,
                    getNextActionCandidate: host.getNextActionCandidate,
                    clarifyItem: host.clarifyItem,
                    archiveAsKnowledge: host.archiveAsKnowledge,
                    coldItem: host.coldItem,
                    openFullscreen: () => host.openFullscreen?.("inbox"),
                }, pages.inbox);
            } else {
                void inboxView.refresh();
            }
            return;
        }
        if (workspace === "tasks") {
            switchTaskMode(activeTaskMode, true);
            return;
        }
        if (workspace === "habits") {
            if (!habitView) {
                habitView = mountHabitView({
                    i18n: host.i18n,
                    getHabits: host.getHabits,
                    saveHabits: host.saveHabits,
                    startHabitPomodoro: host.startHabitPomodoro,
                    getPomodoroState: host.getPomodoroState,
                }, pages.habits);
            } else {
                void habitView.refresh();
            }
            return;
        }
        if (!knowledgeView) {
            knowledgeView = mountResourceView("knowledge", knowledgeHost, pages.knowledge);
        } else {
            void knowledgeView.refresh();
        }
    };

    switchWorkspace(initialTab);

    const refreshActive = async () => {
        if (activeWorkspace === "inbox") {
            await inboxView?.refresh();
        } else if (activeWorkspace === "tasks") {
            if (activeTaskMode === "list") {
                await taskListView?.refresh();
            } else if (activeTaskMode === "quadrant") {
                await quadrantView?.refresh();
            } else {
                await timelineView?.refresh();
            }
        } else if (activeWorkspace === "habits") {
            await habitView?.refresh();
        } else if (activeWorkspace === "knowledge") {
            await knowledgeView?.refresh();
        }
    };

    const handleClick = async (event: Event) => {
        const workspaceButton = (event.target as HTMLElement).closest<HTMLElement>("[data-workspace]");
        if (workspaceButton) {
            const workspace = workspaceButton.dataset.workspace as Workspace;
            if (workspace === "inbox" || workspace === "tasks" || workspace === "habits" || workspace === "knowledge") {
                switchWorkspace(workspace);
            }
            return;
        }
        const modeButton = (event.target as HTMLElement).closest<HTMLElement>("[data-task-mode]");
        if (modeButton) {
            const mode = modeButton.dataset.taskMode as TaskMode;
            if (mode === "list" || mode === "quadrant" || mode === "timeline") {
                switchTaskMode(mode);
            }
            return;
        }
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
        if (!target) {
            return;
        }
        const action = target.dataset.action;
        if (action === "refresh") {
            await refreshActive();
            return;
        }
        if (action === "close") {
            options.onClose?.();
            return;
        }
        if (action === "fullscreen" && activeWorkspace) {
            host.openFullscreen?.(activeWorkspace);
        }
    };

    contentRoot.addEventListener("click", handleClick);

    return {
        refresh: refreshActive,
        destroy: () => {
            contentRoot.removeEventListener("click", handleClick);
            inboxView?.destroy();
            inboxView = undefined;
            taskListView?.destroy();
            taskListView = undefined;
            timelineView?.destroy();
            timelineView = undefined;
            quadrantView?.destroy();
            quadrantView = undefined;
            habitView?.destroy();
            habitView = undefined;
            knowledgeView?.destroy();
            knowledgeView = undefined;
            contentRoot.innerHTML = "";
            actionRoot.innerHTML = "";
            actionRoot.style.display = "none";
        },
    };
};

export const openScheduleTaskDialog = (
    host: TaskDialogHost,
    options: {task?: Task; tasks?: Task[]; onSaved?: (date: string, time: string) => void},
) => {
    const candidates = options.task
        ? [options.task]
        : (options.tasks ?? []).filter((task) => task.type === "task");
    if (candidates.length === 0) {
        showMessage(t(host, "scheduleNoTasks", "There are no tasks to schedule."), 4000, "error");
        return;
    }
    const initial = candidates[0];
    const taskOptions = candidates.map((task) => {
        const due = task.dueDate ? `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : t(host, "groupNone", "No due date");
        const label = task.parentTitle ? `↳ ${task.parentTitle} › ${task.title}` : task.title;
        return `<option value="${task.id}">${escapeHtml(`${label} · ${due}`)}</option>`;
    }).join("");
    const dialog = new Dialog({
        title: t(host, "scheduleTitle", "Schedule on timeline"),
        content: `<div class="b3-dialog__content">
  ${options.task ? "" : `<div class="ts-field"><label>${escapeHtml(t(host, "scheduleTaskSelect", "Choose task"))}</label>
    <select class="b3-select fn__block" data-schedule-task>${taskOptions}</select></div>`}
  <div class="ts-field"><label>${escapeHtml(t(host, "dueDate", "Date"))}</label>
    <input class="b3-text-field fn__block" type="date" data-schedule-date value="${escapeHtml(initial.dueDate || dateKey())}"></div>
  <div class="ts-field"><label>${escapeHtml(t(host, "scheduleTime", "Time"))}</label>
    <input class="b3-text-field fn__block" type="time" data-schedule-time value="${escapeHtml(initial.dueTime || "09:00")}"></div>
  <div class="ts-help">${escapeHtml(t(host, "scheduleHelp", "Set a date and time; the task will appear at that time in the timeline."))}</div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-cancel>${escapeHtml(t(host, "cancel", "Cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-save>${escapeHtml(t(host, "save", "Save"))}</button>
</div>`,
        width: getFrontend().startsWith("mobile") ? "92vw" : "440px",
    });

    const taskSelect = dialog.element.querySelector<HTMLSelectElement>("[data-schedule-task]");
    const dateInput = dialog.element.querySelector<HTMLInputElement>("[data-schedule-date]")!;
    const timeInput = dialog.element.querySelector<HTMLInputElement>("[data-schedule-time]")!;
    const saveButton = dialog.element.querySelector<HTMLButtonElement>("[data-save]")!;
    const selectedTask = () => options.task
        || candidates.find((task) => task.id === taskSelect?.value)
        || initial;
    const syncFields = () => {
        const task = selectedTask();
        dateInput.value = task.dueDate || dateKey();
        timeInput.value = task.dueTime || "09:00";
    };
    taskSelect?.addEventListener("change", syncFields);

    const submit = async () => {
        const task = selectedTask();
        const date = dateInput.value || dateKey();
        const time = timeInput.value;
        saveButton.disabled = true;
        try {
            await host.saveTaskMeta(
                task,
                date,
                time,
                task.priority,
                task.reminderMinutes ?? null,
            );
            const when = time ? `${date} ${time}` : date;
            showMessage(t(host, "scheduleSavedAt", "Scheduled on ${when}.", {when}), 3000);
            dialog.destroy();
            options.onSaved?.(date, time);
        } catch (error) {
            showMessage(t(host, "saveFailed", "Failed to save: ${msg}", {msg: errorMessage(error)}), 6000, "error");
        } finally {
            saveButton.disabled = false;
        }
    };

    dialog.element.querySelector("[data-save]")?.addEventListener("click", () => void submit());
    dialog.element.querySelector("[data-cancel]")?.addEventListener("click", () => dialog.destroy());
    timeInput.focus();
};

export const openAddTaskDialog = (
    host: TaskDialogHost,
    preset: {dueDate?: string; type?: TaskType; priority?: Priority} = {},
) => {
    const type = preset.type ?? "task";
    const dueDate = preset.dueDate ?? dateKey();
    const priority = preset.priority ?? 2;
    const dialog = new Dialog({
        title: t(host, "addTaskTitle", "New item"),
        content: `<div class="b3-dialog__content">
  <div class="ts-field"><label>${escapeHtml(t(host, "taskTitle", "Title"))}</label>
    <input class="b3-text-field fn__block" data-add-title maxlength="200" placeholder="${escapeHtml(t(host, "addTaskPlaceholder", "What needs to be done?"))}"></div>
  <div class="ts-field"><label>${escapeHtml(t(host, "taskType", "Type"))}</label>
    <select class="b3-select fn__block" data-add-type>
      <option value="task"${type === "task" ? " selected" : ""}>${escapeHtml(t(host, "taskTypeTask", "Task"))}</option>
      <option value="routine"${type === "routine" ? " selected" : ""}>${escapeHtml(t(host, "taskTypeRoutine", "Routine / habit"))}</option>
      <option value="event"${type === "event" ? " selected" : ""}>${escapeHtml(t(host, "taskTypeEvent", "Event"))}</option>
    </select></div>
  <div class="ts-field"><label>${escapeHtml(t(host, "dueDate", "Due date"))}</label>
    <input class="b3-text-field fn__block" type="date" data-add-date value="${escapeHtml(dueDate)}"></div>
  <div class="ts-field"><label>${escapeHtml(t(host, "dueTime", "Time (optional)"))}</label>
    <input class="b3-text-field fn__block" type="time" data-add-time></div>
  <div class="ts-field ts-add-priority${type === "task" ? "" : " fn__none"}"><label>${escapeHtml(t(host, "priority", "Priority"))}</label>
    <select class="b3-select fn__block" data-add-priority>
      <option value="1"${priority === 1 ? " selected" : ""}>${escapeHtml(t(host, "priorityHigh", "High"))}</option>
      <option value="2"${priority === 2 ? " selected" : ""}>${escapeHtml(t(host, "priorityMedium", "Medium"))}</option>
      <option value="3"${priority === 3 ? " selected" : ""}>${escapeHtml(t(host, "priorityLow", "Low"))}</option>
    </select></div>
  <div class="ts-help">${escapeHtml(t(host, "addTaskHelp", "The item is inserted at the cursor of the current document."))}</div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-cancel>${escapeHtml(t(host, "cancel", "Cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-save>${escapeHtml(t(host, "save", "Save"))}</button>
</div>`,
        width: getFrontend().startsWith("mobile") ? "92vw" : "440px",
    });

    const titleInput = dialog.element.querySelector<HTMLInputElement>("[data-add-title]")!;
    const typeSelect = dialog.element.querySelector<HTMLSelectElement>("[data-add-type]")!;
    const priorityField = dialog.element.querySelector<HTMLElement>(".ts-add-priority")!;
    const dateInput = dialog.element.querySelector<HTMLInputElement>("[data-add-date]")!;
    const timeInput = dialog.element.querySelector<HTMLInputElement>("[data-add-time]")!;
    const prioritySelect = dialog.element.querySelector<HTMLSelectElement>("[data-add-priority]")!;
    const saveButton = dialog.element.querySelector<HTMLButtonElement>("[data-save]")!;

    typeSelect.addEventListener("change", () => {
        priorityField.classList.toggle("fn__none", typeSelect.value !== "task");
    });

    const submit = async () => {
        const title = titleInput.value.trim();
        if (!title) {
            showMessage(t(host, "taskTitleRequired", "Please enter a title."), 4000, "error");
            titleInput.focus();
            return;
        }
        if (timeInput.value && !dateInput.value) {
            showMessage(t(host, "timeNeedsDate", "Please choose a due date before a time."), 5000, "error");
            return;
        }
        saveButton.disabled = true;
        try {
            await host.addTask({
                title,
                type: typeSelect.value as TaskType,
                dueDate: dateInput.value || undefined,
                dueTime: timeInput.value || undefined,
                priority: Number(prioritySelect.value) as Priority,
            });
            showMessage(t(host, "saved", "Saved."), 3000);
            dialog.destroy();
        } catch (error) {
            showMessage(t(host, "saveFailed", "Failed to save: ${msg}", {msg: errorMessage(error)}), 6000, "error");
        } finally {
            saveButton.disabled = false;
        }
    };

    dialog.element.querySelector("[data-save]")?.addEventListener("click", () => void submit());
    dialog.element.querySelector("[data-cancel]")?.addEventListener("click", () => dialog.destroy());
    titleInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void submit();
        }
    });
    titleInput.focus();
};

export const showTaskDialog = (
    host: TaskDialogHost,
    initialTasks: Task[],
    options: {fullscreen?: boolean; initialTab?: TaskTab} = {},
) => {
    const isMobile = getFrontend().startsWith("mobile");
    let view: TaskView | undefined;
    const dialog = new Dialog({
        title: t(host, "dialogTitle", "ZhiXing GTD"),
        content: `<div class="b3-dialog__content ts-dialog"><div class="ts-dialog__content"></div></div>
<div class="b3-dialog__action ts-dialog__actions"></div>`,
        width: options.fullscreen ? "100vw" : (isMobile ? "92vw" : "780px"),
        height: options.fullscreen ? "100vh" : "80vh",
        destroyCallback: () => view?.destroy(),
    });
    if (options.fullscreen) {
        const container = dialog.element.querySelector<HTMLElement>(".b3-dialog__container");
        if (container) {
            container.classList.add("ts-dialog--fullscreen");
            container.style.width = "100vw";
            container.style.height = "100vh";
        }
    }
    const content = dialog.element.querySelector<HTMLElement>(".ts-dialog__content")!;
    const actions = dialog.element.querySelector<HTMLElement>(".ts-dialog__actions")!;
    view = mountTaskView(host, content, actions, initialTasks, {
        showClose: true,
        initialTab: options.initialTab,
        onClose: () => dialog.destroy(),
    });
    return dialog;
};

const addHour = (time: string): string => {
    const match = String(time || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
        return "10:00";
    }
    const total = Math.min(23 * 60 + 59, Number(match[1]) * 60 + Number(match[2]) + 60);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const quadrantOptions = (host: TaskDialogHost, current?: GtdQuadrant) =>
    [
        {key: "q1" as GtdQuadrant, label: "quadrantQ1", tag: "quadrantQ1Tag"},
        {key: "q2" as GtdQuadrant, label: "quadrantQ2", tag: "quadrantQ2Tag"},
        {key: "q3" as GtdQuadrant, label: "quadrantQ3", tag: "quadrantQ3Tag"},
        {key: "q4" as GtdQuadrant, label: "quadrantQ4", tag: "quadrantQ4Tag"},
    ].map((quadrant) => `<option value="${quadrant.key}"${quadrant.key === (current || "q2") ? " selected" : ""}>${escapeHtml(t(host, quadrant.label, quadrant.key))} · ${escapeHtml(t(host, quadrant.tag, quadrant.key))}</option>`).join("");

const reminderOptions = (host: TaskDialogHost, current?: number) => `
      <option value="global"${current === undefined ? " selected" : ""}>${escapeHtml(t(host, "reminderGlobal", "Use global setting"))}</option>
      <option value="-1"${current === -1 ? " selected" : ""}>${escapeHtml(t(host, "reminderAtTime", "At task time"))}</option>
      <option value="0"${current === 0 ? " selected" : ""}>${escapeHtml(t(host, "reminderOff", "No reminder"))}</option>
      ${[5, 15, 30, 60, 120, 1440].map((minutes) => `<option value="${minutes}"${current === minutes ? " selected" : ""}>${escapeHtml(t(host, `reminder${minutes}`, ` ${minutes} minutes before`))}</option>`).join("")}
      ${current !== undefined && ![-1, 0, 5, 15, 30, 60, 120, 1440].includes(current)
        ? `<option value="${current}" selected>${escapeHtml(t(host, "reminderCustom", "${minutes} minutes before", {minutes: current}))}</option>`
        : ""}`;

export const openTaskEditDialog = (host: TaskDialogHost, task: Task, onSaved: () => void) => {
    const planEnabled = Boolean(task.planDate && task.planStart);
    const planDate = task.planDate || task.dueDate || dateKey();
    const planStart = task.planStart || task.dueTime || "09:00";
    const planEnd = task.planEnd || addHour(planStart);
    const canArrange = Boolean(task.clarified);
    const dialog = new Dialog({
        title: t(host, "taskEditTitle", "Task settings"),
        content: `<div class="b3-dialog__content ts-task-settings">
  <section class="ts-form-section">
    <div class="ts-form-section__title">${escapeHtml(t(host, "taskSectionBasic", "Basics"))}</div>
    <div class="ts-field"><label>${escapeHtml(t(host, "taskTitle", "Task title"))}</label>
      <input class="b3-text-field fn__block" data-task-title maxlength="200" value="${escapeHtml(task.title)}"></div>
    <div class="ts-form-row">
      <div class="ts-field"><label>${escapeHtml(t(host, "taskType", "Type"))}</label>
        <select class="b3-select fn__block" data-task-type>
          <option value="task"${task.type === "task" ? " selected" : ""}>${escapeHtml(t(host, "taskTypeTask", "Task"))}</option>
          <option value="routine"${task.type === "routine" ? " selected" : ""}>${escapeHtml(t(host, "taskTypeRoutine", "Routine / habit"))}</option>
          <option value="event"${task.type === "event" ? " selected" : ""}>${escapeHtml(t(host, "taskTypeEvent", "Event"))}</option>
        </select></div>
      <div class="ts-field ts-task-priority-field${task.type === "task" ? "" : " fn__none"}"><label>${escapeHtml(t(host, "priority", "Priority"))}</label>
        <select class="b3-select fn__block" data-priority>
          <option value="1"${task.priority === 1 ? " selected" : ""}>${escapeHtml(t(host, "priorityHigh", "High"))}</option>
          <option value="2"${task.priority === 2 ? " selected" : ""}>${escapeHtml(t(host, "priorityMedium", "Medium"))}</option>
          <option value="3"${task.priority === 3 ? " selected" : ""}>${escapeHtml(t(host, "priorityLow", "Low"))}</option>
        </select></div>
    </div>
    ${canArrange ? `<div class="ts-field ts-gtd-field${task.type === "task" ? "" : " fn__none"}"><label>${escapeHtml(t(host, "taskQuadrant", "Quadrant"))}</label>
      <select class="b3-select fn__block" data-quadrant>${quadrantOptions(host, task.quadrant)}</select></div>` : `<div class="ts-help">${escapeHtml(t(host, "taskGtdUnavailable", "This task has not been arranged yet. Arrange it from the inbox before setting a quadrant or time block."))}</div>`}
  </section>
  <section class="ts-form-section">
    <div class="ts-form-section__title">${escapeHtml(t(host, "taskSectionDeadline", "Deadline"))}</div>
    <div class="ts-form-row">
      <div class="ts-field"><label>${escapeHtml(t(host, "dueDate", "Due date"))}</label>
        <input class="b3-text-field fn__block" type="date" data-due-date value="${escapeHtml(task.dueDate || "")}"></div>
      <div class="ts-field"><label>${escapeHtml(t(host, "dueTime", "Due time (optional)"))}</label>
        <input class="b3-text-field fn__block" type="time" data-due-time value="${escapeHtml(task.dueTime || "")}"></div>
    </div>
    <div class="ts-help">${escapeHtml(t(host, "taskDeadlineHelp", "The deadline is used for overdue and reminders; leave it empty if there is no deadline."))}</div>
  </section>
  <section class="ts-form-section ts-gtd-field${canArrange && task.type === "task" ? "" : " fn__none"}">
    <div class="ts-form-section__title">${escapeHtml(t(host, "taskSectionBlock", "Execution block"))}</div>
    <label class="ts-task-plan__toggle"><input type="checkbox" data-plan-enabled${planEnabled ? " checked" : ""}><span>${escapeHtml(t(host, "taskPlanToggle", "Schedule an execution block on the timeline"))}</span></label>
    <div class="ts-task-plan__fields${planEnabled ? "" : " fn__none"}" data-plan-fields>
      <div class="ts-field"><label>${escapeHtml(t(host, "planDate", "Date"))}</label>
        <input class="b3-text-field fn__block" type="date" data-plan-date value="${escapeHtml(planDate)}"></div>
      <div class="ts-field"><label>${escapeHtml(t(host, "planStart", "Start"))}</label>
        <input class="b3-text-field fn__block" type="time" data-plan-start value="${escapeHtml(planStart)}"></div>
      <div class="ts-field"><label>${escapeHtml(t(host, "planEnd", "End"))}</label>
        <input class="b3-text-field fn__block" type="time" data-plan-end value="${escapeHtml(planEnd)}"></div>
    </div>
    <div class="ts-help">${escapeHtml(t(host, "taskBlockHelp", "The block appears on the timeline. Its end time does not trigger a reminder. Unchecking removes the block."))}</div>
  </section>
  <section class="ts-form-section">
    <div class="ts-form-section__title">${escapeHtml(t(host, "taskSectionReminder", "Reminder"))}</div>
    <div class="ts-field"><label>${escapeHtml(t(host, "reminder", "Reminder"))}</label>
      <select class="b3-select fn__block" data-reminder>${reminderOptions(host, task.reminderMinutes)}</select></div>
    <div class="ts-help">${escapeHtml(t(host, "taskReminderHelp", "Reminders use the nearer of the deadline and the block start, and also remind at that time. Choose No reminder to disable them."))}</div>
  </section>
  <div class="ts-help">${escapeHtml(t(host, "taskEditHelp", "Saving updates the task, deadline, quadrant, time block, and reminder together."))}</div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-cancel>${escapeHtml(t(host, "cancel", "Cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-save>${escapeHtml(t(host, "save", "Save"))}</button>
</div>`,
        width: getFrontend().startsWith("mobile") ? "92vw" : "560px",
    });

    const titleInput = dialog.element.querySelector<HTMLInputElement>("[data-task-title]")!;
    const typeSelect = dialog.element.querySelector<HTMLSelectElement>("[data-task-type]")!;
    const priorityField = dialog.element.querySelector<HTMLElement>(".ts-task-priority-field")!;
    const gtdFields = [...dialog.element.querySelectorAll<HTMLElement>(".ts-gtd-field")];
    const dateInput = dialog.element.querySelector<HTMLInputElement>("[data-due-date]")!;
    const timeInput = dialog.element.querySelector<HTMLInputElement>("[data-due-time]")!;
    const prioritySelect = dialog.element.querySelector<HTMLSelectElement>("[data-priority]")!;
    const quadrantSelect = dialog.element.querySelector<HTMLSelectElement>("[data-quadrant]");
    const reminderSelect = dialog.element.querySelector<HTMLSelectElement>("[data-reminder]")!;
    const planToggle = dialog.element.querySelector<HTMLInputElement>("[data-plan-enabled]")!;
    const planFields = dialog.element.querySelector<HTMLElement>("[data-plan-fields]")!;
    const planDateInput = dialog.element.querySelector<HTMLInputElement>("[data-plan-date]")!;
    const planStartInput = dialog.element.querySelector<HTMLInputElement>("[data-plan-start]")!;
    const planEndInput = dialog.element.querySelector<HTMLInputElement>("[data-plan-end]")!;
    const saveButton = dialog.element.querySelector<HTMLButtonElement>("[data-save]")!;

    const updateVisibility = () => {
        const isTask = typeSelect.value === "task";
        priorityField.classList.toggle("fn__none", !isTask);
        gtdFields.forEach((field) => field.classList.toggle("fn__none", !isTask || !canArrange));
    };
    typeSelect.addEventListener("change", updateVisibility);
    updateVisibility();

    const updatePlanFields = () => {
        planFields.classList.toggle("fn__none", !planToggle.checked);
    };
    planToggle.addEventListener("change", updatePlanFields);
    updatePlanFields();

    const save = async () => {
        const title = titleInput.value.trim();
        if (!title) {
            showMessage(t(host, "taskTitleRequired", "Please enter a task title."), 4000, "error");
            titleInput.focus();
            return;
        }
        const dueDate = dateInput.value;
        const dueTime = timeInput.value;
        if (dueTime && !dueDate) {
            showMessage(t(host, "timeNeedsDate", "Please choose a due date before a time."), 5000, "error");
            return;
        }
        const type = typeSelect.value as TaskType;
        const manageGtd = canArrange && type === "task";
        const planDateValue = planDateInput.value;
        const planStartValue = planStartInput.value;
        const planEndValue = planEndInput.value;
        if (manageGtd && planToggle.checked) {
            if (!planDateValue || !planStartValue || !planEndValue) {
                showMessage(t(host, "planInvalid", "Choose a valid time block."), 4000, "error");
                return;
            }
            if (planEndValue <= planStartValue) {
                showMessage(t(host, "planInvalid", "Choose a date where the end time is later than the start."), 4000, "error");
                return;
            }
        }
        const reminder = reminderSelect.value === "global" ? null : Number(reminderSelect.value);
        saveButton.disabled = true;
        try {
            await host.updateTask(
                task,
                title,
                type,
                dueDate,
                dueTime,
                Number(prioritySelect.value) as Priority,
                reminder,
            );
            if (manageGtd) {
                const quadrant = (quadrantSelect?.value || "q2") as GtdQuadrant;
                if (quadrant !== task.quadrant) {
                    await host.setTaskQuadrant(task, quadrant);
                }
                const hadPlan = Boolean(task.planDate && task.planStart);
                if (planToggle.checked) {
                    if (!hadPlan || planDateValue !== task.planDate || planStartValue !== task.planStart || planEndValue !== task.planEnd) {
                        await host.setPlanBlock(task, planDateValue, planStartValue, planEndValue);
                    }
                } else if (hadPlan) {
                    await host.clearPlanBlock(task);
                }
            }
            showMessage(t(host, "saved", "Saved."), 3000);
            dialog.destroy();
            onSaved();
        } catch (error) {
            showMessage(t(host, "saveFailed", "Failed to save: ${msg}", {msg: errorMessage(error)}), 6000, "error");
        } finally {
            saveButton.disabled = false;
        }
    };

    dialog.element.querySelector("[data-save]")?.addEventListener("click", () => void save());
    dialog.element.querySelector("[data-cancel]")?.addEventListener("click", () => dialog.destroy());
    titleInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void save();
        }
    });
    titleInput.focus();
    titleInput.select();
};

export const openTaskMetaDialog = (host: TaskDialogHost, task: Task, onSaved: () => void) => {
    const dialog = new Dialog({
        title: t(host, "metaTitle", "Due date and priority"),
        content: `<div class="b3-dialog__content">
  <div class="ts-field"><label>${escapeHtml(t(host, "dueDate", "Due date"))}</label>
    <input class="b3-text-field fn__block" type="date" data-due-date value="${escapeHtml(task.dueDate || "")}"></div>
  <div class="ts-field"><label>${escapeHtml(t(host, "dueTime", "Time (optional)"))}</label>
    <input class="b3-text-field fn__block" type="time" data-due-time value="${escapeHtml(task.dueTime || "")}"></div>
  <div class="ts-help">${escapeHtml(t(host, "taskTimeHelp", "The deadline is used for overdue and reminders."))}</div>
  ${task.planDate && task.planStart ? `<div class="ts-help">${escapeHtml(t(host, "taskPlanInfo", "Scheduled block: ${time}", {time: `${task.planDate} ${task.planStart}${task.planEnd ? `–${task.planEnd}` : ""}`}))}</div>` : ""}
  <div class="ts-field"><label>${escapeHtml(t(host, "priority", "Priority"))}</label>
    <select class="b3-select fn__block" data-priority>
      <option value="1"${task.priority === 1 ? " selected" : ""}>${escapeHtml(t(host, "priorityHigh", "High"))}</option>
      <option value="2"${task.priority === 2 ? " selected" : ""}>${escapeHtml(t(host, "priorityMedium", "Medium"))}</option>
      <option value="3"${task.priority === 3 ? " selected" : ""}>${escapeHtml(t(host, "priorityLow", "Low"))}</option>
    </select></div>
  <div class="ts-field"><label>${escapeHtml(t(host, "reminder", "Reminder"))}</label>
    <select class="b3-select fn__block" data-reminder>
      <option value="global"${task.reminderMinutes === undefined ? " selected" : ""}>${escapeHtml(t(host, "reminderGlobal", "Use global setting"))}</option>
      <option value="-1"${task.reminderMinutes === -1 ? " selected" : ""}>${escapeHtml(t(host, "reminderAtTime", "At task time"))}</option>
      <option value="0"${task.reminderMinutes === 0 ? " selected" : ""}>${escapeHtml(t(host, "reminderOff", "No reminder"))}</option>
      ${[5, 15, 30, 60, 120, 1440].map((minutes) => `<option value="${minutes}"${task.reminderMinutes === minutes ? " selected" : ""}>${escapeHtml(t(host, `reminder${minutes}`, ` ${minutes} minutes before`))}</option>`).join("")}
      ${task.reminderMinutes !== undefined && ![-1, 0, 5, 15, 30, 60, 120, 1440].includes(task.reminderMinutes)
        ? `<option value="${task.reminderMinutes}" selected>${escapeHtml(t(host, "reminderCustom", "${minutes} minutes before", {minutes: task.reminderMinutes}))}</option>`
        : ""}
    </select></div>
  <div class="ts-help">${escapeHtml(t(host, "metaHelp", "You can also write @YYYY-MM-DD and !高/!中/!低 in the task text."))}</div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--remove" data-clear>${escapeHtml(t(host, "clearDue", "Clear due date"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--cancel" data-cancel>${escapeHtml(t(host, "cancel", "Cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-save>${escapeHtml(t(host, "save", "Save"))}</button>
</div>`,
        width: getFrontend().startsWith("mobile") ? "92vw" : "480px",
    });

    const dateInput = dialog.element.querySelector<HTMLInputElement>("[data-due-date]")!;
    const timeInput = dialog.element.querySelector<HTMLInputElement>("[data-due-time]")!;
    const prioritySelect = dialog.element.querySelector<HTMLSelectElement>("[data-priority]")!;
    const reminderSelect = dialog.element.querySelector<HTMLSelectElement>("[data-reminder]")!;
    const saveButton = dialog.element.querySelector<HTMLButtonElement>("[data-save]")!;

    const save = async (clear: boolean) => {
        saveButton.disabled = true;
        try {
            const dueDate = clear ? "" : dateInput.value;
            const dueTime = clear ? "" : timeInput.value;
            if (dueTime && !dueDate) {
                showMessage(t(host, "timeNeedsDate", "Please choose a due date before a time."), 5000, "error");
                return;
            }
            const reminder = reminderSelect.value === "global" ? null : Number(reminderSelect.value);
            await host.saveTaskMeta(task, dueDate, dueTime, Number(prioritySelect.value) as Priority, reminder);
            showMessage(t(host, "saved", "Task settings saved."), 3000);
            dialog.destroy();
            onSaved();
        } catch (error) {
            showMessage(t(host, "saveFailed", "Failed to save: ${msg}", {msg: errorMessage(error)}), 6000, "error");
        } finally {
            saveButton.disabled = false;
        }
    };

    dialog.element.querySelector("[data-save]")?.addEventListener("click", () => void save(false));
    dialog.element.querySelector("[data-clear]")?.addEventListener("click", () => void save(true));
    dialog.element.querySelector("[data-cancel]")?.addEventListener("click", () => dialog.destroy());
    dateInput.focus();
};
