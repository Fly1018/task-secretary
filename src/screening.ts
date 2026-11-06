import type {Task} from "./types";
import {dateKey} from "./habit-store";
import type {CompleteResult} from "./task-store";

export interface ScreeningHost {
    i18n: Record<string, any>;
    getTasks(): Promise<Task[]>;
    openTask(task: Task): void;
    completeNext(task: Task): Promise<CompleteResult>;
    startPomodoro(task: Task): void;
    initialSpeed: number;
    initialPosition: number;
    onState(state: {speed: number; position: number}): void;
    onDestroy?(): void;
}

export interface ScreeningOverlay {
    destroy(): void;
}

const SPEEDS = [
    {label: "0.5×", value: 12},
    {label: "1×", value: 24},
    {label: "2×", value: 48},
];
const MAX_ITEMS = 40;

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: ScreeningHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const parseClock = (value?: string): number | undefined => {
    const match = String(value || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
};

const valueLabel = (host: ScreeningHost, priority: number): string => priority === 1
    ? t(host, "priorityHigh", "High value")
    : priority === 3
        ? t(host, "priorityLow", "Low value")
        : t(host, "priorityMedium", "Neutral");

const quadrantTag = (host: ScreeningHost, task: Task): string => {
    const key = task.quadrant === "q1" ? "quadrantQ1Tag" : task.quadrant === "q3" ? "quadrantQ3Tag" : task.quadrant === "q4" ? "quadrantQ4Tag" : "quadrantQ2Tag";
    const fallback = task.quadrant === "q1" ? "Do now" : task.quadrant === "q3" ? "Delegate" : task.quadrant === "q4" ? "Do less" : "Schedule";
    return t(host, key, fallback);
};

interface ScreeningEntry {
    task: Task;
    sort: string;
    timeLabel: string;
    startMin?: number;
    endMin?: number;
    kind: "plan" | "due" | "overdue" | "unscheduled";
}

const buildEntries = (tasks: Task[], host: ScreeningHost, today: string): ScreeningEntry[] => {
    const entries: ScreeningEntry[] = [];
    tasks.forEach((task) => {
        if (!task.clarified || task.archived || task.type !== "task") {
            return;
        }
        const planned = task.planDate === today && task.planStart;
        if (planned) {
            const startMin = parseClock(task.planStart);
            const endMin = parseClock(task.planEnd) ?? (startMin !== undefined ? startMin + 30 : undefined);
            entries.push({
                task,
                sort: task.planStart || "00:00",
                timeLabel: task.planEnd ? `${task.planStart}–${task.planEnd}` : String(task.planStart),
                startMin,
                endMin,
                kind: "plan",
            });
            return;
        }
        if (task.dueDate === today) {
            entries.push({
                task,
                sort: task.dueTime || "99:00",
                timeLabel: task.dueTime
                    ? t(host, "screeningDue", "Due ${time}", {time: task.dueTime})
                    : t(host, "screeningDueAllDay", "Due today"),
                startMin: parseClock(task.dueTime),
                kind: "due",
            });
            return;
        }
        if (task.overdue) {
            entries.push({
                task,
                sort: "99:50",
                timeLabel: t(host, "screeningOverdue", "Overdue"),
                kind: "overdue",
            });
            return;
        }
        if (!task.dueDate && !task.planDate) {
            entries.push({
                task,
                sort: "99:90",
                timeLabel: t(host, "screeningUnscheduled", "To schedule"),
                kind: "unscheduled",
            });
        }
    });
    entries.sort((a, b) => a.sort.localeCompare(b.sort) || a.task.title.localeCompare(b.task.title));
    return entries.slice(0, MAX_ITEMS);
};

const entryMarkup = (host: ScreeningHost, entry: ScreeningEntry, nowMin: number): string => {
    const task = entry.task;
    const quadrant = task.quadrant || "q4";
    const isNow = entry.kind === "plan"
        && entry.startMin !== undefined
        && entry.endMin !== undefined
        && nowMin >= entry.startMin
        && nowMin < entry.endMin;
    const isPast = entry.kind === "plan"
        ? entry.endMin !== undefined && entry.endMin <= nowMin
        : entry.kind === "due" && entry.startMin !== undefined && entry.startMin < nowMin;
    const next = task.nextAction && task.nextAction !== task.title ? task.nextAction : "";
    return `<article class="ts-screen__item ts-screen__item--${quadrant}${isNow ? " ts-screen__item--now" : ""}${isPast ? " ts-screen__item--past" : ""}" data-screen-task="${task.id}" data-screen-kind="${entry.kind}" data-screen-start="${entry.startMin ?? ""}" data-screen-end="${entry.endMin ?? ""}">
  <div class="ts-screen__time">${escapeHtml(entry.timeLabel)}${isNow ? `<span class="ts-screen__now">${escapeHtml(t(host, "screeningNow", "Now"))}</span>` : ""}</div>
  <div class="ts-screen__title">${escapeHtml(task.title)}</div>
  ${next ? `<div class="ts-screen__next">↳ ${escapeHtml(next)}</div>` : ""}
  <div class="ts-screen__meta">
    <span class="ts-screen__quad">${escapeHtml(quadrantTag(host, task))}</span>
    <span>${escapeHtml(valueLabel(host, task.priority))}</span>
    ${task.stepCount > 0 ? `<span>${escapeHtml(t(host, "quadrantStepsLeft", "${count} steps left", {count: task.stepCount}))}</span>` : ""}
  </div>
</article>`;
};

export const openScreeningOverlay = (host: ScreeningHost): ScreeningOverlay => {
    const today = dateKey();
    const reduceMotion = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let entries: ScreeningEntry[] = [];
    let offset = Math.max(0, host.initialPosition);
    let maxOffset = 0;
    let speed = SPEEDS.some((item) => item.value === host.initialSpeed) ? host.initialSpeed : 24;
    let playing = !reduceMotion;
    let hovering = false;
    let dragging = false;
    let selected: Task | undefined;
    let disposed = false;
    let raf = 0;
    let lastFrame = performance.now();
    let lastSave = 0;
    let idleTimer = 0;
    let refreshTimer = 0;
    let statusTimer = 0;
    let pointerStartY = 0;
    let pointerStartOffset = 0;
    let pointerMoved = false;

    const root = document.createElement("div");
    root.className = "ts-screen";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", t(host, "screeningTitle", "Timeline screening"));
    root.innerHTML = `<div class="ts-screen__glow"></div>
<div class="ts-screen__head">
  <div class="ts-screen__date">${escapeHtml(t(host, "timelineToday", "Today"))} · ${escapeHtml(today)}</div>
  <div class="ts-screen__count" data-screen-count></div>
</div>
<div class="ts-screen__viewport" data-screen-viewport>
  <div class="ts-screen__flow" data-screen-flow><div class="ts-screen__empty">${escapeHtml(t(host, "loading", "Loading…"))}</div></div>
</div>
<div class="ts-screen__controls" data-screen-controls>
  <button type="button" class="ts-screen__btn ts-screen__btn--icon" data-screen-play title="${escapeHtml(t(host, "screeningPause", "Pause"))}">⏸</button>
  <div class="ts-screen__speeds">${SPEEDS.map((item) => `<button type="button" class="ts-screen__btn ts-screen__speed${item.value === speed ? " ts-screen__speed--active" : ""}" data-screen-speed="${item.value}">${item.label}</button>`).join("")}</div>
  <button type="button" class="ts-screen__btn ts-screen__btn--icon" data-screen-exit title="${escapeHtml(t(host, "screeningExit", "Exit screening"))}">×</button>
</div>
<div class="ts-screen__hint">${escapeHtml(t(host, "screeningHint", "Esc to exit · wheel to browse · click a task for actions"))}</div>
<div class="ts-screen__status fn__none" data-screen-status></div>
<div class="ts-screen__actions fn__none" data-screen-actions>
  <div class="ts-screen__actions-title" data-screen-selected></div>
  <button type="button" class="ts-screen__action" data-screen-do="open">${escapeHtml(t(host, "screeningOpenTask", "Open task"))}</button>
  <button type="button" class="ts-screen__action" data-screen-do="complete">${escapeHtml(t(host, "screeningComplete", "Complete next step"))}</button>
  <button type="button" class="ts-screen__action" data-screen-do="pomodoro">🍅 ${escapeHtml(t(host, "screeningPomodoro", "Start pomodoro"))}</button>
  <button type="button" class="ts-screen__action ts-screen__action--close" data-screen-do="close" title="${escapeHtml(t(host, "screeningClose", "Close"))}">×</button>
</div>`;
    document.body.append(root);

    const viewport = root.querySelector<HTMLElement>("[data-screen-viewport]")!;
    const flow = root.querySelector<HTMLElement>("[data-screen-flow]")!;
    const countElement = root.querySelector<HTMLElement>("[data-screen-count]")!;
    const playButton = root.querySelector<HTMLButtonElement>("[data-screen-play]")!;
    const actions = root.querySelector<HTMLElement>("[data-screen-actions]")!;
    const selectedElement = root.querySelector<HTMLElement>("[data-screen-selected]")!;
    const statusElement = root.querySelector<HTMLElement>("[data-screen-status]")!;

    const nowMinutes = () => {
        const date = new Date();
        return date.getHours() * 60 + date.getMinutes();
    };

    const apply = () => {
        flow.style.transform = `translate3d(0, ${-offset}px, 0)`;
    };

    const updateMax = () => {
        maxOffset = Math.max(0, flow.scrollHeight - viewport.clientHeight);
        if (offset > maxOffset) {
            offset = maxOffset;
        }
        apply();
    };

    const persist = (force = false) => {
        const now = Date.now();
        if (!force && now - lastSave < 1200) {
            return;
        }
        lastSave = now;
        host.onState({speed, position: offset});
    };

    const updateControls = () => {
        const activeSpeed = SPEEDS.some((item) => item.value === speed) ? speed : 24;
        root.querySelectorAll<HTMLElement>("[data-screen-speed]").forEach((button) => {
            button.classList.toggle("ts-screen__speed--active", Number(button.dataset.screenSpeed) === activeSpeed);
        });
        playButton.textContent = playing ? "⏸" : "▶";
        playButton.title = t(host, playing ? "screeningPause" : "screeningPlay", playing ? "Pause" : "Play");
    };

    const renderEntries = () => {
        const nowMin = nowMinutes();
        countElement.textContent = t(host, "screeningCount", "${count} items", {count: entries.length});
        flow.classList.toggle("ts-screen__flow--empty", entries.length === 0);
        flow.innerHTML = entries.length > 0
            ? `${entries.map((entry) => entryMarkup(host, entry, nowMin)).join("")}<div class="ts-screen__end">${escapeHtml(t(host, "screeningEnd", "End of today"))}</div>`
            : `<div class="ts-screen__empty">${escapeHtml(t(host, "screeningEmpty", "Nothing scheduled for today"))}</div>`;
        updateMax();
    };

    const refresh = async () => {
        try {
            const tasks = await host.getTasks();
            if (disposed) {
                return;
            }
            entries = buildEntries(tasks, host, today);
            if (selected) {
                selected = entries.find((entry) => entry.task.id === selected?.id)?.task;
                if (!selected) {
                    hideActions();
                }
            }
            renderEntries();
        } catch (error) {
            if (disposed) {
                return;
            }
            console.warn("[task-secretary] screening load failed", error);
            flow.innerHTML = `<div class="ts-screen__empty">${escapeHtml(t(host, "screeningEmpty", "Nothing scheduled for today"))}</div>`;
        }
    };

    const showStatus = (text: string) => {
        statusElement.textContent = text;
        statusElement.classList.remove("fn__none");
        if (statusTimer) {
            window.clearTimeout(statusTimer);
        }
        statusTimer = window.setTimeout(() => statusElement.classList.add("fn__none"), 2600);
    };

    const hideActions = () => {
        selected = undefined;
        actions.classList.add("fn__none");
        root.classList.remove("ts-screen--selected");
    };

    const showActions = (task: Task) => {
        selected = task;
        selectedElement.textContent = task.title;
        actions.classList.remove("fn__none");
        root.classList.add("ts-screen--selected");
        showChrome();
    };

    const showChrome = () => {
        root.classList.remove("ts-screen--idle");
        if (idleTimer) {
            window.clearTimeout(idleTimer);
        }
        idleTimer = window.setTimeout(() => {
            if (!selected) {
                root.classList.add("ts-screen--idle");
            }
        }, 2800);
    };

    const togglePlay = () => {
        if (!playing && offset >= maxOffset - 1) {
            offset = 0;
            apply();
        }
        playing = !playing;
        updateControls();
        persist(true);
    };

    const tick = (time: number) => {
        if (disposed) {
            return;
        }
        const delta = Math.min(100, time - lastFrame);
        lastFrame = time;
        if (playing && !hovering && !dragging && !selected) {
            offset += speed * delta / 1000;
            if (offset >= maxOffset) {
                offset = maxOffset;
                playing = false;
                updateControls();
            }
            apply();
            persist();
        }
        raf = window.requestAnimationFrame(tick);
    };

    const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        offset = Math.max(0, Math.min(maxOffset, offset + event.deltaY));
        apply();
        showChrome();
        persist();
    };

    const onPointerDown = (event: PointerEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-screen-task], button")) {
            return;
        }
        dragging = true;
        pointerMoved = false;
        pointerStartY = event.clientY;
        pointerStartOffset = offset;
        root.classList.add("ts-screen--dragging");
        viewport.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
        showChrome();
        if (!dragging) {
            return;
        }
        pointerMoved = true;
        offset = Math.max(0, Math.min(maxOffset, pointerStartOffset - (event.clientY - pointerStartY)));
        apply();
        persist();
    };

    const onPointerUp = () => {
        if (!dragging) {
            return;
        }
        dragging = false;
        root.classList.remove("ts-screen--dragging");
        persist(true);
    };

    const onClick = async (event: Event) => {
        const target = event.target as HTMLElement;
        const speedButton = target.closest<HTMLElement>("[data-screen-speed]");
        if (speedButton) {
            speed = Number(speedButton.dataset.screenSpeed) || 24;
            updateControls();
            persist(true);
            return;
        }
        if (target.closest("[data-screen-play]")) {
            togglePlay();
            return;
        }
        if (target.closest("[data-screen-exit]")) {
            destroy();
            return;
        }
        const actionButton = target.closest<HTMLElement>("[data-screen-do]");
        if (actionButton) {
            const action = actionButton.dataset.screenDo;
            if (action === "close") {
                hideActions();
                return;
            }
            if (!selected) {
                return;
            }
            if (action === "open") {
                host.openTask(selected);
                return;
            }
            if (action === "pomodoro") {
                host.startPomodoro(selected);
                showStatus(t(host, "screeningPomodoroStarted", "Pomodoro started."));
                hideActions();
                return;
            }
            if (action === "complete") {
                actionButton.setAttribute("disabled", "true");
                try {
                    const result = await host.completeNext(selected);
                    showStatus(result.parentDone
                        ? t(host, "screeningCompletedAll", "All steps complete.")
                        : t(host, "screeningCompletedNext", "Next step complete."));
                    hideActions();
                    await refresh();
                } catch (error) {
                    showStatus(String(error instanceof Error ? error.message : error));
                } finally {
                    actionButton.removeAttribute("disabled");
                }
            }
            return;
        }
        const taskElement = target.closest<HTMLElement>("[data-screen-task]");
        if (taskElement && !pointerMoved) {
            const task = entries.find((entry) => entry.task.id === taskElement.dataset.screenTask)?.task;
            if (task) {
                showActions(task);
            }
            return;
        }
        if (target === viewport || target === flow || target.classList.contains("ts-screen__item")) {
            hideActions();
        }
    };

    const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            event.preventDefault();
            destroy();
            return;
        }
        if (event.key === " " && !(event.target as HTMLElement)?.closest("button")) {
            event.preventDefault();
            togglePlay();
            return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            offset = Math.max(0, Math.min(maxOffset, offset + (event.key === "ArrowUp" ? -80 : 80)));
            apply();
            persist();
        }
    };

    const onTasksChanged = () => {
        if (refreshTimer) {
            window.clearTimeout(refreshTimer);
        }
        refreshTimer = window.setTimeout(() => {
            refreshTimer = 0;
            void refresh();
        }, 350);
    };

    const onResize = () => {
        updateMax();
    };

    const onViewportEnter = () => {
        hovering = true;
        showChrome();
    };

    const onViewportLeave = () => {
        hovering = false;
        showChrome();
    };

    viewport.addEventListener("wheel", onWheel, {passive: false});
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointerenter", onViewportEnter);
    viewport.addEventListener("pointerleave", onViewportLeave);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    root.addEventListener("click", (event) => void onClick(event));
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("task-secretary-tasks-changed", onTasksChanged);
    viewport.addEventListener("scroll", (event) => event.preventDefault(), {passive: false});

    void refresh();
    updateControls();
    lastFrame = performance.now();
    raf = window.requestAnimationFrame(tick);
    showChrome();

    function destroy(): void {
        if (disposed) {
            return;
        }
        disposed = true;
        persist(true);
        window.cancelAnimationFrame(raf);
        if (idleTimer) {
            window.clearTimeout(idleTimer);
        }
        if (refreshTimer) {
            window.clearTimeout(refreshTimer);
        }
        if (statusTimer) {
            window.clearTimeout(statusTimer);
        }
        viewport.removeEventListener("wheel", onWheel);
        viewport.removeEventListener("pointerdown", onPointerDown);
        viewport.removeEventListener("pointerenter", onViewportEnter);
        viewport.removeEventListener("pointerleave", onViewportLeave);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("task-secretary-tasks-changed", onTasksChanged);
        root.remove();
        host.onDestroy?.();
    }

    return {destroy};
};
