import type {GtdQuadrant, Priority, Task} from "./types";
import {dateKey} from "./task-store";

export interface QuickPatch {
    dueDate?: string;
    dueTime?: string;
    priority?: Priority;
    reminderMinutes?: number | null;
    quadrant?: GtdQuadrant;
}

export interface QuickToolbarHost {
    i18n: Record<string, any>;
    getTask(): Task;
    getGlobalReminder(): number;
    save(patch: QuickPatch): Promise<boolean>;
    openMeta(): void;
}

export interface QuickToolbar {
    close(): void;
}

const REMINDER_VALUES = [5, 15, 30, 60, 120, 1440];

const QUADRANTS: Array<{key: GtdQuadrant; label: string; tag: string; fallback: string; tagFallback: string}> = [
    {key: "q1", label: "quadrantQ1", tag: "quadrantQ1Tag", fallback: "Important & urgent", tagFallback: "Do now"},
    {key: "q2", label: "quadrantQ2", tag: "quadrantQ2Tag", fallback: "Important, not urgent", tagFallback: "Schedule"},
    {key: "q3", label: "quadrantQ3", tag: "quadrantQ3Tag", fallback: "Not important, urgent", tagFallback: "Delegate"},
    {key: "q4", label: "quadrantQ4", tag: "quadrantQ4Tag", fallback: "Not important, not urgent", tagFallback: "Do less"},
];

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: QuickToolbarHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const icon = (name: string) => `<svg class="ts-quick__icon"><use xlink:href="#${name}"></use></svg>`;
const quadrantIcon = `<svg class="ts-quick__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>`;

const button = (action: string, iconHtml: string, label: string, title: string, extraClass = "") =>
    `<button class="ts-quick__btn${extraClass ? ` ${extraClass}` : ""}" data-ts-action="${action}" title="${escapeHtml(title)}">${iconHtml}<span>${escapeHtml(label)}</span></button>`;

interface Option {
    label?: string;
    active?: boolean;
    className?: string;
    separator?: boolean;
    onClick?: () => void;
}

const nextMonday = (): string => {
    const date = new Date();
    const delta = ((8 - date.getDay()) % 7) || 7;
    date.setDate(date.getDate() + delta);
    return dateKey(date);
};

const dueLabel = (host: QuickToolbarHost, task: Task): string => {
    if (!task.dueDate) {
        return t(host, "quickDueNone", "Due");
    }
    const today = dateKey(new Date());
    const tomorrow = dateKey(new Date(Date.now() + 86400000));
    let label = task.dueDate === today
        ? t(host, "quickToday", "Today")
        : task.dueDate === tomorrow
            ? t(host, "quickTomorrow", "Tomorrow")
            : task.dueDate.slice(5);
    if (task.dueTime) {
        label += ` ${task.dueTime}`;
    }
    return label;
};

const formatReminder = (host: QuickToolbarHost, minutes: number): string => {
    if (minutes === -1) {
        return t(host, "quickReminderAt", "On time");
    }
    if (minutes === 0) {
        return t(host, "quickReminderOff", "Off");
    }
    if (minutes % 1440 === 0) {
        return t(host, "quickReminderDays", "${days}d before", {days: minutes / 1440});
    }
    if (minutes % 60 === 0) {
        return t(host, "quickReminderHours", "${hours}h before", {hours: minutes / 60});
    }
    return t(host, "quickReminderMinutes", "${minutes}m before", {minutes});
};

const reminderLabel = (host: QuickToolbarHost, task: Task): string => {
    const isGlobal = task.reminderMinutes === undefined;
    const minutes = isGlobal ? host.getGlobalReminder() : task.reminderMinutes;
    const label = formatReminder(host, minutes);
    return isGlobal
        ? t(host, "quickReminderGlobalShort", "Global · ${value}", {value: label})
        : label;
};

const valueLabel = (host: QuickToolbarHost, priority: Priority): string => priority === 1
    ? t(host, "priorityHigh", "High value")
    : priority === 3
        ? t(host, "priorityLow", "Low value")
        : t(host, "priorityMedium", "Neutral");

const quadrantLabel = (host: QuickToolbarHost, task: Task): string => {
    const quadrant = QUADRANTS.find((item) => item.key === task.quadrant);
    return quadrant ? t(host, quadrant.tag, quadrant.tagFallback) : t(host, "quickQuadrant", "Quadrant");
};

export const showQuickToolbar = (options: {
    task: Task;
    anchor: HTMLElement;
    host: QuickToolbarHost;
}): QuickToolbar => {
    const {anchor, host} = options;
    let action: "due" | "quadrant" | "priority" | "reminder" | null = null;
    let closed = false;

    const wrapper = document.createElement("div");
    wrapper.className = "ts-quick";
    wrapper.innerHTML = `<div class="ts-quick__bar"></div>
<div class="ts-quick__panel fn__none"></div>`;
    document.body.append(wrapper);

    const bar = wrapper.querySelector<HTMLElement>(".ts-quick__bar")!;
    const panel = wrapper.querySelector<HTMLElement>(".ts-quick__panel")!;
    const anchorRect = anchor.getBoundingClientRect();

    const position = () => {
        const width = wrapper.getBoundingClientRect().width || bar.getBoundingClientRect().width;
        const barHeight = bar.getBoundingClientRect().height || 34;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left));
        wrapper.style.left = `${left}px`;
        wrapper.style.top = `${anchorRect.top > barHeight + 16 ? anchorRect.top - barHeight - 8 : anchorRect.bottom + 8}px`;
    };

    const updateBar = () => {
        const task = host.getTask();
        const showQuadrant = task.clarified && task.type === "task";
        bar.innerHTML = [
            button("due", icon("iconCalendar"), dueLabel(host, task), `${t(host, "quickDue", "Due date")}: ${dueLabel(host, task)}`),
            showQuadrant ? button("quadrant", quadrantIcon, quadrantLabel(host, task), `${t(host, "quickQuadrant", "Quadrant")}: ${quadrantLabel(host, task)}`) : "",
            task.type === "task"
                ? button("priority", icon("iconList"), valueLabel(host, task.priority), `${t(host, "quickPriority", "Value")}: ${valueLabel(host, task.priority)}`, `ts-quick__btn--p${task.priority}`)
                : "",
            button("reminder", icon("iconClock"), reminderLabel(host, task), `${t(host, "quickReminder", "Reminder")}: ${reminderLabel(host, task)}`),
            `<button class="ts-quick__btn ts-quick__btn--icon" data-ts-action="more" title="${escapeHtml(t(host, "quickMore", "More settings…"))}">${icon("iconSettings")}</button>`,
        ].join("");
        if (action) {
            bar.querySelector(`[data-ts-action="${action}"]`)?.classList.add("ts-quick__btn--active");
        }
        wrapper.style.zIndex = String(++window.siyuan.zIndex);
        position();
    };

    const dueOptions = (): Option[] => {
        const task = host.getTask();
        const today = dateKey(new Date());
        const tomorrow = dateKey(new Date(Date.now() + 86400000));
        const monday = nextMonday();
        return [
            {label: t(host, "quickToday", "Today"), active: task.dueDate === today, onClick: () => void save({dueDate: today})},
            {label: t(host, "quickTomorrow", "Tomorrow"), active: task.dueDate === tomorrow, onClick: () => void save({dueDate: tomorrow})},
            {label: t(host, "quickNextMonday", "Next Monday"), active: task.dueDate === monday, onClick: () => void save({dueDate: monday})},
            {separator: true},
            {label: t(host, "quickClearDue", "Clear due date"), active: !task.dueDate && !task.dueTime, onClick: () => void save({dueDate: "", dueTime: ""})},
        ];
    };

    const quadrantOptions = (): Option[] => {
        const task = host.getTask();
        return QUADRANTS.map((quadrant) => ({
            label: `${t(host, quadrant.label, quadrant.fallback)} · ${t(host, quadrant.tag, quadrant.tagFallback)}`,
            active: task.quadrant === quadrant.key,
            className: quadrant.key,
            onClick: () => void save({quadrant: quadrant.key}),
        }));
    };

    const priorityOptions = (): Option[] => {
        const task = host.getTask();
        return [
            {label: t(host, "priorityHigh", "High"), active: task.priority === 1, className: "p1", onClick: () => void save({priority: 1})},
            {label: t(host, "priorityMedium", "Medium"), active: task.priority === 2, className: "p2", onClick: () => void save({priority: 2})},
            {label: t(host, "priorityLow", "Low"), active: task.priority === 3, className: "p3", onClick: () => void save({priority: 3})},
        ];
    };

    const reminderOptions = (): Option[] => {
        const task = host.getTask();
        const values = [...REMINDER_VALUES];
        if (task.reminderMinutes !== undefined && task.reminderMinutes > 0 && !values.includes(task.reminderMinutes)) {
            values.push(task.reminderMinutes);
        }
        const globalLabel = formatReminder(host, host.getGlobalReminder());
        return [
            {label: t(host, "quickReminderFollowGlobal", "Follow global (${value})", {value: globalLabel}), active: task.reminderMinutes === undefined, onClick: () => void save({reminderMinutes: null})},
            {label: t(host, "reminderAtTime", "At task time"), active: task.reminderMinutes === -1, onClick: () => void save({reminderMinutes: -1})},
            {label: t(host, "reminderOff", "No reminder"), active: task.reminderMinutes === 0, onClick: () => void save({reminderMinutes: 0})},
            {separator: true},
            ...values.map((minutes) => ({
                label: t(host, `reminder${minutes}`, `${minutes} minutes before`, {minutes}),
                active: task.reminderMinutes === minutes,
                onClick: () => void save({reminderMinutes: minutes}),
            })),
        ];
    };

    const appendDueCustom = () => {
        const task = host.getTask();
        const title = document.createElement("div");
        title.className = "ts-quick__custom-title";
        title.textContent = t(host, "quickCustomDue", "Custom date / time");
        const custom = document.createElement("div");
        custom.className = "ts-quick__custom";
        const date = document.createElement("input");
        date.className = "b3-text-field";
        date.type = "date";
        date.value = task.dueDate || dateKey(new Date());
        const time = document.createElement("input");
        time.className = "b3-text-field";
        time.type = "time";
        time.value = task.dueTime || "";
        const apply = document.createElement("button");
        apply.className = "b3-button b3-button--text ts-quick__apply";
        apply.type = "button";
        apply.textContent = t(host, "quickApply", "Apply");
        apply.addEventListener("click", () => {
            if (!date.value) {
                date.focus();
                return;
            }
            void save({dueDate: date.value, dueTime: time.value});
        });
        custom.append(date, time, apply);
        panel.append(title, custom);
    };

    const renderPanel = () => {
        if (!action) {
            panel.classList.add("fn__none");
            return;
        }
        const options = action === "due"
            ? dueOptions()
            : action === "quadrant"
                ? quadrantOptions()
                : action === "priority"
                    ? priorityOptions()
                    : reminderOptions();
        panel.innerHTML = "";
        panel.classList.toggle("ts-quick__panel--wide", action === "due");
        options.forEach((option) => {
            if (option.separator) {
                const separator = document.createElement("div");
                separator.className = "ts-quick__sep";
                panel.append(separator);
                return;
            }
            const item = document.createElement("button");
            item.className = "ts-quick__opt" + (option.active ? " ts-quick__opt--active" : "");
            if (option.className) {
                item.classList.add(`ts-quick__opt--${option.className}`);
            }
            const dot = document.createElement("span");
            dot.className = "ts-quick__dot";
            item.append(dot);
            const label = document.createElement("span");
            label.textContent = option.label || "";
            item.append(label);
            if (option.active) {
                const check = document.createElement("span");
                check.className = "ts-quick__check";
                check.textContent = "✓";
                item.append(check);
            }
            item.addEventListener("click", () => option.onClick?.());
            panel.append(item);
        });
        if (action === "due") {
            const separator = document.createElement("div");
            separator.className = "ts-quick__sep";
            panel.append(separator);
            appendDueCustom();
        }
        panel.classList.remove("fn__none");
        position();
    };

    const save = async (patch: QuickPatch) => {
        const ok = await host.save(patch);
        if (ok) {
            updateBar();
            renderPanel();
        }
    };

    const onBarClick = (event: Event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-ts-action]");
        if (!target) {
            return;
        }
        const next = target.dataset.tsAction as "due" | "quadrant" | "priority" | "reminder" | "more";
        if (next === "more") {
            close();
            host.openMeta();
            return;
        }
        action = action === next ? null : next;
        bar.querySelectorAll(".ts-quick__btn").forEach((element) => {
            element.classList.toggle("ts-quick__btn--active", element.getAttribute("data-ts-action") === action);
        });
        renderPanel();
    };

    const onOutside = (event: MouseEvent) => {
        if (!wrapper.contains(event.target as Node)) {
            close();
        }
    };
    const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            close();
        }
    };
    const onScroll = () => close();

    const close = () => {
        if (closed) {
            return;
        }
        closed = true;
        document.removeEventListener("mousedown", onOutside, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onScroll);
        wrapper.remove();
    };

    updateBar();
    bar.addEventListener("click", onBarClick);
    window.setTimeout(() => {
        if (closed) {
            return;
        }
        document.addEventListener("mousedown", onOutside, true);
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onScroll);
    }, 0);

    return {close};
};
