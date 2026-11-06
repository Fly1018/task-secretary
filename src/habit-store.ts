export interface HabitScheduleDaily {
    type: "daily";
}

export interface HabitScheduleWeekly {
    type: "weekly";
    /** 0 = Sunday … 6 = Saturday. */
    days: number[];
}

export interface HabitScheduleMonthly {
    type: "monthly";
    /** Day of month, 1–31. Shorter months use their last day. */
    day: number;
}

export interface HabitScheduleYearly {
    type: "yearly";
    /** 1–12. */
    month: number;
    /** 1–31. Shorter months use their last day. */
    day: number;
}

export interface HabitScheduleEbbinghaus {
    type: "ebbinghaus";
}

export interface HabitScheduleNone {
    type: "none";
}

export type HabitSchedule =
    | HabitScheduleDaily
    | HabitScheduleWeekly
    | HabitScheduleMonthly
    | HabitScheduleYearly
    | HabitScheduleEbbinghaus
    | HabitScheduleNone;

/** How a habit is considered complete for a day. */
export type HabitGoal = "count" | "duration" | "either";

/** Timer style used by duration-based goals. */
export type HabitTimerMode = "pomodoro" | "stopwatch";

/** Message shown when a pomodoro auto-checks in. */
export type HabitAutoLabel = "success" | "done";

/** Preferred part of the day, used by the timeline plan. */
export type HabitTimeSlot = "morning" | "afternoon" | "evening" | "anytime";

export interface Habit {
    id: string;
    name: string;
    schedule: HabitSchedule;
    timeSlot: HabitTimeSlot;
    /** Optional local reminder time, HH:mm. Habits with a reminder time are exported to ICS. */
    reminderTime?: string;
    /** Start date, as YYYY-MM-DD. Days before it never count. */
    created: string;
    /** Optional last day, as YYYY-MM-DD. */
    endDate?: string;
    /** The habit was given up; it stays in history but is no longer scheduled. */
    abandoned?: boolean;
    /** Every N days from the start date. 1 means every scheduled day. */
    interval: number;
    goal: HabitGoal;
    targetCount: number;
    targetMinutes: number;
    autoCheckIn: boolean;
    autoCheckInLabel: HabitAutoLabel;
    timerMode: HabitTimerMode;
    /** Check-in count per day, as YYYY-MM-DD -> count. */
    records: Record<string, number>;
    /** Focused minutes per day, as YYYY-MM-DD -> minutes. */
    focus: Record<string, number>;
    /** Manual completion for duration goals, as YYYY-MM-DD -> true. */
    manualDone?: Record<string, true>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_INTERVAL = 365;
const MAX_FOCUS_MINUTES = 1440;
const MAX_TARGET_COUNT = 99;

export const DEFAULT_TARGET_MINUTES = 45;

const pad = (value: number) => String(value).padStart(2, "0");

export const dateKey = (date = new Date()): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const parseDateKey = (key: string): Date => {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day);
};

const daysBetween = (from: string, to: string): number =>
    Math.round((parseDateKey(to).getTime() - parseDateKey(from).getTime()) / 86400000);

export const shiftDateKey = (key: string, delta: number): string => {
    const date = parseDateKey(key);
    date.setDate(date.getDate() + delta);
    return dateKey(date);
};

export const weekdayOf = (key: string): number => parseDateKey(key).getDay();

const EBBINGHAUS_DAYS = [0, 1, 2, 4, 7, 15, 30];

const daysInMonth = (year: number, monthIndex: number): number =>
    new Date(year, monthIndex + 1, 0).getDate();

const startOfWeek = (key: string): string => shiftDateKey(key, -weekdayOf(key));

export const isScheduled = (habit: Habit, key: string): boolean => {
    if (habit.abandoned) {
        return false;
    }
    if (key < habit.created) {
        return false;
    }
    if (habit.endDate && key > habit.endDate) {
        return false;
    }
    const interval = Math.max(1, Math.round(habit.interval || 1));
    const created = parseDateKey(habit.created);
    const current = parseDateKey(key);
    switch (habit.schedule.type) {
        case "daily":
            return daysBetween(habit.created, key) % interval === 0;
        case "weekly": {
            const weekDiff = Math.round(
                (parseDateKey(startOfWeek(key)).getTime() - parseDateKey(startOfWeek(habit.created)).getTime()) / (7 * 86400000),
            );
            return weekDiff >= 0 && weekDiff % interval === 0 && habit.schedule.days.includes(weekdayOf(key));
        }
        case "monthly": {
            const monthDiff = (current.getFullYear() - created.getFullYear()) * 12 + (current.getMonth() - created.getMonth());
            if (monthDiff < 0 || monthDiff % interval !== 0) {
                return false;
            }
            const day = Math.min(habit.schedule.day, daysInMonth(current.getFullYear(), current.getMonth()));
            return current.getDate() === day;
        }
        case "yearly": {
            const yearDiff = current.getFullYear() - created.getFullYear();
            if (yearDiff < 0 || yearDiff % interval !== 0) {
                return false;
            }
            if (current.getMonth() + 1 !== habit.schedule.month) {
                return false;
            }
            const day = Math.min(habit.schedule.day, daysInMonth(current.getFullYear(), current.getMonth()));
            return current.getDate() === day;
        }
        case "ebbinghaus":
            return EBBINGHAUS_DAYS.includes(daysBetween(habit.created, key));
        case "none":
            return false;
        default:
            return false;
    }
};

export const checkInCount = (habit: Habit, key: string): number => {
    const value = habit.records?.[key];
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
};

export const countDone = (habit: Habit, key: string): boolean =>
    checkInCount(habit, key) >= Math.max(1, habit.targetCount);

export const focusMinutes = (habit: Habit, key: string): number => {
    const value = habit.focus?.[key];
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
};

/** Completion depends on the goal: a manual tick, focus minutes, or check-in count. */
export const habitDone = (habit: Habit, key: string): boolean => {
    if (habit.manualDone?.[key]) {
        return true;
    }
    if (habit.goal === "duration") {
        return focusMinutes(habit, key) >= Math.max(1, habit.targetMinutes);
    }
    if (habit.goal === "either") {
        return countDone(habit, key) || focusMinutes(habit, key) >= Math.max(1, habit.targetMinutes);
    }
    return countDone(habit, key);
};

export const habitEnded = (habit: Habit, key = dateKey()): boolean =>
    habit.abandoned === true || Boolean(habit.endDate && key > habit.endDate);

export const newHabitID = (): string =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const createHabit = (
    name: string,
    schedule: HabitSchedule,
    today = dateKey(),
): Habit => ({
    id: newHabitID(),
    name: name.trim(),
    schedule,
    timeSlot: "anytime",
    created: today,
    interval: 1,
    goal: "count",
    targetCount: 1,
    targetMinutes: DEFAULT_TARGET_MINUTES,
    autoCheckIn: false,
    autoCheckInLabel: "success",
    timerMode: "pomodoro",
    records: {},
    focus: {},
    manualDone: {},
});

const withManual = (habit: Habit, key: string, done: boolean): Habit => {
    const manualDone = {...habit.manualDone};
    if (done) {
        manualDone[key] = true;
    } else {
        delete manualDone[key];
    }
    return {...habit, manualDone};
};

const withCount = (habit: Habit, key: string, count: number): Habit => {
    const records = {...habit.records};
    if (count <= 0) {
        delete records[key];
    } else {
        records[key] = count;
    }
    return {...habit, records};
};

/** Clicking the check button adds one count, capped at the target. */
export const incrementHabit = (habit: Habit, key = dateKey()): Habit => {
    const target = Math.max(1, habit.targetCount);
    const current = checkInCount(habit, key);
    if (current >= target) {
        return habit;
    }
    return withCount(habit, key, current + 1);
};

/** Ticks a habit off; a duration goal uses a manual completion flag instead of a count. */
export const toggleHabit = (habit: Habit, key = dateKey()): Habit => {
    if (habit.manualDone?.[key]) {
        return withManual(habit, key, false);
    }
    if (habit.goal === "duration") {
        if (focusMinutes(habit, key) >= Math.max(1, habit.targetMinutes)) {
            return habit;
        }
        return withManual(habit, key, true);
    }
    const target = Math.max(1, habit.targetCount);
    if (checkInCount(habit, key) >= target) {
        return withCount(habit, key, 0);
    }
    return incrementHabit(habit, key);
};

/** Removes one check-in; repeated clicks walk the count back to zero. */
export const decrementHabit = (habit: Habit, key = dateKey()): Habit => {
    const current = checkInCount(habit, key);
    if (current <= 0) {
        return habit;
    }
    return withCount(habit, key, current - 1);
};

export const addCheckIn = (habit: Habit, key: string, amount = 1): Habit => {
    const target = Math.max(1, habit.targetCount);
    const current = checkInCount(habit, key);
    return withCount(habit, key, Math.min(target, current + Math.max(0, Math.round(amount))));
};

export const addFocusMinutes = (habit: Habit, key: string, minutes: number): Habit => {
    const current = focusMinutes(habit, key);
    const next = Math.min(MAX_FOCUS_MINUTES, current + Math.max(0, Math.round(minutes)));
    return {...habit, focus: {...habit.focus, [key]: next}};
};

/** Consecutive completed scheduled days. Today being incomplete does not break the streak yet. */
export const habitStreak = (habit: Habit, today = dateKey()): number => {
    let streak = 0;
    let key = today;
    for (let index = 0; index < 3700 && key >= habit.created; index++) {
        if (isScheduled(habit, key)) {
            if (habitDone(habit, key)) {
                streak++;
            } else if (key !== today) {
                break;
            }
        }
        key = shiftDateKey(key, -1);
    }
    return streak;
};

export interface HabitWeekDay {
    key: string;
    weekday: number;
    scheduled: boolean;
    done: boolean;
    beforeCreated: boolean;
}

export const habitWeek = (habit: Habit, today = dateKey(), length = 7): HabitWeekDay[] => {
    const days: HabitWeekDay[] = [];
    for (let offset = length - 1; offset >= 0; offset--) {
        const key = shiftDateKey(today, -offset);
        days.push({
            key,
            weekday: weekdayOf(key),
            scheduled: isScheduled(habit, key),
            done: habitDone(habit, key),
            beforeCreated: key < habit.created,
        });
    }
    return days;
};

export const todayProgress = (habits: Habit[], today = dateKey()): {done: number; total: number} => {
    let done = 0;
    let total = 0;
    habits.forEach((habit) => {
        if (!isScheduled(habit, today)) {
            return;
        }
        total++;
        if (habitDone(habit, today)) {
            done++;
        }
    });
    return {done, total};
};

/** Today's pending habits first, then today's completed ones, then inactive habits. */
export const sortHabits = (habits: Habit[], today = dateKey()): Habit[] => [...habits].sort((a, b) => {
    const rank = (habit: Habit) => {
        if (habitEnded(habit, today)) {
            return 3;
        }
        if (!isScheduled(habit, today)) {
            return 2;
        }
        return habitDone(habit, today) ? 1 : 0;
    };
    return rank(a) - rank(b) || a.created.localeCompare(b.created) || a.name.localeCompare(b.name);
});

const normalizeSchedule = (raw: any): HabitSchedule | undefined => {
    if (raw?.type === "weekly") {
        const days = [...new Set<number>(
            (Array.isArray(raw.days) ? raw.days : [])
                .map(Number)
                .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
        )].sort((a, b) => a - b);
        return days.length ? {type: "weekly", days} : undefined;
    }
    if (raw?.type === "monthly") {
        const dayValue = Number(raw.day);
        return {type: "monthly", day: Number.isInteger(dayValue) && dayValue >= 1 && dayValue <= 31 ? dayValue : 1};
    }
    if (raw?.type === "yearly") {
        const monthValue = Number(raw.month);
        const dayValue = Number(raw.day);
        return {
            type: "yearly",
            month: Number.isInteger(monthValue) && monthValue >= 1 && monthValue <= 12 ? monthValue : 1,
            day: Number.isInteger(dayValue) && dayValue >= 1 && dayValue <= 31 ? dayValue : 1,
        };
    }
    if (raw?.type === "ebbinghaus") {
        return {type: "ebbinghaus"};
    }
    if (raw?.type === "none") {
        return {type: "none"};
    }
    return {type: "daily"};
};

const normalizeManual = (raw: any): Record<string, true> => {
    const manual: Record<string, true> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        Object.keys(raw).forEach((key) => {
            if (DATE_RE.test(key) && raw[key] === true) {
                manual[key] = true;
            }
        });
    }
    return manual;
};

const normalizeRecords = (raw: any): Record<string, number> => {
    const records: Record<string, number> = {};
    if (Array.isArray(raw)) {
        raw.forEach((key) => {
            const text = String(key);
            if (DATE_RE.test(text)) {
                records[text] = 1;
            }
        });
        return records;
    }
    if (!raw || typeof raw !== "object") {
        return records;
    }
    Object.entries(raw).forEach(([key, value]) => {
        const count = Number(value);
        if (DATE_RE.test(key) && Number.isFinite(count) && count > 0) {
            records[key] = Math.min(MAX_TARGET_COUNT, Math.round(count));
        }
    });
    return records;
};

const normalizeFocus = (raw: any): Record<string, number> => {
    const focus: Record<string, number> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return focus;
    }
    Object.entries(raw).forEach(([key, value]) => {
        const minutes = Number(value);
        if (DATE_RE.test(key) && Number.isFinite(minutes) && minutes > 0) {
            focus[key] = Math.min(MAX_FOCUS_MINUTES, Math.round(minutes));
        }
    });
    return focus;
};

/** Accepts either a habit array or {version, habits}; drops malformed entries. */
export const normalizeHabits = (raw: any, today = dateKey()): Habit[] => {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.habits) ? raw.habits : [];
    const seen = new Set<string>();
    const habits: Habit[] = [];
    list.forEach((item: any) => {
        if (!item || typeof item !== "object") {
            return;
        }
        const name = String(item.name ?? "").trim();
        const schedule = normalizeSchedule(item.schedule);
        if (!name || !schedule) {
            return;
        }
        let id = String(item.id ?? "").trim();
        if (!id || seen.has(id)) {
            id = newHabitID();
        }
        seen.add(id);
        const created = DATE_RE.test(String(item.created ?? "")) ? String(item.created) : today;
        const endDate = DATE_RE.test(String(item.endDate ?? "")) ? String(item.endDate) : undefined;
        const intervalValue = Number(item.interval);
        const interval = Number.isInteger(intervalValue) && intervalValue >= 1 && intervalValue <= MAX_INTERVAL
            ? intervalValue
            : 1;
        const goal: HabitGoal = item.goal === "duration" || item.goal === "either" ? item.goal : "count";
        const targetCountValue = Number(item.targetCount);
        const targetCount = Number.isInteger(targetCountValue) && targetCountValue >= 1 && targetCountValue <= MAX_TARGET_COUNT
            ? targetCountValue
            : 1;
        const targetMinutesValue = Number(item.targetMinutes);
        const targetMinutes = Number.isInteger(targetMinutesValue) && targetMinutesValue >= 1 && targetMinutesValue <= MAX_FOCUS_MINUTES
            ? targetMinutesValue
            : DEFAULT_TARGET_MINUTES;
        habits.push({
            id,
            name,
            schedule,
            timeSlot: item.timeSlot === "morning" || item.timeSlot === "afternoon" || item.timeSlot === "evening"
                ? item.timeSlot
                : "anytime",
            created,
            endDate,
            abandoned: item.abandoned === true,
            interval,
            goal,
            targetCount,
            targetMinutes,
            autoCheckIn: item.autoCheckIn === true,
            autoCheckInLabel: item.autoCheckInLabel === "done" ? "done" : "success",
            timerMode: item.timerMode === "stopwatch" ? "stopwatch" : "pomodoro",
            reminderTime: TIME_RE.test(String(item.reminderTime ?? "")) ? String(item.reminderTime) : undefined,
            records: normalizeRecords(item.records),
            focus: normalizeFocus(item.focus),
            manualDone: normalizeManual(item.manualDone),
        });
    });
    return habits;
};
