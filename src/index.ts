import {Dialog, Plugin, fetchSyncPost, getActiveEditor, getFrontend, isRightDockVisible, openTab, platformUtils, showMessage, toggleRightDock} from "siyuan";
import "./index.scss";
import {DEFAULT_CLOUD_CONFIG, uploadICS, type CloudConfig, type CloudMode} from "./cloud";
import {forwardProxyPut} from "./cloud-put";
import {buildICS} from "./ics";
import {showQuickToolbar, type QuickPatch, type QuickToolbar} from "./quick-toolbar";
import {mountTaskView, openTaskEditDialog, showTaskDialog, type TaskDialogHost, type TaskTab, type TaskView} from "./task-dialog";
import {
    DUE_ATTR,
    PRIORITY_ATTR,
    TYPE_ATTR,
    clarifyBlock,
    clearPlanBlock,
    completeNextAction,
    deleteTask as deleteTaskBlock,
    fetchExecutionTasks,
    fetchTaskByID,
    fetchTasks,
    getNextActionCandidate,
    markTaskDone,
    saveTaskMeta,
    archiveCapture,
    setCaptureCold,
    setPlanBlock,
    setTaskQuadrant,
    updateTask as updateTaskContent,
} from "./task-store";
import {cleanCaptureMarkdown, fetchColdItems, fetchInboxItems, fetchKnowledgeItems} from "./inbox-store";
import {addCheckIn, addFocusMinutes, dateKey, habitDone, isScheduled, normalizeHabits, type Habit} from "./habit-store";
import type {InboxItem, NewTaskInput, Task} from "./types";
import {mountHabitView, type HabitView} from "./habit-view";
import {PomodoroTimer, type PomodoroPhase, type PomodoroState, type PomodoroTarget} from "./pomodoro";
import {openScreeningOverlay, type ScreeningOverlay} from "./screening";

declare global {
    interface Window {
        /** Bridge used by the //!js habit embed block. */
        __taskSecretaryHabits?: (element: HTMLElement) => void;
    }
}

interface Config {
    showOnStartup: boolean;
    screeningAutoOpen: boolean;
    reminderMinutes: number;
    eventTime: string;
    includeOverdue: boolean;
    autoUploadMinutes: number;
    clickTaskMenu: boolean;
    pomodoroFocusMinutes: number;
    pomodoroBreakMinutes: number;
    inboxDays: number;
    inboxNotebook: string;
    inboxDoc: string;
    cloud: CloudConfig;
    lastSubscriptionUrl: string;
}

const DEFAULT_CONFIG: Config = {
    showOnStartup: true,
    screeningAutoOpen: true,
    reminderMinutes: 30,
    eventTime: "09:00",
    includeOverdue: true,
    autoUploadMinutes: 30,
    clickTaskMenu: true,
    pomodoroFocusMinutes: 25,
    pomodoroBreakMinutes: 5,
    inboxDays: 30,
    inboxNotebook: "",
    inboxDoc: "",
    cloud: {...DEFAULT_CLOUD_CONFIG},
    lastSubscriptionUrl: "",
};

interface ScreeningState {
    version: 1;
    lastAutoDate: string;
    speed: number;
    position: number;
    positionDate: string;
}

const DEFAULT_SCREENING_STATE: ScreeningState = {
    version: 1,
    lastAutoDate: "",
    speed: 24,
    position: 0,
    positionDate: "",
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const escapeAttr = (value: string) => value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const makeBlockIdentity = () => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
        + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return {stamp, id: `${stamp}-${Math.random().toString(36).slice(2, 9)}`};
};

const textValue = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;

const normalizeCloud = (raw: any): CloudConfig => {
    const mode = raw?.mode;
    return {
        mode: (mode === "aliyun" || mode === "put" ? mode : "off") as CloudMode,
        bucket: textValue(raw?.bucket),
        region: textValue(raw?.region, DEFAULT_CLOUD_CONFIG.region),
        accessKeyId: textValue(raw?.accessKeyId),
        secretName: textValue(raw?.secretName, DEFAULT_CLOUD_CONFIG.secretName),
        objectKey: textValue(raw?.objectKey, DEFAULT_CLOUD_CONFIG.objectKey),
        publicUrl: textValue(raw?.publicUrl),
        uploadUrl: textValue(raw?.uploadUrl),
        subscriptionUrl: textValue(raw?.subscriptionUrl),
        headers: textValue(raw?.headers, DEFAULT_CLOUD_CONFIG.headers),
    };
};

export default class TaskSecretary extends Plugin {
    private config: Config = {
        ...DEFAULT_CONFIG,
        cloud: {...DEFAULT_CLOUD_CONFIG},
    };
    private showOnStartupInput!: HTMLInputElement;
    private screeningAutoInput!: HTMLInputElement;
    private reminderInput!: HTMLSelectElement;
    private eventTimeInput!: HTMLInputElement;
    private includeOverdueInput!: HTMLInputElement;
    private autoUploadInput!: HTMLInputElement;
    private clickTaskMenuInput!: HTMLInputElement;
    private pomodoroFocusInput!: HTMLInputElement;
    private pomodoroBreakInput!: HTMLInputElement;
    private inboxDaysInput!: HTMLInputElement;
    private inboxNotebookInput!: HTMLSelectElement;
    private inboxDocInput!: HTMLSelectElement;
    private cloudModeInput!: HTMLSelectElement;
    private cloudBucketInput!: HTMLInputElement;
    private cloudRegionInput!: HTMLInputElement;
    private cloudAccessKeyInput!: HTMLInputElement;
    private cloudSecretNameInput!: HTMLInputElement;
    private cloudObjectKeyInput!: HTMLInputElement;
    private cloudPublicUrlInput!: HTMLInputElement;
    private cloudUploadUrlInput!: HTMLInputElement;
    private cloudSubscriptionUrlInput!: HTMLInputElement;
    private cloudHeadersInput!: HTMLTextAreaElement;
    private taskDialog?: Dialog;
    private settingsDialog?: Dialog;
    private taskPanelView?: TaskView;
    private quickToolbar?: QuickToolbar;
    private readonly embedViews = new Map<HTMLElement, HabitView>();
    private autoUploadTimer?: number;
    private autoUploadDebounce?: number;
    private taskRefreshDebounce?: number;
    private autoUploading = false;
    private pomodoro?: PomodoroTimer;
    private pomodoroChannel?: BroadcastChannel;
    private pomodoroWindow?: any;
    private pomodoroState: PomodoroState | null = null;
    private reminderTimer?: number;
    private nextReminderTimer?: number;
    private reminderCheckDebounce?: number;
    private reminderChecking = false;
    private reminderLastCheck = 0;
    private backgroundThrottlingBefore?: boolean;
    private reminderToastRoot?: HTMLElement;
    private screening?: ScreeningOverlay;
    private screeningState: ScreeningState = {...DEFAULT_SCREENING_STATE};
    private screeningStateSaveTimer?: number;
    private readonly firedReminders = new Set<string>();
    private readonly pomodoroChannelName = `task-secretary-pomodoro-${Math.random().toString(36).slice(2)}`;
    private disposed = false;

    private readonly onBlockIcon = ({detail}: CustomEvent<{
        blockElements: HTMLElement[];
        menu: any;
    }>) => {
        const element = detail.blockElements.find((item) =>
            item.getAttribute("data-type") === "NodeListItem" && item.getAttribute("data-subtype") === "t");
        const id = element?.getAttribute("data-node-id");
        if (!id) {
            return;
        }
        detail.menu.addItem({
            id: `${this.name}-task-meta`,
            icon: "iconTaskSecretary",
            label: this.text("setTaskMeta"),
            click: () => void this.openTaskMeta(id),
        });
    };

    private readonly onTaskMarkerClick = (event: MouseEvent) => {
        if (this.disposed || event.button !== 0) {
            return;
        }
        const marker = (event.target as HTMLElement)?.closest?.(".protyle-action--task");
        if (!marker) {
            return;
        }
        window.setTimeout(() => {
            if (!this.disposed) {
                window.dispatchEvent(new CustomEvent("task-secretary-tasks-changed"));
            }
        }, 450);
    };

    private readonly onWsMain = ({detail}: CustomEvent<any>) => {
        if (detail?.cmd !== "transactions" || this.disposed) {
            return;
        }
        if (this.taskRefreshDebounce) {
            window.clearTimeout(this.taskRefreshDebounce);
        }
        this.taskRefreshDebounce = window.setTimeout(() => {
            this.taskRefreshDebounce = undefined;
            if (!this.disposed) {
                window.dispatchEvent(new CustomEvent("task-secretary-tasks-changed"));
            }
        }, 350);
    };

    private readonly onTaskClick = (event: MouseEvent) => {
        if (!this.config.clickTaskMenu || this.disposed) {
            return;
        }
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        const target = event.target as HTMLElement;
        if (!target?.closest || target.closest(".protyle-action--task, input, a, [data-type~='block-ref'], [data-type~='a'], img")) {
            return;
        }
        const item = target.closest<HTMLElement>('[data-type="NodeListItem"][data-subtype="t"]');
        if (!item || !item.closest(".protyle-wysiwyg")) {
            return;
        }
        const id = item.getAttribute("data-node-id");
        if (!id) {
            return;
        }
        window.setTimeout(() => {
            void this.openQuickMenu(id, item);
        }, 0);
    };

    private text(key: string): string {
        const value = this.i18n?.[key];
        return typeof value === "string" ? value : key;
    }

    async onload() {
        await this.loadConfig();
        this.screeningState = await this.loadScreeningState();
        this.pomodoro = new PomodoroTimer({
            onState: (state) => this.onPomodoroState(state),
            onTick: (state) => this.onPomodoroTick(state),
            onPhaseComplete: (phase, state) => void this.onPomodoroPhaseComplete(phase, state),
        });
        this.destroyStalePomodoroWindow();
        window.addEventListener("click", this.onTaskClick, true);
        window.addEventListener("click", this.onTaskMarkerClick, true);

        this.addIcons(`<symbol id="iconTaskSecretary" viewBox="0 0 32 32">
<path d="M9 3h14a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H9zm2 4h10v2H11V9zm0 4h10v2H11v-2zm0 4h6v2h-6v-2z"/>
</symbol>
<symbol id="iconTaskSecretaryHabit" viewBox="0 0 32 32">
<path d="M7 4h18a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v20h18V6H7zm2 4 1.5 1.5 3-3L15 10l-4.5 4.5L8 12l1-1zm0 7 1.5 1.5 3-3L15 17l-4.5 4.5L8 19l1-1zm6-6h6v2h-6v-2zm0 7h6v2h-6v-2z"/>
</symbol>`);

        this.addCommand({
            langKey: "openTaskSecretary",
            hotkey: "⇧⌘T",
            execute: () => this.openTaskDock(),
        });

        this.addCommand({
            langKey: "insertHabitEmbed",
            hotkey: "⇧⌘H",
            editorCallback: () => this.insertHabitEmbed(),
        });

        window.__taskSecretaryHabits = this.mountHabitEmbed;

        this.addDock({
            type: "task-panel",
            config: {
                position: "RightTop",
                size: {width: 380, height: 0},
                icon: "iconTaskSecretary",
                title: this.text("panelTitle"),
            },
            data: null,
            init: (dock) => {
                void this.mountTaskPanel(dock.element);
            },
            destroy: () => {
                this.taskPanelView?.destroy();
                this.taskPanelView = undefined;
            },
        });

        this.eventBus.on("click-blockicon", this.onBlockIcon);
        this.eventBus.on("ws-main", this.onWsMain);
    }

    onLayoutReady() {
        if (window.siyuan.isPublish) {
            return;
        }
        try {
            const remote = (window as any).require?.("@electron/remote");
            const webContents = remote?.getCurrentWindow?.()?.webContents;
            if (webContents?.setBackgroundThrottling) {
                this.backgroundThrottlingBefore = typeof webContents.getBackgroundThrottling === "function"
                    ? webContents.getBackgroundThrottling()
                    : undefined;
                webContents.setBackgroundThrottling(false);
            }
        } catch (error) {
            console.warn("[task-secretary] background throttling setup failed", error);
        }
        this.addTopBar({
            icon: "iconTaskSecretary",
            title: this.text("topBarSettingsTitle"),
            position: "right",
            callback: () => this.openSetting(),
        });
        if (this.config.showOnStartup) {
            window.setTimeout(() => this.openTaskDock(), 800);
        }
        if (this.isDesktopMode() && this.config.screeningAutoOpen) {
            const today = dateKey();
            if (this.screeningState.lastAutoDate !== today) {
                this.screeningState.lastAutoDate = today;
                this.screeningState.positionDate = today;
                this.screeningState.position = 0;
                void this.saveData("screening.json", this.screeningState);
                window.setTimeout(() => {
                    if (!this.disposed && !this.screening) {
                        this.openScreening();
                    }
                }, 1800);
            }
        }
        this.startReminderScheduler();
        this.scheduleAutoUpload();
        if (this.config.cloud.mode !== "off" && this.config.autoUploadMinutes > 0) {
            this.scheduleUploadSoon();
        }
        // JS embeds may have rendered before the plugin bridge was ready (e.g. after a plugin reload).
        window.setTimeout(() => {
            document.querySelectorAll<HTMLElement>('[data-type="NodeBlockQueryEmbed"]').forEach((element) => {
                if ((element.getAttribute("data-content") || "").includes("__taskSecretaryHabits")) {
                    this.mountHabitEmbed(element);
                }
            });
        }, 1200);
    }

    onDataChanged() {
        void this.loadConfig().then(() => this.scheduleAutoUpload());
    }

    onunload() {
        this.disposed = true;
        this.screening?.destroy();
        this.screening = undefined;
        if (this.screeningStateSaveTimer) {
            window.clearTimeout(this.screeningStateSaveTimer);
            this.screeningStateSaveTimer = undefined;
        }
        this.pomodoro?.stop();
        this.pomodoro = undefined;
        this.closePomodoroWindow();
        this.pomodoroChannel?.close();
        this.pomodoroChannel = undefined;
        document.querySelectorAll(".ts-pomodoro-overlay").forEach((element) => element.remove());
        this.eventBus.off("click-blockicon", this.onBlockIcon);
        this.eventBus.off("ws-main", this.onWsMain);
        if (this.taskRefreshDebounce) {
            window.clearTimeout(this.taskRefreshDebounce);
            this.taskRefreshDebounce = undefined;
        }
        window.removeEventListener("click", this.onTaskClick, true);
        window.removeEventListener("click", this.onTaskMarkerClick, true);
        if (this.autoUploadTimer) {
            window.clearInterval(this.autoUploadTimer);
            this.autoUploadTimer = undefined;
        }
        if (this.autoUploadDebounce) {
            window.clearTimeout(this.autoUploadDebounce);
            this.autoUploadDebounce = undefined;
        }
        this.stopReminderScheduler();
        this.reminderToastRoot?.remove();
        this.reminderToastRoot = undefined;
        if (this.backgroundThrottlingBefore !== undefined) {
            try {
                const remote = (window as any).require?.("@electron/remote");
                remote?.getCurrentWindow?.()?.webContents?.setBackgroundThrottling?.(this.backgroundThrottlingBefore);
            } catch (error) {
                console.warn("[task-secretary] background throttling restore failed", error);
            }
        }
        this.taskDialog?.destroy();
        this.taskDialog = undefined;
        this.taskPanelView?.destroy();
        this.taskPanelView = undefined;
        this.quickToolbar?.close();
        this.quickToolbar = undefined;
        if (window.__taskSecretaryHabits === this.mountHabitEmbed) {
            delete window.__taskSecretaryHabits;
        }
        this.embedViews.forEach((view, element) => {
            view.destroy();
            element.querySelector(":scope > .ts-embed")?.remove();
            element.classList.remove("ts-embed-host");
        });
        this.embedViews.clear();
        this.settingsDialog?.destroy();
        this.settingsDialog = undefined;
    }

    openSetting() {
        void this.openSettingsDialog();
    }

    private isDesktopMode(): boolean {
        const frontend = getFrontend();
        return frontend === "desktop" || frontend === "desktop-window";
    }

    private openScreening(): void {
        if (this.screening || !this.isDesktopMode()) {
            return;
        }
        const today = dateKey();
        const position = this.screeningState.positionDate === today ? this.screeningState.position : 0;
        this.screeningState.positionDate = today;
        try {
            this.screening = openScreeningOverlay({
                i18n: this.i18n,
                getTasks: fetchExecutionTasks,
                openTask: (task) => {
                    this.screening?.destroy();
                    this.screening = undefined;
                    openTab({app: this.app, doc: {id: task.id, action: ["cb-get-focus", "cb-get-hl"]}});
                },
                completeNext: async (task) => {
                    const result = await completeNextAction(task);
                    this.notifyTasksChanged();
                    this.scheduleUploadSoon();
                    return result;
                },
                startPomodoro: (task) => this.startTaskPomodoro(task, {completeNext: true}),
                initialSpeed: this.screeningState.speed,
                initialPosition: position,
                onState: (state) => {
                    this.screeningState.speed = state.speed;
                    this.screeningState.position = state.position;
                    this.screeningState.positionDate = today;
                    this.saveScreeningStateSoon();
                },
                onDestroy: () => {
                    this.screening = undefined;
                },
            });
        } catch (error) {
            console.warn("[task-secretary] screening open failed", error);
            showMessage(this.text("saveFailed").replace("${msg}", errorMessage(error)), 5000, "error");
        }
    }

    private async loadScreeningState(): Promise<ScreeningState> {
        try {
            const raw = await this.loadData("screening.json");
            if (!raw || typeof raw !== "object") {
                return {...DEFAULT_SCREENING_STATE};
            }
            const speed = Number(raw.speed);
            return {
                version: 1,
                lastAutoDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.lastAutoDate || "")) ? String(raw.lastAutoDate) : "",
                speed: Number.isFinite(speed) ? Math.max(6, Math.min(120, Math.round(speed))) : DEFAULT_SCREENING_STATE.speed,
                position: Number.isFinite(Number(raw.position)) ? Math.max(0, Math.round(Number(raw.position))) : 0,
                positionDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.positionDate || "")) ? String(raw.positionDate) : "",
            };
        } catch (error) {
            console.warn("[task-secretary] screening state load failed", error);
            return {...DEFAULT_SCREENING_STATE};
        }
    }

    private saveScreeningStateSoon(): void {
        if (this.screeningStateSaveTimer) {
            window.clearTimeout(this.screeningStateSaveTimer);
        }
        this.screeningStateSaveTimer = window.setTimeout(() => {
            this.screeningStateSaveTimer = undefined;
            void this.saveData("screening.json", this.screeningState);
        }, 400);
    }

    private scheduleAutoUpload() {
        if (this.autoUploadTimer) {
            window.clearInterval(this.autoUploadTimer);
            this.autoUploadTimer = undefined;
        }
        const minutes = this.config.autoUploadMinutes;
        if (minutes <= 0 || this.config.cloud.mode === "off") {
            return;
        }
        this.autoUploadTimer = window.setInterval(() => void this.autoUpload(), minutes * 60 * 1000);
    }

    private scheduleUploadSoon() {
        if (this.config.autoUploadMinutes <= 0 || this.config.cloud.mode === "off") {
            return;
        }
        if (this.autoUploadDebounce) {
            window.clearTimeout(this.autoUploadDebounce);
        }
        this.autoUploadDebounce = window.setTimeout(() => {
            this.autoUploadDebounce = undefined;
            void this.autoUpload();
        }, 3000);
    }

    private async autoUpload() {
        if (this.disposed || this.autoUploading || this.config.cloud.mode === "off" || window.siyuan.isPublish) {
            return;
        }
        this.autoUploading = true;
        try {
            const tasks = await fetchTasks();
            const habits = await this.loadHabits();
            if (this.disposed) {
                return;
            }
            const result = buildICS(tasks.filter((task) => task.clarified && !task.archived), {
                reminderMinutes: this.config.reminderMinutes,
                eventTime: this.config.eventTime,
                includeOverdue: this.config.includeOverdue,
                habits,
            });
            const uploaded = await uploadICS(
                result.content,
                this.config.cloud,
                (name) => this.getSecret(name),
                forwardProxyPut,
            );
            if (this.disposed) {
                return;
            }
            const url = uploaded.url;
            const changed = this.config.lastSubscriptionUrl !== url;
            this.config.lastSubscriptionUrl = url;
            if (changed) {
                await this.saveData("config.json", this.config);
            }
            console.log(`[task-secretary] auto uploaded ${result.exported} event(s) to ${url}`);
        } catch (error) {
            console.warn("[task-secretary] auto upload failed", error);
        } finally {
            this.autoUploading = false;
        }
    }

    private async mountTaskPanel(element: Element) {
        element.innerHTML = `<div class="ts-panel"><div class="ts-panel__content"></div><div class="ts-panel__actions"></div></div>`;
        const content = element.querySelector<HTMLElement>(".ts-panel__content")!;
        const actions = element.querySelector<HTMLElement>(".ts-panel__actions")!;
        this.taskPanelView?.destroy();
        this.taskPanelView = undefined;
        try {
            const tasks = await fetchTasks();
            if (this.disposed) {
                return;
            }
            this.taskPanelView = mountTaskView(this.host(), content, actions, tasks, {showClose: false, showFullscreen: true});
        } catch (error) {
            content.innerHTML = "";
            const empty = document.createElement("div");
            empty.className = "ts-empty";
            empty.textContent = this.text("scanFailed").replace("${msg}", errorMessage(error));
            content.append(empty);
        }
    }

    private openTaskDock() {
        const dock = document.querySelector<HTMLElement>('[data-type="task-secretarytask-panel"]');
        if (!dock) {
            void this.showTasks();
            return;
        }
        if (!dock.classList.contains("dock__item--active")) {
            dock.click();
        }
        if (!isRightDockVisible()) {
            toggleRightDock(true);
        }
    }

    private async showTasks(initialTab?: TaskTab, fullscreen = false) {
        try {
            const tasks = await fetchTasks();
            if (this.disposed) {
                return;
            }
            this.taskDialog?.destroy();
            this.taskDialog = showTaskDialog(this.host(), tasks, {fullscreen, initialTab});
        } catch (error) {
            showMessage(this.text("scanFailed").replace("${msg}", errorMessage(error)), 6000, "error");
        }
    }

    private async openTaskMeta(id: string) {
        try {
            const task = await fetchTaskByID(id);
            if (!task) {
                showMessage(this.text("notUnfinished"), 5000, "error");
                return;
            }
            openTaskEditDialog(this.host(), task, () => {});
        } catch (error) {
            showMessage(this.text("scanFailed").replace("${msg}", errorMessage(error)), 6000, "error");
        }
    }

    private async openQuickMenu(id: string, anchor: HTMLElement) {
        try {
            const task = await fetchTaskByID(id);
            if (!task || this.disposed) {
                return;
            }
            this.quickToolbar?.close();
            this.quickToolbar = showQuickToolbar({
                task,
                anchor,
                host: {
                    i18n: this.i18n,
                    getTask: () => task,
                    getGlobalReminder: () => this.config.reminderMinutes,
                    save: async (patch: QuickPatch) => {
                        try {
                            const needsMeta = patch.dueDate !== undefined
                                || patch.dueTime !== undefined
                                || patch.priority !== undefined
                                || patch.reminderMinutes !== undefined;
                            if (needsMeta) {
                                await this.host().saveTaskMeta(
                                    task,
                                    patch.dueDate !== undefined ? patch.dueDate : (task.dueDate || ""),
                                    patch.dueTime !== undefined ? patch.dueTime : (task.dueTime || ""),
                                    patch.priority !== undefined ? patch.priority : task.priority,
                                    patch.reminderMinutes !== undefined
                                        ? patch.reminderMinutes
                                        : (task.reminderMinutes === undefined ? null : task.reminderMinutes),
                                );
                            }
                            if (patch.quadrant !== undefined) {
                                await this.host().setTaskQuadrant(task, patch.quadrant);
                                task.quadrant = patch.quadrant;
                            }
                            if (patch.dueDate !== undefined) {
                                task.dueDate = patch.dueDate || undefined;
                            }
                            if (patch.dueTime !== undefined) {
                                task.dueTime = patch.dueTime || undefined;
                            }
                            if (patch.dueDate !== undefined || patch.dueTime !== undefined) {
                                task.dueSet = true;
                            }
                            if (patch.priority !== undefined) {
                                task.priority = patch.priority;
                                task.prioritySet = true;
                            }
                            if (patch.reminderMinutes !== undefined) {
                                task.reminderMinutes = patch.reminderMinutes === null ? undefined : patch.reminderMinutes;
                                task.reminderSet = patch.reminderMinutes !== null;
                            }
                            return true;
                        } catch (error) {
                            showMessage(this.text("saveFailed").replace("${msg}", errorMessage(error)), 5000, "error");
                            return false;
                        }
                    },
                    openMeta: () => {
                        this.quickToolbar?.close();
                        this.quickToolbar = undefined;
                        openTaskEditDialog(this.host(), task, () => {});
                    },
                },
            });
        } catch (error) {
            showMessage(this.text("scanFailed").replace("${msg}", errorMessage(error)), 6000, "error");
        }
    }

    private readonly mountHabitEmbed = (element: HTMLElement) => {
        if (this.disposed) {
            return;
        }
        const existing = this.embedViews.get(element);
        if (existing && element.querySelector(":scope > .ts-embed")) {
            return;
        }
        existing?.destroy();
        element.querySelectorAll(":scope > .ts-embed").forEach((node) => node.remove());
        this.embedViews.delete(element);

        const host = this.host();
        const container = document.createElement("div");
        container.className = "ts-embed";
        container.setAttribute("contenteditable", "false");
        element.classList.add("ts-embed-host");
        element.append(container);
        this.embedViews.set(element, mountHabitView({
            i18n: host.i18n,
            getHabits: host.getHabits,
            saveHabits: host.saveHabits,
            startHabitPomodoro: host.startHabitPomodoro,
            getPomodoroState: host.getPomodoroState,
        }, container));
    };

    private readonly insertHabitEmbed = () => {
        const protyle = getActiveEditor(false);
        if (!protyle) {
            showMessage(this.text("habitInsertNoEditor"), 5000, "error");
            return;
        }
        const {stamp, id} = makeBlockIdentity();
        const script = `//!js
if (window.__taskSecretaryHabits) {
  window.__taskSecretaryHabits(item);
} else {
  item.innerHTML = ${JSON.stringify(this.text("habitEmbedMissing"))};
}`;
        const html = `<div data-content="${escapeAttr(script)}" data-node-id="${id}" data-type="NodeBlockQueryEmbed" class="render-node" updated="${stamp}"><div class="protyle-attr" contenteditable="false">\u200b</div></div>`;
        protyle.focus();
        protyle.insert(html, true);
        // The editor does not always trigger embed rendering for programmatically inserted blocks.
        window.setTimeout(() => {
            const element = document.querySelector<HTMLElement>(`[data-node-id="${id}"][data-type="NodeBlockQueryEmbed"]`);
            if (element) {
                this.mountHabitEmbed(element);
            }
        }, 60);
        showMessage(this.text("habitEmbedInserted"), 3000);
    };

    private startTaskPomodoro(task: Task, options?: {completeNext?: boolean}): void {
        this.startPomodoro({kind: "task", id: task.id, title: task.title, completeNext: options?.completeNext});
    }

    private startHabitPomodoro(habit: Habit): void {
        this.startPomodoro({
            kind: "habit",
            id: habit.id,
            title: habit.name,
            docID: this.getActiveDocID(),
        });
    }

    private startPomodoro(target: PomodoroTarget): void {
        if (!this.pomodoro) {
            return;
        }
        if (this.pomodoro.isActive()) {
            if (this.pomodoro.isTarget(target.kind, target.id)) {
                this.stopPomodoro();
                showMessage(this.text("pomodoroStopped"), 3000);
                return;
            }
            showMessage(this.text("pomodoroAlreadyRunning"), 4000);
            return;
        }
        this.pomodoro.start(target, this.config.pomodoroFocusMinutes, this.config.pomodoroBreakMinutes);
        this.ensurePomodoroWindow();
    }

    private stopPomodoro(): void {
        this.pomodoro?.stop();
        this.closePomodoroWindow();
    }

    private onPomodoroState(state: PomodoroState | null): void {
        this.pomodoroState = state;
        window.dispatchEvent(new CustomEvent("task-secretary-pomodoro-state", {detail: state}));
        this.broadcastPomodoroState();
        if (!state) {
            this.closePomodoroWindow();
        }
    }

    private onPomodoroTick(state: PomodoroState): void {
        window.dispatchEvent(new CustomEvent("task-secretary-pomodoro-tick", {detail: state}));
    }

    private onPomodoroPhaseComplete(phase: PomodoroPhase, state: PomodoroState): void {
        if (phase === "focus") {
            void this.recordPomodoro(state.target, state.focusMinutes);
            if (state.target.kind === "task" && state.target.completeNext) {
                void this.completeTaskNext(state.target.id);
            }
            this.focusMainWindow();
            const subtitle = state.breakMinutes > 0
                ? `${state.target.title} · ${this.text("pomodoroRestLabel").replace("${minutes}", String(state.breakMinutes))}`
                : state.target.title;
            window.setTimeout(() => this.showPomodoroOverlay("🍅", this.text("pomodoroFocusDone"), subtitle), 80);
            this.notifyPomodoro(this.text("pomodoroFocusDone"), subtitle);
            return;
        }
        this.focusMainWindow();
        const subtitle = this.text("pomodoroBreakDoneDesc");
        window.setTimeout(() => this.showPomodoroOverlay("☕", this.text("pomodoroBreakDone"), subtitle), 80);
        this.notifyPomodoro(this.text("pomodoroBreakDone"), subtitle);
    }

    private pomodoroLabels(): Record<string, string> {
        return {
            focus: this.text("pomodoroFocusPhase"),
            break: this.text("pomodoroBreakPhase"),
            pause: this.text("pomodoroPause"),
            resume: this.text("pomodoroResume"),
            stop: this.text("pomodoroStop"),
            close: this.text("pomodoroClose"),
            stopped: this.text("pomodoroStoppedLabel"),
        };
    }

    private ensurePomodoroChannel(): BroadcastChannel | undefined {
        if (this.pomodoroChannel) {
            return this.pomodoroChannel;
        }
        if (typeof BroadcastChannel === "undefined") {
            return undefined;
        }
        try {
            const channel = new BroadcastChannel(this.pomodoroChannelName);
            channel.onmessage = (event) => this.onMiniPomodoroMessage(event.data);
            this.pomodoroChannel = channel;
            return channel;
        } catch (error) {
            console.warn("[task-secretary] pomodoro channel failed", error);
            return undefined;
        }
    }

    private onMiniPomodoroMessage(data: any): void {
        if (!data || typeof data.type !== "string") {
            return;
        }
        if (data.type === "ready") {
            this.broadcastPomodoroState();
        } else if (data.type === "toggle") {
            this.pomodoro?.togglePause();
        } else if (data.type === "complete") {
            this.pomodoro?.checkComplete();
        } else if (data.type === "stop" || data.type === "close") {
            this.stopPomodoro();
        }
    }

    private broadcastPomodoroState(): void {
        const channel = this.ensurePomodoroChannel();
        if (!channel) {
            return;
        }
        channel.postMessage({
            type: "state",
            state: this.pomodoroState
                ? {...this.pomodoroState, labels: this.pomodoroLabels()}
                : null,
        });
    }

    private ensurePomodoroWindow(): void {
        if (this.pomodoroWindow && !this.pomodoroWindow.isDestroyed?.()) {
            try {
                this.pomodoroWindow.showInactive?.();
            } catch {
                // ignore
            }
            return;
        }
        try {
            const remote = (window as any).require?.("@electron/remote");
            if (!remote?.BrowserWindow || !remote?.screen) {
                return;
            }
            const {BrowserWindow, screen} = remote;
            const area = screen.getPrimaryDisplay().workArea;
            const width = 240;
            const height = 112;
            const win = new BrowserWindow({
                width,
                height,
                x: area.x + area.width - width - 24,
                y: area.y + area.height - height - 24,
                frame: false,
                resizable: false,
                movable: true,
                alwaysOnTop: true,
                skipTaskbar: true,
                show: false,
                webPreferences: {backgroundThrottling: false},
            });
            this.pomodoroWindow = win;
            (globalThis as any).__taskSecretaryPomodoroWindow = win;
            try {
                win.setAlwaysOnTop(true, "pop-up-menu");
            } catch {
                // ignore platform differences
            }
            win.once("ready-to-show", () => {
                try {
                    win.showInactive();
                } catch {
                    try {
                        win.show();
                    } catch {
                        // ignore
                    }
                }
            });
            win.on("closed", () => {
                if (this.pomodoroWindow === win) {
                    this.pomodoroWindow = undefined;
                }
                if ((globalThis as any).__taskSecretaryPomodoroWindow === win) {
                    (globalThis as any).__taskSecretaryPomodoroWindow = undefined;
                }
                if (this.pomodoro?.isActive()) {
                    this.stopPomodoro();
                }
            });
            void win.loadURL(`${location.origin}/plugins/${this.name}/pomodoro.html?ch=${encodeURIComponent(this.pomodoroChannelName)}`)
                .catch((error: unknown) => {
                    console.warn("[task-secretary] mini pomodoro window failed", error);
                    if (this.pomodoroWindow === win) {
                        this.pomodoroWindow = undefined;
                    }
                    if (!win.isDestroyed?.()) {
                        win.destroy?.();
                    }
                });
        } catch (error) {
            console.warn("[task-secretary] mini pomodoro window unavailable", error);
        }
    }

    private destroyStalePomodoroWindow(): void {
        try {
            const previous = (globalThis as any).__taskSecretaryPomodoroWindow;
            if (previous && !previous.isDestroyed?.()) {
                previous.destroy?.();
            }
            (globalThis as any).__taskSecretaryPomodoroWindow = undefined;
        } catch {
            // ignore
        }
    }

    private closePomodoroWindow(): void {
        const win = this.pomodoroWindow;
        this.pomodoroWindow = undefined;
        if ((globalThis as any).__taskSecretaryPomodoroWindow === win) {
            (globalThis as any).__taskSecretaryPomodoroWindow = undefined;
        }
        if (win && !win.isDestroyed?.()) {
            try {
                win.close();
            } catch {
                // ignore
            }
        }
    }

    private focusMainWindow(): void {
        try {
            const remote = (window as any).require?.("@electron/remote");
            const win = remote?.getCurrentWindow?.();
            if (!win) {
                return;
            }
            if (win.isMinimized?.()) {
                win.restore();
            }
            win.show();
            win.focus();
        } catch {
            // browser frontend has no Electron window
        }
    }

    private showPomodoroOverlay(icon: string, title: string, subtitle: string): void {
        document.querySelectorAll(".ts-pomodoro-overlay").forEach((element) => element.remove());
        const overlay = document.createElement("div");
        overlay.className = "ts-pomodoro-overlay";
        const card = document.createElement("div");
        card.className = "ts-pomodoro-overlay__card";
        const iconEl = document.createElement("div");
        iconEl.className = "ts-pomodoro-overlay__icon";
        iconEl.textContent = icon;
        const titleEl = document.createElement("div");
        titleEl.className = "ts-pomodoro-overlay__title";
        titleEl.textContent = title;
        const subtitleEl = document.createElement("div");
        subtitleEl.className = "ts-pomodoro-overlay__subtitle";
        subtitleEl.textContent = subtitle;
        card.append(iconEl, titleEl, subtitleEl);
        overlay.append(card);
        const close = () => overlay.remove();
        overlay.addEventListener("click", close);
        document.body.append(overlay);
        window.setTimeout(close, 8000);
    }

    private sendTestReminder(): void {
        const title = this.text("testReminderTitle");
        const body = this.text("testReminderBody");
        const meta = this.text("reminderScheduledFor").replace("${time}", this.formatReminderTime(Date.now()));
        this.showReminderToast(title, body, meta);
        this.notifySystem(title, body);
    }

    private readonly onReminderDataChanged = (): void => {
        if (this.reminderCheckDebounce) {
            window.clearTimeout(this.reminderCheckDebounce);
        }
        this.reminderCheckDebounce = window.setTimeout(() => {
            this.reminderCheckDebounce = undefined;
            void this.checkReminders();
        }, 800);
    };

    private startReminderScheduler(): void {
        this.stopReminderScheduler();
        this.reminderLastCheck = Date.now();
        const tick = async () => {
            if (this.disposed) {
                return;
            }
            await this.checkReminders();
            if (this.disposed) {
                return;
            }
            this.reminderTimer = window.setTimeout(() => void tick(), 15000);
        };
        this.reminderTimer = window.setTimeout(() => void tick(), 5000);
        window.addEventListener("task-secretary-tasks-changed", this.onReminderDataChanged);
        window.addEventListener("task-secretary-habits-changed", this.onReminderDataChanged);
    }

    private stopReminderScheduler(): void {
        if (this.reminderTimer) {
            window.clearTimeout(this.reminderTimer);
            this.reminderTimer = undefined;
        }
        if (this.nextReminderTimer) {
            window.clearTimeout(this.nextReminderTimer);
            this.nextReminderTimer = undefined;
        }
        if (this.reminderCheckDebounce) {
            window.clearTimeout(this.reminderCheckDebounce);
            this.reminderCheckDebounce = undefined;
        }
        window.removeEventListener("task-secretary-tasks-changed", this.onReminderDataChanged);
        window.removeEventListener("task-secretary-habits-changed", this.onReminderDataChanged);
    }

    private formatReminderTime(at: number): string {
        const date = new Date(at);
        return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }

    /** Use the next relevant time: the earlier of a future plan start and a future deadline. */
    private taskBaseAt(task: Task, now: number): number {
        const candidates: number[] = [];
        if (task.planDate && task.planStart) {
            const at = new Date(`${task.planDate}T${task.planStart}:00`).getTime();
            if (Number.isFinite(at)) {
                candidates.push(at);
            }
        }
        if (task.dueDate && task.dueTime) {
            const at = new Date(`${task.dueDate}T${task.dueTime}:00`).getTime();
            if (Number.isFinite(at)) {
                candidates.push(at);
            }
        }
        const future = candidates.filter((at) => at > now - 5000).sort((a, b) => a - b);
        return future[0] || 0;
    }

    private taskReminderAt(task: Task, now: number): {at: number; advance: boolean; leadMinutes: number} | undefined {
        if (!task.clarified || task.archived || task.type !== "task" || task.reminderMinutes === 0) {
            return undefined;
        }
        const dueAt = this.taskBaseAt(task, now);
        if (!dueAt) {
            return undefined;
        }
        const effective = task.reminderMinutes === undefined ? this.config.reminderMinutes : task.reminderMinutes;
        if (effective === 0) {
            return undefined;
        }
        const leadMinutes = effective === -1 ? 0 : Math.max(0, effective);
        let at = leadMinutes > 0 ? dueAt - leadMinutes * 60000 : dueAt;
        let advance = leadMinutes > 0 && at > now;
        if (leadMinutes > 0 && at <= now && dueAt > now - 5 * 60 * 1000) {
            at = dueAt;
            advance = false;
        }
        return {at, advance, leadMinutes};
    }

    private async checkReminders(): Promise<void> {
        if (this.reminderChecking) {
            return;
        }
        this.reminderChecking = true;
        try {
            const [tasks, habits] = await Promise.all([fetchTasks(), this.loadHabits()]);
            if (this.disposed) {
                return;
            }
            const now = Date.now();
            const since = Math.max(this.reminderLastCheck || now, now - 10 * 60 * 1000);
            const today = dateKey();

            tasks.forEach((task) => {
                const reminder = this.taskReminderAt(task, now);
                if (!reminder) {
                    return;
                }
                const key = `task:${task.id}:${reminder.at}`;
                if (reminder.at >= since && reminder.at <= now && !this.firedReminders.has(key)) {
                    this.firedReminders.add(key);
                    this.fireTaskReminder(task, reminder.at, reminder.advance, reminder.leadMinutes);
                }
            });

            habits.forEach((habit) => {
                if (!habit.reminderTime || !isScheduled(habit, today) || habitDone(habit, today)) {
                    return;
                }
                const dueAt = new Date(`${today}T${habit.reminderTime}:00`).getTime();
                if (!Number.isFinite(dueAt) || dueAt <= 0) {
                    return;
                }
                const key = `habit:${habit.id}:${dueAt}`;
                if (dueAt > since && dueAt <= now && !this.firedReminders.has(key)) {
                    this.firedReminders.add(key);
                    this.fireHabitReminder(habit, dueAt);
                }
            });

            if (this.firedReminders.size > 1000) {
                this.firedReminders.clear();
            }
            this.reminderLastCheck = now;
            this.scheduleNextReminder(this.nextReminderAt(tasks, habits, now));
        } catch (error) {
            console.warn("[task-secretary] reminder check failed", error);
        } finally {
            this.reminderChecking = false;
        }
    }

    private nextReminderAt(tasks: Task[], habits: Habit[], now: number): number {
        let next = 0;
        const offer = (at: number) => {
            if (at > now && (!next || at < next)) {
                next = at;
            }
        };
        tasks.forEach((task) => {
            const reminder = this.taskReminderAt(task, now);
            if (reminder && reminder.at > now) {
                offer(reminder.at);
            }
        });
        const today = dateKey();
        habits.forEach((habit) => {
            if (!habit.reminderTime || !isScheduled(habit, today) || habitDone(habit, today)) {
                return;
            }
            offer(new Date(`${today}T${habit.reminderTime}:00`).getTime());
        });
        return next;
    }

    private scheduleNextReminder(at: number): void {
        if (this.nextReminderTimer) {
            window.clearTimeout(this.nextReminderTimer);
            this.nextReminderTimer = undefined;
        }
        if (!at) {
            return;
        }
        const delay = at - Date.now();
        if (delay > 60000) {
            return;
        }
        this.nextReminderTimer = window.setTimeout(() => {
            this.nextReminderTimer = undefined;
            void this.checkReminders();
        }, Math.max(0, delay) + 60);
    }

    private fireTaskReminder(task: Task, at: number, advance: boolean, leadMinutes: number): void {
        const time = this.formatReminderTime(at);
        const title = advance ? this.text("taskReminderAdvanceTitle") : this.text("taskReminderAtTitle");
        const next = task.nextAction && task.nextAction !== task.title
            ? ` · ${this.text("reminderNextStep").replace("${name}", task.nextAction)}`
            : "";
        const body = `${task.title}${next}`;
        const meta = advance
            ? `${time} · ${this.text("reminderAdvance").replace("${minutes}", String(leadMinutes))}`
            : this.text("reminderScheduledFor").replace("${time}", time);
        this.showReminderToast(title, body, meta, task.id);
        this.notifySystem(title, body);
        window.dispatchEvent(new CustomEvent("task-secretary-reminder-fired", {
            detail: {kind: "task", id: task.id, title: task.title, at, advance, firedAt: Date.now()},
        }));
    }

    private fireHabitReminder(habit: Habit, at: number): void {
        const title = this.text("habitReminderTitle");
        const meta = this.text("reminderScheduledFor").replace("${time}", this.formatReminderTime(at));
        this.showReminderToast(title, habit.name, meta);
        this.notifySystem(title, habit.name);
        window.dispatchEvent(new CustomEvent("task-secretary-reminder-fired", {
            detail: {kind: "habit", id: habit.id, title: habit.name, at, advance: false, firedAt: Date.now()},
        }));
    }

    private ensureReminderRoot(): HTMLElement {
        if (this.reminderToastRoot?.isConnected) {
            return this.reminderToastRoot;
        }
        const root = document.createElement("div");
        root.className = "ts-reminder-stack";
        root.setAttribute("data-reminder-stack", "1");
        document.body.append(root);
        this.reminderToastRoot = root;
        return root;
    }

    private showReminderToast(title: string, body: string, meta: string, taskID?: string): void {
        const root = this.ensureReminderRoot();
        const toast = document.createElement("div");
        toast.className = "ts-reminder-toast";
        toast.setAttribute("data-reminder-toast", "1");
        toast.setAttribute("role", "alert");
        const titleEl = document.createElement("div");
        titleEl.className = "ts-reminder-toast__title";
        titleEl.textContent = `🔔 ${title}`;
        const bodyEl = document.createElement("div");
        bodyEl.className = "ts-reminder-toast__body";
        bodyEl.textContent = body;
        const metaEl = document.createElement("div");
        metaEl.className = "ts-reminder-toast__meta";
        metaEl.textContent = meta;
        const close = document.createElement("button");
        close.className = "ts-reminder-toast__close";
        close.type = "button";
        close.textContent = "×";
        close.title = this.text("reminderToastClose");
        close.setAttribute("aria-label", this.text("reminderToastClose"));
        const remove = () => toast.remove();
        close.addEventListener("click", (event) => {
            event.stopPropagation();
            remove();
        });
        toast.addEventListener("click", () => {
            if (taskID && /^\d{14}-[a-z0-9]{7}$/.test(taskID)) {
                openTab({app: this.app, doc: {id: taskID, action: ["cb-get-focus", "cb-get-hl"]}});
            }
            remove();
        });
        toast.append(titleEl, bodyEl, metaEl, close);
        root.append(toast);
        while (root.children.length > 4) {
            root.firstElementChild?.remove();
        }
        window.setTimeout(remove, 18000);
    }

    private notifySystem(title: string, body: string): void {
        try {
            void platformUtils.sendNotification({title, body, timeoutType: "default"}).catch((error) => {
                console.warn("[task-secretary] notification failed", error);
                this.notifySystemFallback(title, body);
            });
        } catch (error) {
            console.warn("[task-secretary] notification failed", error);
            this.notifySystemFallback(title, body);
        }
    }

    private notifySystemFallback(title: string, body: string): void {
        try {
            const remote = (window as any).require?.("@electron/remote");
            const RemoteNotification = remote?.Notification;
            if (typeof RemoteNotification === "function") {
                new RemoteNotification({title, body}).show();
                return;
            }
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                new Notification(title, {body});
            }
        } catch (error) {
            console.warn("[task-secretary] fallback notification failed", error);
        }
    }

    private notifyPomodoro(title: string, body: string): void {
        try {
            void platformUtils.sendNotification({title, body, timeoutType: "never"});
        } catch (error) {
            console.warn("[task-secretary] notification failed", error);
        }
    }

    private getActiveDocID(): string {
        const title = document.querySelector<HTMLElement>(".protyle-title");
        const id = title?.getAttribute("data-node-id") || "";
        return /^\d{14}-[a-z0-9]{7}$/.test(id) ? id : "";
    }

    private async recordPomodoro(target: PomodoroTarget, minutes: number): Promise<void> {
        try {
            if (target.kind === "task") {
                await this.appendTaskPomodoroRecord(target.id, minutes);
            } else {
                await this.recordHabitPomodoro(target, minutes);
            }
        } catch (error) {
            console.warn("[task-secretary] pomodoro record failed", error);
            showMessage(this.text("pomodoroRecordFailed").replace("${msg}", errorMessage(error)), 6000, "error");
        }
    }

    private async appendTaskPomodoroRecord(taskID: string, minutes: number): Promise<void> {
        if (!/^\d{14}-[a-z0-9]{7}$/.test(taskID)) {
            return;
        }
        const data = this.text("pomodoroRecordTask").replace("${minutes}", String(minutes));
        const response = await fetchSyncPost("/api/block/appendBlock", {
            dataType: "markdown",
            data,
            parentID: taskID,
        });
        if (response.code !== 0) {
            throw new Error(response.msg || `appendBlock failed: ${response.code}`);
        }
        await fetchSyncPost("/api/sqlite/flushTransaction", {});
    }

    private async recordHabitPomodoro(target: PomodoroTarget, minutes: number): Promise<void> {
        const habits = await this.loadHabits();
        const habit = habits.find((item) => item.id === target.id);
        if (habit) {
            const today = dateKey();
            let updated = addFocusMinutes(habit, today, minutes);
            if (habit.autoCheckIn) {
                updated = addCheckIn(updated, today, 1);
            }
            await this.saveHabitsData(habits.map((item) => item.id === habit.id ? updated : item));
        }
        if (!target.docID) {
            showMessage(this.text("pomodoroNoDoc"), 5000);
            return;
        }
        const record = this.text("pomodoroRecordHabit")
            .replace("${name}", target.title)
            .replace("${minutes}", String(minutes));
        const embedID = await this.findHabitEmbed(target.docID);
        const response = embedID
            ? await fetchSyncPost("/api/block/insertBlock", {
                dataType: "markdown",
                data: record,
                previousID: embedID,
            })
            : await fetchSyncPost("/api/block/appendBlock", {
                dataType: "markdown",
                data: record,
                parentID: target.docID,
            });
        if (response.code !== 0) {
            throw new Error(response.msg || `record insert failed: ${response.code}`);
        }
        await fetchSyncPost("/api/sqlite/flushTransaction", {});
    }

    private async findHabitEmbed(docID: string): Promise<string | undefined> {
        if (!/^\d{14}-[a-z0-9]{7}$/.test(docID)) {
            return undefined;
        }
        const response = await fetchSyncPost("/api/query/sql", {
            stmt: `SELECT id FROM blocks WHERE type = 'query_embed' AND root_id = '${docID}' AND markdown LIKE '%__taskSecretaryHabits%' LIMIT 1`,
        });
        if (response.code !== 0) {
            throw new Error(response.msg || `query failed: ${response.code}`);
        }
        return (response.data as Array<{id: string}> | undefined)?.[0]?.id;
    }

    private async insertTask(input: NewTaskInput): Promise<void> {
        const title = input.title.trim();
        if (!title) {
            throw new Error(this.text("taskTitleRequired"));
        }
        const protyle = getActiveEditor(false);
        if (!protyle) {
            throw new Error(this.text("addTaskNoEditor"));
        }
        const editor = protyle.protyle;
        const docID = editor?.block?.rootID
            || document.querySelector<HTMLElement>(".protyle-title")?.getAttribute("data-node-id")
            || "";
        if (!docID) {
            throw new Error(this.text("addTaskFailed"));
        }
        const {stamp, id: itemID} = makeBlockIdentity();
        const {id: paragraphID} = makeBlockIdentity();
        const html = `<div data-marker="*" data-subtype="t" data-task=" " data-node-id="${itemID}" data-type="NodeListItem" class="li" updated="${stamp}"><div class="protyle-action protyle-action--task" draggable="true"><svg><use xlink:href="#iconUncheck"></use></svg></div><div data-node-id="${paragraphID}" data-type="NodeParagraph" class="p" updated="${stamp}"><div contenteditable="true" spellcheck="false">${escapeAttr(title)}</div><div class="protyle-attr" contenteditable="false">\u200b</div></div><div class="protyle-attr" contenteditable="false">\u200b</div></div>`;

        const editorElement = editor?.wysiwyg?.element;
        let anchor: Node | null = null;
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            anchor = selection.getRangeAt(0).startContainer;
        }
        if ((!anchor || !editorElement?.contains(anchor)) && editor?.toolbar?.range) {
            anchor = editor.toolbar.range.startContainer;
        }
        let anchorID = "";
        if (anchor && editorElement?.contains(anchor)) {
            const anchorElement = anchor.nodeType === 3 ? anchor.parentElement : anchor as HTMLElement;
            const listItem = anchorElement?.closest<HTMLElement>('[data-type="NodeListItem"]');
            const block = listItem || anchorElement?.closest<HTMLElement>("[data-node-id]");
            anchorID = block?.getAttribute("data-node-id") || "";
        }

        const response = anchorID
            ? await fetchSyncPost("/api/block/insertBlock", {
                dataType: "dom",
                data: html,
                previousID: anchorID,
            })
            : await fetchSyncPost("/api/block/appendBlock", {
                dataType: "dom",
                data: html,
                parentID: docID,
            });
        if (response.code !== 0) {
            throw new Error(response.msg || `insertBlock failed: ${response.code}`);
        }

        const responseID = (response.data as any)?.[0]?.doOperations?.[0]?.id || "";
        let taskID = itemID;
        await fetchSyncPost("/api/sqlite/flushTransaction", {});
        let found = false;
        for (let attempt = 0; attempt < 20 && !found; attempt++) {
            const itemCheck = await fetchSyncPost("/api/query/sql", {
                stmt: `SELECT id, type, subtype, parent_id FROM blocks WHERE id = '${itemID}' LIMIT 1`,
            });
            const itemRow = (itemCheck.data as Array<{id: string; type: string; subtype: string; parent_id: string}> | undefined)?.[0];
            if (itemRow?.type === "i" && itemRow.subtype === "t") {
                taskID = itemRow.id;
                found = true;
                break;
            }

            if (responseID) {
                const check = await fetchSyncPost("/api/query/sql", {
                    stmt: `SELECT id, type, subtype, parent_id FROM blocks WHERE id = '${responseID}' LIMIT 1`,
                });
                const row = (check.data as Array<{id: string; type: string; subtype: string; parent_id: string}> | undefined)?.[0];
                if (row?.type === "i" && row.subtype === "t") {
                    taskID = row.id;
                    found = true;
                    break;
                }
                if (row?.type === "p" && row.parent_id) {
                    const parent = await fetchSyncPost("/api/query/sql", {
                        stmt: `SELECT id, type, subtype FROM blocks WHERE id = '${row.parent_id}' LIMIT 1`,
                    });
                    const parentRow = (parent.data as Array<{id: string; type: string; subtype: string}> | undefined)?.[0];
                    if (parentRow?.type === "i" && parentRow.subtype === "t") {
                        taskID = parentRow.id;
                        found = true;
                        break;
                    }
                }
                if (row?.type === "l") {
                    const child = await fetchSyncPost("/api/query/sql", {
                        stmt: `SELECT id, type, subtype FROM blocks WHERE parent_id = '${row.id}' AND id = '${itemID}' LIMIT 1`,
                    });
                    const childRow = (child.data as Array<{id: string; type: string; subtype: string}> | undefined)?.[0];
                    if (childRow?.type === "i" && childRow.subtype === "t") {
                        taskID = childRow.id;
                        found = true;
                        break;
                    }
                    if (attempt >= 10) {
                        const last = await fetchSyncPost("/api/query/sql", {
                            stmt: `SELECT id, type, subtype FROM blocks WHERE parent_id = '${row.id}' AND type = 'i' AND subtype = 't' ORDER BY id DESC LIMIT 1`,
                        });
                        const lastRow = (last.data as Array<{id: string; type: string; subtype: string}> | undefined)?.[0];
                        if (lastRow) {
                            taskID = lastRow.id;
                            found = true;
                            break;
                        }
                    }
                }
            }
            if (!found) {
                await new Promise((resolve) => window.setTimeout(resolve, 100));
                await fetchSyncPost("/api/sqlite/flushTransaction", {});
            }
        }
        if (!found) {
            throw new Error(this.text("addTaskFailed"));
        }

        const attrs: Record<string, string> = {[TYPE_ATTR]: input.type};
        if (input.dueDate) {
            attrs[DUE_ATTR] = input.dueTime ? `${input.dueDate} ${input.dueTime}` : input.dueDate;
        }
        if (input.type === "task") {
            attrs[PRIORITY_ATTR] = String(input.priority);
        }
        const attrResponse = await fetchSyncPost("/api/attr/setBlockAttrs", {id: taskID, attrs});
        if (attrResponse.code !== 0) {
            throw new Error(attrResponse.msg || `setBlockAttrs failed: ${attrResponse.code}`);
        }
        await fetchSyncPost("/api/sqlite/flushTransaction", {});
        this.notifyTasksChanged();
        this.scheduleUploadSoon();
    }

    private async loadHabits(): Promise<Habit[]> {
        return normalizeHabits(await this.loadData("habits.json"));
    }

    private async saveHabitsData(habits: Habit[]): Promise<void> {
        const response = await this.saveData("habits.json", {version: 1, habits});
        if (response.code !== 0) {
            throw new Error(response.msg || `saveData failed: ${response.code}`);
        }
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("task-secretary-habits-changed"));
        }, 0);
    }

    private notifyTasksChanged(): void {
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("task-secretary-tasks-changed"));
        }, 0);
    }

    private notifyInboxChanged(): void {
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("task-secretary-inbox-changed"));
        }, 0);
    }

    private notifyResourcesChanged(): void {
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("task-secretary-resources-changed"));
        }, 0);
    }

    private async archiveCaptureAsKnowledge(item: InboxItem, targetDocID: string): Promise<void> {
        if (!/^\d{14}-[a-z0-9]{7}$/.test(targetDocID)) {
            throw new Error("Invalid target document");
        }
        const text = cleanCaptureMarkdown(item.raw || item.text);
        if (!text) {
            throw new Error("Nothing to archive");
        }
        const response = await fetchSyncPost("/api/block/appendBlock", {
            parentID: targetDocID,
            dataType: "markdown",
            data: text,
        });
        if (response.code !== 0) {
            throw new Error(response.msg || `appendBlock failed: ${response.code}`);
        }
        await archiveCapture(item.id);
        this.notifyTasksChanged();
        this.notifyInboxChanged();
        this.notifyResourcesChanged();
        this.scheduleUploadSoon();
    }

    private async completeTaskNext(taskID: string): Promise<void> {
        try {
            const task = await fetchTaskByID(taskID);
            if (!task) {
                return;
            }
            await completeNextAction(task);
            this.notifyTasksChanged();
            this.scheduleUploadSoon();
        } catch (error) {
            console.warn("[task-secretary] complete next action failed", error);
        }
    }

    private host(): TaskDialogHost {
        return {
            app: this.app,
            i18n: this.i18n,
            getTasks: fetchTasks,
            getInbox: async () => fetchInboxItems(this.config.inboxDays, this.config.inboxNotebook, this.config.inboxDoc),
            getNextActionCandidate,
            clarifyItem: async (item, quadrant, nextAction) => {
                await clarifyBlock(item.id, quadrant, nextAction);
                this.notifyTasksChanged();
                this.notifyInboxChanged();
                this.notifyResourcesChanged();
                this.scheduleUploadSoon();
            },
            getKnowledgeItems: async () => fetchKnowledgeItems(this.config.inboxDays, this.config.inboxNotebook, this.config.inboxDoc),
            getColdItems: async () => fetchColdItems(this.config.inboxDays, this.config.inboxNotebook, this.config.inboxDoc),
            archiveAsKnowledge: async (item, targetDocID) => {
                await this.archiveCaptureAsKnowledge(item, targetDocID);
            },
            coldItem: async (item) => {
                await setCaptureCold(item.id, true);
                this.notifyInboxChanged();
                this.notifyResourcesChanged();
            },
            completeNextAction: async (task) => {
                const result = await completeNextAction(task);
                this.notifyTasksChanged();
                this.scheduleUploadSoon();
                return result;
            },
            setPlanBlock: async (task, date, start, end) => {
                await setPlanBlock(task, date, start, end);
                this.notifyTasksChanged();
                this.scheduleUploadSoon();
            },
            clearPlanBlock: async (task) => {
                await clearPlanBlock(task);
                this.notifyTasksChanged();
                this.scheduleUploadSoon();
            },
            setTaskQuadrant: async (task, quadrant) => {
                await setTaskQuadrant(task, quadrant);
                this.notifyTasksChanged();
                this.scheduleUploadSoon();
            },
            openFullscreen: (tab) => {
                void this.showTasks(tab, true);
            },
            openScreening: this.isDesktopMode() ? () => void this.openScreening() : undefined,
            getHabits: async () => this.loadHabits(),
            saveHabits: async (habits: Habit[]) => this.saveHabitsData(habits),
            insertHabitEmbed: () => this.insertHabitEmbed(),
            startTaskPomodoro: (task, options) => this.startTaskPomodoro(task, options),
            startHabitPomodoro: (habit) => this.startHabitPomodoro(habit),
            getPomodoroState: () => this.pomodoroState,
            markTaskDone: async (task) => {
                await markTaskDone(task);
                this.notifyTasksChanged();
                this.scheduleUploadSoon();
            },
            saveTaskMeta: async (task, dueDate, dueTime, priority, reminderMinutes) => {
                await saveTaskMeta(task, dueDate, dueTime, priority, reminderMinutes);
                this.notifyTasksChanged();
                this.scheduleUploadSoon();
            },
            updateTask: async (task, title, type, dueDate, dueTime, priority, reminderMinutes) => {
                await updateTaskContent(task, title, type, dueDate, dueTime, priority, reminderMinutes);
                this.notifyTasksChanged();
                this.scheduleUploadSoon();
            },
            addTask: async (input) => {
                await this.insertTask(input);
            },
            deleteTask: async (task) => {
                await deleteTaskBlock(task);
                this.notifyTasksChanged();
                this.scheduleUploadSoon();
            },
        };
    }

    private makeInput(value: string, type = "text"): HTMLInputElement {
        const input = document.createElement("input");
        input.className = "b3-text-field fn__block";
        input.type = type;
        input.value = value;
        return input;
    }

    private async loadInboxTargets(notebookSelect: HTMLSelectElement, docSelect: HTMLSelectElement) {
        try {
            const response = await fetchSyncPost("/api/notebook/lsNotebooks", {});
            const notebookData = response.data as any;
            const notebooks = ((notebookData?.notebooks || []) as Array<{id: string; name: string; closed?: boolean}>)
                .filter((notebook) => !notebook.closed);
            notebookSelect.innerHTML = `<option value="">${escapeAttr(this.text("settingInboxNotebookNone"))}</option>`
                + notebooks.map((notebook) => `<option value="${escapeAttr(notebook.id)}">${escapeAttr(notebook.name)}</option>`).join("");
            notebookSelect.value = this.config.inboxNotebook;

            const populateDocs = async () => {
                const notebook = notebookSelect.value;
                let stmt = "SELECT id, content, hpath FROM blocks WHERE type = 'd'";
                if (/^\d{14}-[a-z0-9]{7}$/.test(notebook)) {
                    stmt += ` AND box = '${notebook}'`;
                }
                stmt += " ORDER BY hpath ASC LIMIT 500";
                const docsResponse = await fetchSyncPost("/api/query/sql", {stmt});
                if (docsResponse.code !== 0) {
                    throw new Error(docsResponse.msg || `SQL error: ${docsResponse.code}`);
                }
                const docs = (docsResponse.data || []) as Array<{id: string; content?: string; hpath?: string}>;
                let options = `<option value="">${escapeAttr(this.text("settingInboxDocNone"))}</option>`
                    + docs.map((doc) => `<option value="${escapeAttr(doc.id)}">${escapeAttr(doc.hpath || doc.content || doc.id)}</option>`).join("");
                if (this.config.inboxDoc && !docs.some((doc) => doc.id === this.config.inboxDoc)) {
                    const one = await fetchSyncPost("/api/query/sql", {
                        stmt: `SELECT id, content, hpath FROM blocks WHERE id = '${this.config.inboxDoc}' LIMIT 1`,
                    });
                    const row = ((one.data || []) as Array<{id: string; content?: string; hpath?: string}>)[0];
                    if (row) {
                        options += `<option value="${escapeAttr(row.id)}">${escapeAttr(row.hpath || row.content || row.id)}</option>`;
                    }
                }
                docSelect.innerHTML = options;
                docSelect.value = this.config.inboxDoc;
            };

            notebookSelect.addEventListener("change", () => void populateDocs());
            await populateDocs();
        } catch (error) {
            console.warn("[task-secretary] failed to load inbox targets", error);
        }
    }

    private async openSettingsDialog() {
        this.settingsDialog?.destroy();
        const makeSwitch = (checked: boolean) => {
            const input = document.createElement("input");
            input.type = "checkbox";
            input.className = "b3-switch fn__flex-center";
            input.checked = checked;
            return input;
        };
        const makeRow = (title: string, description: string, control: HTMLElement, extraClass = "") => {
            const row = document.createElement("div");
            row.className = "ts-settings__row" + (extraClass ? ` ${extraClass}` : "");
            const meta = document.createElement("div");
            meta.className = "ts-settings__meta";
            const titleElement = document.createElement("div");
            titleElement.className = "ts-settings__row-title";
            titleElement.textContent = title;
            if (description) {
                const descElement = document.createElement("div");
                descElement.className = "ts-settings__row-desc";
                descElement.textContent = description;
                meta.append(titleElement, descElement);
            } else {
                meta.append(titleElement);
            }
            const controlWrap = document.createElement("div");
            controlWrap.className = "ts-settings__control";
            controlWrap.append(control);
            row.append(meta, controlWrap);
            return row;
        };
        const makePanel = (key: string, title: string, description: string) => {
            const panel = document.createElement("section");
            panel.className = "ts-settings__panel fn__none";
            panel.dataset.settingsPanel = key;
            const head = document.createElement("div");
            head.className = "ts-settings__section-head";
            const titleElement = document.createElement("div");
            titleElement.className = "ts-settings__section-title";
            titleElement.textContent = title;
            head.append(titleElement);
            if (description) {
                const descElement = document.createElement("div");
                descElement.className = "ts-settings__section-desc";
                descElement.textContent = description;
                head.append(descElement);
            }
            panel.append(head);
            return panel;
        };

        const startup = makeSwitch(this.config.showOnStartup);
        this.showOnStartupInput = startup;
        const screeningAuto = makeSwitch(this.config.screeningAutoOpen);
        this.screeningAutoInput = screeningAuto;
        const previewPopup = document.createElement("button");
        previewPopup.className = "b3-button b3-button--outline fn__size200";
        previewPopup.textContent = this.text("previewPopup");
        previewPopup.addEventListener("click", () => this.openTaskDock());
        const clickMenu = makeSwitch(this.config.clickTaskMenu);
        this.clickTaskMenuInput = clickMenu;

        const reminder = document.createElement("select");
        reminder.className = "b3-select fn__size200";
        const reminderValues = [0, -1, 5, 15, 30, 60, 120, 1440];
        const extraReminder = !reminderValues.includes(this.config.reminderMinutes) ? [this.config.reminderMinutes] : [];
        [...reminderValues, ...extraReminder].forEach((minutes) => {
            const option = document.createElement("option");
            option.value = String(minutes);
            option.textContent = minutes === 0
                ? this.text("reminderOff")
                : minutes === -1
                    ? this.text("reminderAtTime")
                    : typeof this.i18n[`reminder${minutes}`] === "string"
                        ? String(this.i18n[`reminder${minutes}`])
                        : this.text("reminderCustom").replace("${minutes}", String(minutes));
            reminder.append(option);
        });
        reminder.value = String(this.config.reminderMinutes);
        this.reminderInput = reminder;

        const testReminder = document.createElement("button");
        testReminder.className = "b3-button b3-button--outline fn__size200";
        testReminder.textContent = this.text("settingTestReminder");
        testReminder.addEventListener("click", () => this.sendTestReminder());

        const eventTime = this.makeInput(this.config.eventTime, "time");
        eventTime.className = "b3-text-field fn__size200";
        this.eventTimeInput = eventTime;

        const overdue = makeSwitch(this.config.includeOverdue);
        this.includeOverdueInput = overdue;

        const autoUpload = this.makeInput(String(this.config.autoUploadMinutes), "number");
        autoUpload.className = "b3-text-field fn__size200";
        autoUpload.min = "0";
        autoUpload.max = "1440";
        autoUpload.step = "5";
        this.autoUploadInput = autoUpload;

        const pomodoroFocus = this.makeInput(String(this.config.pomodoroFocusMinutes), "number");
        pomodoroFocus.className = "b3-text-field fn__size200";
        pomodoroFocus.min = "1";
        pomodoroFocus.max = "180";
        pomodoroFocus.step = "1";
        this.pomodoroFocusInput = pomodoroFocus;

        const pomodoroBreak = this.makeInput(String(this.config.pomodoroBreakMinutes), "number");
        pomodoroBreak.className = "b3-text-field fn__size200";
        pomodoroBreak.min = "0";
        pomodoroBreak.max = "120";
        pomodoroBreak.step = "1";
        this.pomodoroBreakInput = pomodoroBreak;

        const inboxDays = this.makeInput(String(this.config.inboxDays), "number");
        inboxDays.className = "b3-text-field fn__size200";
        inboxDays.min = "1";
        inboxDays.max = "365";
        inboxDays.step = "1";
        this.inboxDaysInput = inboxDays;

        const inboxNotebook = document.createElement("select");
        inboxNotebook.className = "b3-select fn__size200";
        this.inboxNotebookInput = inboxNotebook;
        const inboxDoc = document.createElement("select");
        inboxDoc.className = "b3-select fn__size200";
        this.inboxDocInput = inboxDoc;

        const cloud = this.config.cloud;
        const cloudMode = document.createElement("select");
        cloudMode.className = "b3-select fn__size200";
        [
            ["off", this.text("cloudOff")],
            ["aliyun", this.text("cloudAliyun")],
            ["put", this.text("cloudPut")],
        ].forEach(([value, label]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            cloudMode.append(option);
        });
        cloudMode.value = cloud.mode;
        this.cloudModeInput = cloudMode;

        const cloudBucket = this.makeInput(cloud.bucket);
        cloudBucket.className = "b3-text-field fn__size200";
        this.cloudBucketInput = cloudBucket;
        const cloudRegion = this.makeInput(cloud.region);
        cloudRegion.className = "b3-text-field fn__size200";
        this.cloudRegionInput = cloudRegion;
        const cloudAccessKey = this.makeInput(cloud.accessKeyId);
        cloudAccessKey.className = "b3-text-field fn__size200";
        this.cloudAccessKeyInput = cloudAccessKey;
        const cloudSecretName = this.makeInput(cloud.secretName);
        cloudSecretName.className = "b3-text-field fn__size200";
        this.cloudSecretNameInput = cloudSecretName;
        const cloudObjectKey = this.makeInput(cloud.objectKey);
        cloudObjectKey.className = "b3-text-field fn__size200";
        this.cloudObjectKeyInput = cloudObjectKey;
        const cloudPublicUrl = this.makeInput(cloud.publicUrl);
        cloudPublicUrl.className = "b3-text-field fn__size200";
        this.cloudPublicUrlInput = cloudPublicUrl;
        const cloudUploadUrl = this.makeInput(cloud.uploadUrl);
        cloudUploadUrl.className = "b3-text-field fn__size200";
        this.cloudUploadUrlInput = cloudUploadUrl;
        const cloudSubscriptionUrl = this.makeInput(cloud.subscriptionUrl);
        cloudSubscriptionUrl.className = "b3-text-field fn__size200";
        this.cloudSubscriptionUrlInput = cloudSubscriptionUrl;
        const cloudHeaders = document.createElement("textarea");
        cloudHeaders.className = "b3-text-field fn__block ts-settings__textarea";
        cloudHeaders.rows = 2;
        cloudHeaders.value = cloud.headers;
        this.cloudHeadersInput = cloudHeaders;

        const general = makePanel("general", this.text("settingsSectionGeneral"), this.text("settingsGeneralDesc"));
        general.append(
            makeRow(this.text("settingShowOnStartup"), this.text("settingShowOnStartupDesc"), startup),
            makeRow(this.text("settingScreeningAutoOpen"), this.text("settingScreeningAutoOpenDesc"), screeningAuto),
            makeRow(this.text("settingPreviewPopup"), this.text("settingPreviewPopupDesc"), previewPopup),
            makeRow(this.text("settingClickTaskMenu"), this.text("settingClickTaskMenuDesc"), clickMenu),
        );

        const reminderPanel = makePanel("reminder", this.text("settingsSectionReminder"), "");
        reminderPanel.append(
            makeRow(this.text("settingReminder"), this.text("settingReminderDesc"), reminder),
            makeRow(this.text("settingTestReminder"), this.text("settingTestReminderDesc"), testReminder),
        );
        const reminderNote = document.createElement("div");
        reminderNote.className = "ts-settings__help";
        reminderNote.textContent = this.text("settingsReminderNote");
        reminderPanel.append(reminderNote);

        const pomodoroPanel = makePanel("pomodoro", this.text("settingsSectionPomodoro"), this.text("settingsPomodoroDesc"));
        pomodoroPanel.append(
            makeRow(this.text("settingPomodoroFocus"), this.text("settingPomodoroFocusDesc"), pomodoroFocus),
            makeRow(this.text("settingPomodoroBreak"), this.text("settingPomodoroBreakDesc"), pomodoroBreak),
        );

        const inboxPanel = makePanel("inbox", this.text("settingsSectionInbox"), this.text("settingsInboxDesc"));
        inboxPanel.append(
            makeRow(this.text("settingInboxDays"), this.text("settingInboxDaysDesc"), inboxDays),
            makeRow(this.text("settingInboxNotebook"), this.text("settingInboxNotebookDesc"), inboxNotebook),
            makeRow(this.text("settingInboxDoc"), this.text("settingInboxDocDesc"), inboxDoc),
        );

        const calendarPanel = makePanel("calendar", this.text("settingsSectionCalendar"), this.text("settingsCalendarDesc"));
        calendarPanel.append(
            makeRow(this.text("settingEventTime"), this.text("settingEventTimeDesc"), eventTime),
            makeRow(this.text("settingIncludeOverdue"), this.text("settingIncludeOverdueDesc"), overdue),
        );

        const cloudPanel = makePanel("cloud", this.text("settingsSectionCloud"), this.text("settingCloudDesc"));
        const cloudRows = new Map<string, HTMLElement>();
        const addCloudRow = (key: string, title: string, description: string, control: HTMLElement) => {
            const row = makeRow(title, description, control);
            cloudRows.set(key, row);
            cloudPanel.append(row);
        };
        addCloudRow("autoUpload", this.text("settingAutoUpload"), this.text("settingAutoUploadDesc"), autoUpload);
        addCloudRow("mode", this.text("settingCloudTitle"), "", cloudMode);
        addCloudRow("bucket", this.text("settingBucket"), this.text("settingBucketDesc"), cloudBucket);
        addCloudRow("region", this.text("settingRegion"), this.text("settingRegionDesc"), cloudRegion);
        addCloudRow("accessKeyId", this.text("settingAccessKeyId"), this.text("settingAccessKeyIdDesc"), cloudAccessKey);
        addCloudRow("secretName", this.text("settingSecretName"), this.text("settingSecretNameDesc"), cloudSecretName);
        addCloudRow("objectKey", this.text("settingObjectKey"), this.text("settingObjectKeyDesc"), cloudObjectKey);
        addCloudRow("publicUrl", this.text("settingPublicUrl"), this.text("settingPublicUrlDesc"), cloudPublicUrl);
        addCloudRow("uploadUrl", this.text("settingUploadUrl"), this.text("settingUploadUrlDesc"), cloudUploadUrl);
        addCloudRow("subscriptionUrl", this.text("settingSubscriptionUrl"), this.text("settingSubscriptionUrlDesc"), cloudSubscriptionUrl);
        addCloudRow("uploadHeaders", this.text("settingUploadHeaders"), this.text("settingUploadHeadersDesc"), cloudHeaders);

        const helpPanel = makePanel("help", this.text("settingsSectionHelp"), this.text("helpTitle"));
        const helpText = document.createElement("div");
        helpText.className = "ts-settings__help";
        helpText.textContent = this.text("helpText");
        helpPanel.append(helpText);

        const sections: Array<{key: string; panel: HTMLElement}> = [
            {key: "general", panel: general},
            {key: "reminder", panel: reminderPanel},
            {key: "pomodoro", panel: pomodoroPanel},
            {key: "inbox", panel: inboxPanel},
            {key: "calendar", panel: calendarPanel},
            {key: "cloud", panel: cloudPanel},
            {key: "help", panel: helpPanel},
        ];
        const navLabels: Record<string, string> = {
            general: this.text("settingsSectionGeneral"),
            reminder: this.text("settingsSectionReminder"),
            pomodoro: this.text("settingsSectionPomodoro"),
            inbox: this.text("settingsSectionInbox"),
            calendar: this.text("settingsSectionCalendar"),
            cloud: this.text("settingsSectionCloud"),
            help: this.text("settingsSectionHelp"),
        };

        const dialog = new Dialog({
            title: this.text("topBarSettingsTitle"),
            width: getFrontend().startsWith("mobile") ? "92vw" : "760px",
            height: "82vh",
            content: `<div class="b3-dialog__content ts-settings">
  <div class="ts-settings__layout">
    <nav class="ts-settings__nav" data-settings-nav></nav>
    <div class="ts-settings__panels" data-settings-panels></div>
  </div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-settings-cancel>${escapeAttr(this.text("cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-settings-save>${escapeAttr(this.text("save"))}</button>
</div>`,
            destroyCallback: () => {
                if (this.settingsDialog === dialog) {
                    this.settingsDialog = undefined;
                }
            },
        });
        this.settingsDialog = dialog;

        const nav = dialog.element.querySelector<HTMLElement>("[data-settings-nav]")!;
        const panels = dialog.element.querySelector<HTMLElement>("[data-settings-panels]")!;
        sections.forEach((section, index) => {
            const button = document.createElement("button");
            button.className = "ts-settings__nav-btn" + (index === 0 ? " ts-settings__nav-btn--active" : "");
            button.dataset.settingsSection = section.key;
            button.textContent = navLabels[section.key] || section.key;
            button.addEventListener("click", () => {
                nav.querySelectorAll<HTMLElement>("[data-settings-section]").forEach((item) => {
                    item.classList.toggle("ts-settings__nav-btn--active", item === button);
                });
                sections.forEach((entry) => {
                    entry.panel.classList.toggle("fn__none", entry.key !== section.key);
                });
            });
            nav.append(button);
            panels.append(section.panel);
        });
        general.classList.remove("fn__none");

        const updateCloudVisibility = () => {
            const mode = cloudMode.value;
            cloudRows.forEach((row, key) => {
                if (key === "autoUpload") {
                    row.classList.toggle("fn__none", mode === "off");
                } else if (["bucket", "region", "accessKeyId", "secretName", "objectKey", "publicUrl"].includes(key)) {
                    row.classList.toggle("fn__none", mode !== "aliyun");
                } else if (["uploadUrl", "subscriptionUrl", "uploadHeaders"].includes(key)) {
                    row.classList.toggle("fn__none", mode !== "put");
                }
            });
        };
        cloudMode.addEventListener("change", updateCloudVisibility);
        updateCloudVisibility();

        void this.loadInboxTargets(inboxNotebook, inboxDoc);

        const saveButton = dialog.element.querySelector<HTMLButtonElement>("[data-settings-save]")!;
        saveButton.addEventListener("click", async () => {
            saveButton.disabled = true;
            const ok = await this.saveConfig();
            saveButton.disabled = false;
            if (ok) {
                dialog.destroy();
            }
        });
        dialog.element.querySelector("[data-settings-cancel]")?.addEventListener("click", () => dialog.destroy());
    }

    private async loadConfig() {
        const raw = await this.loadData("config.json");
        if (!raw || typeof raw !== "object") {
            return;
        }
        this.config = {
            showOnStartup: typeof raw.showOnStartup === "boolean" ? raw.showOnStartup : DEFAULT_CONFIG.showOnStartup,
            screeningAutoOpen: typeof raw.screeningAutoOpen === "boolean" ? raw.screeningAutoOpen : DEFAULT_CONFIG.screeningAutoOpen,
            reminderMinutes: Number.isFinite(Number(raw.reminderMinutes))
                ? Math.max(-1, Math.min(1440, Math.round(Number(raw.reminderMinutes))))
                : DEFAULT_CONFIG.reminderMinutes,
            eventTime: typeof raw.eventTime === "string" && /^\d{2}:\d{2}$/.test(raw.eventTime)
                ? raw.eventTime
                : DEFAULT_CONFIG.eventTime,
            includeOverdue: typeof raw.includeOverdue === "boolean" ? raw.includeOverdue : DEFAULT_CONFIG.includeOverdue,
            autoUploadMinutes: Number.isFinite(Number(raw.autoUploadMinutes))
                ? Math.max(0, Math.min(1440, Math.round(Number(raw.autoUploadMinutes))))
                : DEFAULT_CONFIG.autoUploadMinutes,
            clickTaskMenu: typeof raw.clickTaskMenu === "boolean" ? raw.clickTaskMenu : DEFAULT_CONFIG.clickTaskMenu,
            pomodoroFocusMinutes: Number.isFinite(Number(raw.pomodoroFocusMinutes))
                ? Math.max(1, Math.min(180, Math.round(Number(raw.pomodoroFocusMinutes))))
                : DEFAULT_CONFIG.pomodoroFocusMinutes,
            pomodoroBreakMinutes: Number.isFinite(Number(raw.pomodoroBreakMinutes))
                ? Math.max(0, Math.min(120, Math.round(Number(raw.pomodoroBreakMinutes))))
                : DEFAULT_CONFIG.pomodoroBreakMinutes,
            inboxDays: Number.isFinite(Number(raw.inboxDays))
                ? Math.max(1, Math.min(365, Math.round(Number(raw.inboxDays))))
                : DEFAULT_CONFIG.inboxDays,
            inboxNotebook: /^\d{14}-[a-z0-9]{7}$/.test(String(raw.inboxNotebook ?? "")) ? String(raw.inboxNotebook) : "",
            inboxDoc: /^\d{14}-[a-z0-9]{7}$/.test(String(raw.inboxDoc ?? "")) ? String(raw.inboxDoc) : "",
            cloud: normalizeCloud(raw.cloud),
            lastSubscriptionUrl: textValue(raw.lastSubscriptionUrl),
        };
    }

    private async saveConfig(): Promise<boolean> {
        const previousShowOnStartup = this.config.showOnStartup;
        const minutes = Number(this.reminderInput.value);
        const autoMinutes = Number(this.autoUploadInput.value);
        const focusMinutes = Number(this.pomodoroFocusInput.value);
        const breakMinutes = Number(this.pomodoroBreakInput.value);
        const inboxDays = Number(this.inboxDaysInput.value);
        const inboxNotebook = this.inboxNotebookInput.value;
        const inboxDoc = this.inboxDocInput.value;
        const time = this.eventTimeInput.value;
        this.config = {
            showOnStartup: this.showOnStartupInput.checked,
            screeningAutoOpen: this.screeningAutoInput.checked,
            reminderMinutes: Number.isFinite(minutes) ? Math.max(-1, Math.min(1440, Math.round(minutes))) : 30,
            eventTime: /^\d{2}:\d{2}$/.test(time) ? time : "09:00",
            includeOverdue: this.includeOverdueInput.checked,
            autoUploadMinutes: Number.isFinite(autoMinutes) ? Math.max(0, Math.min(1440, Math.round(autoMinutes))) : 0,
            clickTaskMenu: this.clickTaskMenuInput.checked,
            pomodoroFocusMinutes: Number.isFinite(focusMinutes) ? Math.max(1, Math.min(180, Math.round(focusMinutes))) : 25,
            pomodoroBreakMinutes: Number.isFinite(breakMinutes) ? Math.max(0, Math.min(120, Math.round(breakMinutes))) : 5,
            inboxDays: Number.isFinite(inboxDays) ? Math.max(1, Math.min(365, Math.round(inboxDays))) : 30,
            inboxNotebook: /^\d{14}-[a-z0-9]{7}$/.test(inboxNotebook) ? inboxNotebook : "",
            inboxDoc: /^\d{14}-[a-z0-9]{7}$/.test(inboxDoc) ? inboxDoc : "",
            cloud: {
                mode: this.cloudModeInput.value as CloudMode,
                bucket: this.cloudBucketInput.value.trim(),
                region: this.cloudRegionInput.value.trim() || DEFAULT_CLOUD_CONFIG.region,
                accessKeyId: this.cloudAccessKeyInput.value.trim(),
                secretName: this.cloudSecretNameInput.value.trim() || DEFAULT_CLOUD_CONFIG.secretName,
                objectKey: this.cloudObjectKeyInput.value.trim() || DEFAULT_CLOUD_CONFIG.objectKey,
                publicUrl: this.cloudPublicUrlInput.value.trim(),
                uploadUrl: this.cloudUploadUrlInput.value.trim(),
                subscriptionUrl: this.cloudSubscriptionUrlInput.value.trim(),
                headers: this.cloudHeadersInput.value.trim() || "{}",
            },
            lastSubscriptionUrl: this.config.lastSubscriptionUrl,
        };
        const response = await this.saveData("config.json", this.config);
        if (response.code !== 0) {
            showMessage(this.text("saveFailed").replace("${msg}", response.msg || String(response.code)), 6000, "error");
            return false;
        }
        this.scheduleAutoUpload();
        this.scheduleUploadSoon();
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("task-secretary-inbox-changed"));
        }, 0);
        if (!previousShowOnStartup && this.config.showOnStartup) {
            window.setTimeout(() => this.openTaskDock(), 300);
        }
        showMessage(this.text("saved"), 3000);
        return true;
    }
}
