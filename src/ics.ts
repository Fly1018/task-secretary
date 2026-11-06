import type {Priority, Task} from "./types";
import {dateKey, isScheduled, shiftDateKey, type Habit} from "./habit-store";

export interface IcsOptions {
    reminderMinutes: number;
    eventTime: string;
    includeOverdue: boolean;
    /** Habits with a reminder time become recurring calendar events. */
    habits?: Habit[];
    /** How many days of habit reminders to generate. */
    horizonDays?: number;
    now?: Date;
}

export interface IcsResult {
    content: string;
    exported: number;
    noDue: number;
    skippedOverdue: number;
}

const encoder = new TextEncoder();

const pad = (value: number) => String(value).padStart(2, "0");

const escapeText = (value: string) => String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

// RFC 5545: 每行不超过 75 个八位字节；续行以单个空格开头。
const foldLine = (line: string): string => {
    const parts: string[] = [];
    let current = "";
    let currentBytes = 0;
    for (const char of line) {
        const size = encoder.encode(char).length;
        const limit = parts.length === 0 ? 75 : 74;
        if (currentBytes + size > limit) {
            parts.push(current);
            current = char;
            currentBytes = size;
        } else {
            current += char;
            currentBytes += size;
        }
    }
    parts.push(current);
    return parts.join("\r\n ");
};

const formatUtc = (date: Date) =>
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

const formatLocal = (dueDate: string, time: string) =>
    `${dueDate.replace(/-/g, "")}T${time.replace(":", "")}00`;

const priorityValue = (priority: Priority) => priority === 1 ? 1 : priority === 3 ? 9 : 5;

const buildEvent = (task: Task, options: IcsOptions, stamp: string): string[] | undefined => {
    if (!task.dueDate) {
        return undefined;
    }
    const candidate = task.dueTime || options.eventTime || "09:00";
    const time = /^\d{2}:\d{2}$/.test(candidate) ? candidate : "09:00";
    const start = new Date(`${task.dueDate}T${time}:00`);
    if (Number.isNaN(start.getTime())) {
        return undefined;
    }
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const endDate = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
    const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
    const effectiveReminder = task.reminderMinutes === undefined
        ? Math.max(-1, Math.min(1440, Math.round(options.reminderMinutes)))
        : task.reminderMinutes === -1
            ? -1
            : Math.max(0, Math.min(10080, Math.round(task.reminderMinutes)));
    const alarm = effectiveReminder === 0 ? [] : [
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeText(task.title)}`,
        `TRIGGER:${effectiveReminder <= 0 ? "PT0S" : `-PT${effectiveReminder}M`}`,
        "END:VALARM",
    ];
    const description = [
        task.title,
        `来源：${task.hpath}`,
        `siyuan://blocks/${task.id}`,
        `性价比：${task.priority === 1 ? "高性价比" : task.priority === 3 ? "低性价比" : "一般"}`,
    ].join("\n");

    return [
        "BEGIN:VEVENT",
        `UID:${task.id}@task-secretary.siyuan`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${formatLocal(task.dueDate, time)}`,
        `DTEND:${formatLocal(endDate, endTime)}`,
        `SUMMARY:${escapeText(task.title)}`,
        `DESCRIPTION:${escapeText(description)}`,
        ...(task.type === "task" ? [`PRIORITY:${priorityValue(task.priority)}`] : []),
        "STATUS:CONFIRMED",
        "TRANSP:OPAQUE",
        "CATEGORIES:知行 GTD",
        `X-SIYUAN-BLOCK-ID:${task.id}`,
        ...alarm,
        "END:VEVENT",
    ];
};

const HABIT_EVENT_MINUTES = 15;

const buildHabitEvent = (habit: Habit, key: string, stamp: string): string[] | undefined => {
    const time = habit.reminderTime;
    if (!time || !/^\d{2}:\d{2}$/.test(time)) {
        return undefined;
    }
    const description = [
        habit.name,
        "习惯打卡",
        `siyuan://blocks/${habit.id}`,
    ].join("\n");
    return [
        "BEGIN:VEVENT",
        `UID:${habit.id}-${key.replace(/-/g, "")}@task-secretary.siyuan`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${formatLocal(key, time)}`,
        `DURATION:PT${HABIT_EVENT_MINUTES}M`,
        `SUMMARY:${escapeText(habit.name)}`,
        `DESCRIPTION:${escapeText(description)}`,
        "STATUS:CONFIRMED",
        "TRANSP:TRANSPARENT",
        "CATEGORIES:知行 GTD,习惯",
        `X-SIYUAN-BLOCK-ID:${habit.id}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeText(habit.name)}`,
        "TRIGGER:PT0S",
        "END:VALARM",
        "END:VEVENT",
    ];
};

export const buildICS = (tasks: Task[], options: IcsOptions): IcsResult => {
    const stamp = formatUtc(options.now || new Date());
    const lines: string[] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//SiYuan ZhiXing GTD//ZhiXing GTD 0.5.1//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:知行 GTD",
    ];

    let exported = 0;
    let noDue = 0;
    let skippedOverdue = 0;

    for (const task of tasks) {
        if (!task.dueDate) {
            noDue++;
            continue;
        }
        if (!options.includeOverdue && task.overdue) {
            skippedOverdue++;
            continue;
        }
        const event = buildEvent(task, options, stamp);
        if (event) {
            lines.push(...event);
            exported++;
        }
    }

    const today = dateKey(options.now || new Date());
    const horizon = shiftDateKey(today, Math.max(1, options.horizonDays ?? 90));
    (options.habits ?? []).forEach((habit) => {
        if (!habit.reminderTime) {
            return;
        }
        const end = habit.endDate && habit.endDate < horizon ? habit.endDate : horizon;
        let key = habit.created > today ? habit.created : today;
        for (let index = 0; index < 370 && key <= end; index++) {
            if (isScheduled(habit, key)) {
                const event = buildHabitEvent(habit, key, stamp);
                if (event) {
                    lines.push(...event);
                    exported++;
                }
            }
            key = shiftDateKey(key, 1);
        }
    });

    lines.push("END:VCALENDAR");
    return {
        content: lines.map(foldLine).join("\r\n") + "\r\n",
        exported,
        noDue,
        skippedOverdue,
    };
};
