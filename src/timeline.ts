import type {Priority, Task} from "./types";
import {habitDone, isScheduled, type Habit, type HabitTimeSlot} from "./habit-store";

export type PlanPeriod = "overdue" | "morning" | "afternoon" | "evening" | "anytime" | "unscheduled";

export const PLAN_ORDER: PlanPeriod[] = [
    "overdue",
    "morning",
    "afternoon",
    "evening",
    "anytime",
    "unscheduled",
];

export interface PlanItem {
    kind: "task" | "habit";
    id: string;
    title: string;
    period: PlanPeriod;
    time?: string;
    done: boolean;
    priority?: Priority;
    task?: Task;
    habit?: Habit;
    /** Nested subtasks shown under this item. */
    children?: PlanItem[];
}

export interface PlanGroup {
    period: PlanPeriod;
    items: PlanItem[];
}

export interface PlanSummary {
    tasks: number;
    routines: number;
    events: number;
    habits: number;
    habitsDone: number;
}

/** 00:00–11:59 morning, 12:00–17:59 afternoon, 18:00–23:59 evening. */
export const taskPeriod = (dueTime?: string): PlanPeriod => {
    if (!dueTime) {
        return "anytime";
    }
    const [hours] = dueTime.split(":").map(Number);
    if (!Number.isFinite(hours)) {
        return "anytime";
    }
    if (hours < 12) {
        return "morning";
    }
    if (hours < 18) {
        return "afternoon";
    }
    return "evening";
};

export const habitPeriod = (slot: HabitTimeSlot): PlanPeriod => slot === "anytime" ? "anytime" : slot;

const timeSortValue = (time?: string) => time || "99:99";

const comparePlanItems = (a: PlanItem, b: PlanItem) =>
    timeSortValue(a.time).localeCompare(timeSortValue(b.time)) ||
    (a.kind === b.kind ? 0 : a.kind === "task" ? -1 : 1) ||
    (a.priority ?? 2) - (b.priority ?? 2) ||
    a.title.localeCompare(b.title);

/** Moves tasks whose parent is also in the list under that parent. */
export const nestPlanItems = (items: PlanItem[]): PlanItem[] => {
    const byId = new Map(items.map((item) => [item.id, item]));
    const roots: PlanItem[] = [];
    items.forEach((item) => {
        const parent = item.task?.parentID ? byId.get(item.task.parentID) : undefined;
        if (parent && parent !== item) {
            if (!parent.children) {
                parent.children = [];
            }
            parent.children.push(item);
        } else {
            roots.push(item);
        }
    });
    const sortTree = (list: PlanItem[]) => {
        list.sort(comparePlanItems);
        list.forEach((item) => {
            if (item.children?.length) {
                sortTree(item.children);
            }
        });
    };
    sortTree(roots);
    return roots;
};

/** Builds the agenda for one day. Overdue and unscheduled tasks only appear for today. */
export const buildPlan = (tasks: Task[], habits: Habit[], date: string, today: string): PlanGroup[] => {
    const buckets = new Map<PlanPeriod, PlanItem[]>();
    PLAN_ORDER.forEach((period) => buckets.set(period, []));

    tasks.forEach((task) => {
        let period: PlanPeriod | undefined;
        if (task.dueDate === date) {
            period = taskPeriod(task.dueTime);
        } else if (date === today && task.dueDate && task.dueDate < date) {
            period = "overdue";
        } else if (date === today && !task.dueDate) {
            period = "unscheduled";
        }
        if (!period) {
            return;
        }
        buckets.get(period)!.push({
            kind: "task",
            id: task.id,
            title: task.title,
            period,
            time: task.dueTime,
            done: false,
            priority: task.priority,
            task,
        });
    });

    habits.forEach((habit) => {
        if (!isScheduled(habit, date)) {
            return;
        }
        const period = habit.reminderTime ? taskPeriod(habit.reminderTime) : habitPeriod(habit.timeSlot);
        buckets.get(period)!.push({
            kind: "habit",
            id: habit.id,
            title: habit.name,
            period,
            time: habit.reminderTime,
            done: habitDone(habit, date),
            habit,
        });
    });

    return PLAN_ORDER.map((period) => {
        const items = buckets.get(period)!;
        items.sort(comparePlanItems);
        return {period, items};
    }).filter((group) => group.items.length > 0);
};

export interface HourSlot {
    hour: number;
    items: PlanItem[];
}

export interface DayPlan {
    overdue: PlanItem[];
    anytime: PlanItem[];
    unscheduled: PlanItem[];
    hours: HourSlot[];
    hasTimed: boolean;
}

const HOUR_RE = /^(\d{1,2}):(\d{2})$/;
const ANYTIME_PERIOD_ORDER: Record<PlanPeriod, number> = {
    overdue: 0,
    morning: 1,
    afternoon: 2,
    evening: 3,
    anytime: 4,
    unscheduled: 5,
};

/** Builds a single-day plan with an hour scale. Items with an exact time go into hour slots. */
export const buildDayPlan = (
    tasks: Task[],
    habits: Habit[],
    date: string,
    today: string,
    accepts?: (item: PlanItem) => boolean,
): DayPlan => {
    const groups = buildPlan(tasks, habits, date, today);
    const overdue: PlanItem[] = [];
    const anytime: PlanItem[] = [];
    const unscheduled: PlanItem[] = [];
    const byHour = new Map<number, PlanItem[]>();
    const filtered: PlanItem[] = [];

    groups.forEach((group) => {
        group.items.forEach((item) => {
            if (!accepts || accepts(item)) {
                filtered.push(item);
            }
        });
    });

    nestPlanItems(filtered).forEach((item) => {
        if (item.period === "overdue") {
            overdue.push(item);
            return;
        }
        if (item.period === "unscheduled") {
            unscheduled.push(item);
            return;
        }
        const match = item.time?.match(HOUR_RE);
        const hour = match ? Number(match[1]) : NaN;
        if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
            const list = byHour.get(hour) ?? [];
            list.push(item);
            byHour.set(hour, list);
            return;
        }
        anytime.push(item);
    });

    overdue.sort(comparePlanItems);
    anytime.sort((a, b) =>
        (ANYTIME_PERIOD_ORDER[a.period] ?? 9) - (ANYTIME_PERIOD_ORDER[b.period] ?? 9)
        || comparePlanItems(a, b));
    unscheduled.sort(comparePlanItems);

    const hourKeys = [...byHour.keys()].sort((a, b) => a - b);
    if (hourKeys.length === 0) {
        return {overdue, anytime, unscheduled, hours: [], hasTimed: false};
    }

    const start = Math.max(0, Math.min(8, hourKeys[0] - 1));
    const end = Math.min(23, Math.max(18, hourKeys[hourKeys.length - 1] + 1));
    const hours: HourSlot[] = [];
    for (let hour = start; hour <= end; hour++) {
        const items = byHour.get(hour) ?? [];
        items.sort(comparePlanItems);
        hours.push({hour, items});
    }
    return {overdue, anytime, unscheduled, hours, hasTimed: true};
};

export const summarizePlan = (groups: PlanGroup[]): PlanSummary => {
    const summary: PlanSummary = {tasks: 0, routines: 0, events: 0, habits: 0, habitsDone: 0};
    groups.forEach((group) => group.items.forEach((item) => {
        if (item.kind === "task") {
            if (item.task?.type === "routine") {
                summary.routines++;
            } else if (item.task?.type === "event") {
                summary.events++;
            } else {
                summary.tasks++;
            }
        } else {
            summary.habits++;
            if (item.done) {
                summary.habitsDone++;
            }
        }
    }));
    return summary;
};
