import {Dialog, getFrontend, showMessage} from "siyuan";
import {confirmDialog} from "./confirm";
import {
    DEFAULT_TARGET_MINUTES,
    addCheckIn,
    addFocusMinutes,
    checkInCount,
    countDone,
    createHabit,
    dateKey,
    decrementHabit,
    focusMinutes,
    habitDone,
    habitEnded,
    habitStreak,
    habitWeek,
    isScheduled,
    sortHabits,
    todayProgress,
    toggleHabit,
    type Habit,
    type HabitAutoLabel,
    type HabitGoal,
    type HabitSchedule,
    type HabitTimeSlot,
    type HabitTimerMode,
} from "./habit-store";
import type {PomodoroState} from "./pomodoro";

export interface HabitViewHost {
    i18n: Record<string, any>;
    getHabits(): Promise<Habit[]>;
    saveHabits(habits: Habit[]): Promise<void>;
    /** Inserts the habit-panel embed block at the cursor of the active document. */
    insertHabitEmbed?(): void;
    startHabitPomodoro?(habit: Habit): void;
    getPomodoroState?(): PomodoroState | null;
}

export interface HabitView {
    refresh(): Promise<void>;
    destroy(): void;
}

const WEEKDAY_FALLBACK = ["日", "一", "二", "三", "四", "五", "六"];

const escapeHtml = (value: string) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const t = (host: HabitViewHost, key: string, fallback: string, vars?: Record<string, string | number>) => {
    let text = String(host.i18n?.[key] ?? fallback);
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), String(value));
        }
    }
    return text;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const weekdayName = (host: HabitViewHost, day: number) =>
    t(host, `weekdayShort${day}`, WEEKDAY_FALLBACK[day] ?? String(day));

const slotLabel = (host: HabitViewHost, slot: HabitTimeSlot) => {
    if (slot === "morning") {
        return t(host, "habitSlotMorning", "Morning");
    }
    if (slot === "afternoon") {
        return t(host, "habitSlotAfternoon", "Afternoon");
    }
    if (slot === "evening") {
        return t(host, "habitSlotEvening", "Evening");
    }
    return t(host, "habitSlotAnytime", "Any time");
};

const scheduleLabel = (host: HabitViewHost, habit: Habit) => {
    const interval = Math.max(1, Math.round(habit.interval || 1));
    switch (habit.schedule.type) {
        case "daily":
            return interval > 1
                ? t(host, "habitEveryDays", "Every ${count} days", {count: interval})
                : t(host, "habitFrequencyDaily", "Every day");
        case "weekly": {
            const separator = t(host, "weekdaySeparator", "、");
            const days = habit.schedule.days.map((day) => weekdayName(host, day)).join(separator);
            const base = interval > 1
                ? t(host, "habitEveryWeeks", "Every ${count} weeks", {count: interval})
                : t(host, "habitFrequencyWeekly", "Every week");
            return days ? `${base} · ${days}` : base;
        }
        case "monthly":
            return interval > 1
                ? t(host, "habitEveryMonths", "Every ${count} months", {count: interval})
                : t(host, "habitFrequencyMonthly", "Every month");
        case "yearly":
            return interval > 1
                ? t(host, "habitEveryYears", "Every ${count} years", {count: interval})
                : t(host, "habitFrequencyYearly", "Every year");
        case "ebbinghaus":
            return t(host, "habitFrequencyEbbinghaus", "Ebbinghaus");
        case "none":
            return t(host, "habitFrequencyNone", "No fixed schedule");
        default:
            return t(host, "habitFrequencyDaily", "Every day");
    }
};

const weekDotClass = (
    day: {key: string; scheduled: boolean; done: boolean; beforeCreated: boolean},
    today: string,
) => {
    if (day.beforeCreated) {
        return "ts-habit__dot--off";
    }
    if (day.done) {
        return "ts-habit__dot--done";
    }
    if (!day.scheduled) {
        return "ts-habit__dot--off";
    }
    return day.key === today ? "ts-habit__dot--today" : "ts-habit__dot--missed";
};

const formatClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const habitRow = (host: HabitViewHost, habit: Habit, today: string, timerText?: string, pomodoroActive = false) => {
    const scheduledToday = isScheduled(habit, today);
    const anytime = habit.schedule.type === "none";
    const activeToday = scheduledToday || anytime;
    const count = checkInCount(habit, today);
    const recordDone = countDone(habit, today);
    const doneToday = habitDone(habit, today);
    const ended = habitEnded(habit, today);
    const streak = habitStreak(habit, today);
    const week = habitWeek(habit, today);
    const targetCount = Math.max(1, habit.targetCount);
    const targetMinutes = Math.max(1, habit.targetMinutes);
    const focused = focusMinutes(habit, today);
    const focusSatisfied = habit.goal !== "count" && focused >= targetMinutes;
    const manualDone = habit.manualDone?.[today] === true;
    const progressRatio = habit.goal === "count"
        ? count / targetCount
        : habit.goal === "duration"
            ? Math.max(focused / targetMinutes, manualDone ? 1 : 0)
            : Math.max(count / targetCount, focused / targetMinutes);
    const progressPercent = Math.min(100, Math.round(progressRatio * 100));
    const showProgress = habit.goal !== "count" || targetCount > 1;
    const meta = [scheduleLabel(host, habit)];
    if (habit.timeSlot !== "anytime") {
        meta.push(slotLabel(host, habit.timeSlot));
    }
    if (habit.reminderTime) {
        meta.push(t(host, "habitReminderAt", "Reminder ${time}", {time: habit.reminderTime}));
    }
    if (habit.goal !== "duration") {
        meta.push(t(host, "habitCountProgress", "Check-ins ${count}/${target}", {count, target: targetCount}));
    }
    if (habit.goal !== "count") {
        meta.push(t(host, "habitFocusProgress", "Focus ${minutes}/${target} min", {
            minutes: focused,
            target: targetMinutes,
        }));
    }
    if (habit.goal === "duration" && manualDone && !focusSatisfied) {
        meta.push(t(host, "habitManualDone", "Manually completed"));
    }
    if (streak > 0) {
        meta.push(t(host, "habitStreak", "Streak ${count}", {count: streak}));
    }
    if (ended) {
        meta.push(t(host, "habitEnded", "Ended"));
    } else if (!activeToday) {
        meta.push(t(host, "habitNotToday", "Not scheduled today"));
    }
    const checkDone = habit.goal === "duration" ? (manualDone || focusSatisfied) : recordDone;
    const checkDisabled = !activeToday || ended || focusSatisfied;
    const checkTitle = ended
        ? t(host, "habitEnded", "Ended")
        : !activeToday
            ? t(host, "habitNotToday", "Not scheduled today")
            : focusSatisfied
                ? t(host, "habitDoneByFocus", "Completed by focus")
                : checkDone
                    ? t(host, "habitUndoToday", "Undo today's check-in")
                    : t(host, "habitCheckToday", "Check in for today");
    const timerTitle = timerText !== undefined
        ? t(host, "habitStopwatchStop", "Stop and record")
        : t(host, "habitStopwatchStart", "Start counting up");
    const showTimer = habit.timerMode === "stopwatch";
    return `<div class="ts-habit${activeToday ? "" : " ts-habit--off"}${doneToday ? " ts-habit--done" : ""}${ended ? " ts-habit--ended" : ""}" data-habit-id="${habit.id}">
  <div class="ts-habit__marks">
    ${habit.goal !== "duration" && count > 0 ? `<button class="ts-habit__minus" data-habit-action="decrement"${activeToday ? "" : " disabled"} title="${escapeHtml(t(host, "habitDecreaseCount", "Remove one check-in"))}">−</button>` : ""}
    <button class="ts-habit__check${checkDone ? " ts-habit__check--done" : ""}" data-habit-action="toggle"${checkDisabled ? " disabled" : ""} title="${escapeHtml(checkTitle)}">✓</button>
    ${showTimer ? `<button class="ts-habit__tomato${timerText !== undefined ? " ts-habit__tomato--running" : ""}" data-habit-action="timer"${activeToday ? "" : " disabled"} title="${escapeHtml(timerTitle)}">${habit.timerMode === "stopwatch" ? "⏱" : "🍅"}</button>` : ""}
  </div>
  <div class="ts-habit__body">
    <div class="ts-habit__name">${escapeHtml(habit.name)}</div>
    <div class="ts-habit__meta">${meta.map((item) => escapeHtml(item)).join(`<span class="ts-habit__sep">·</span>`)}${timerText !== undefined ? `<span class="ts-habit__sep">·</span><span class="ts-habit__timer">${escapeHtml(timerText)}</span>` : ""}</div>
    ${showProgress ? `<div class="ts-habit__progress" title="${progressPercent}%"><span style="width:${progressPercent}%"></span></div>` : ""}
  </div>
  <div class="ts-habit__week" title="${escapeHtml(t(host, "habitLastWeek", "Last 7 days"))}">
    ${week.map((day) => `<span class="ts-habit__dot ${weekDotClass(day, today)}" title="${escapeHtml(day.key)}"></span>`).join("")}
  </div>
  <div class="ts-habit__actions">
    <button data-habit-action="pomodoro" class="${pomodoroActive ? "ts-habit__tomato--running" : ""}" title="${escapeHtml(pomodoroActive ? t(host, "pomodoroStopTask", "Stop pomodoro") : t(host, "pomodoroStart", "Start pomodoro"))}">🍅</button>
    <button data-habit-action="edit" title="${escapeHtml(t(host, "habitEdit", "Edit habit"))}"><svg><use xlink:href="#iconEdit"></use></svg></button>
    <button data-habit-action="delete" title="${escapeHtml(t(host, "habitDelete", "Delete habit"))}"><svg><use xlink:href="#iconTrashcan"></use></svg></button>
  </div>
</div>`;
};

export const mountHabitView = (host: HabitViewHost, container: HTMLElement): HabitView => {
    let habits: Habit[] = [];
    let destroyed = false;
    let pomodoroState: PomodoroState | null = host.getPomodoroState?.() ?? null;
    const timers = new Map<string, {startedAt: number; endsAt?: number; handle: number}>();

    const timerText = (id: string): string | undefined => {
        const state = timers.get(id);
        if (!state) {
            return undefined;
        }
        if (state.endsAt) {
            return formatClock(Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000)));
        }
        return formatClock(Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)));
    };

    const clearTimer = (id: string) => {
        const state = timers.get(id);
        if (!state) {
            return;
        }
        window.clearInterval(state.handle);
        timers.delete(id);
    };

    const pruneTimers = (list: Habit[], today: string) => {
        timers.forEach((state, id) => {
            const habit = list.find((item) => item.id === id);
            if (!habit || !isScheduled(habit, today)) {
                window.clearInterval(state.handle);
                timers.delete(id);
            }
        });
    };

    const render = () => {
        if (destroyed) {
            return;
        }
        const today = dateKey();
        pruneTimers(habits, today);
        const ordered = sortHabits(habits, today);
        const progress = todayProgress(habits, today);
        const summary = progress.total > 0
            ? t(host, "habitTodaySummary", "Today ${done}/${total}", {done: progress.done, total: progress.total})
            : t(host, "habitNothingToday", "Nothing scheduled for today");
        const rows = ordered.map((habit) => {
            const pomodoroActive = pomodoroState?.target.kind === "habit" && pomodoroState.target.id === habit.id;
            const displayText = pomodoroActive && pomodoroState
                ? formatClock(pomodoroState.remainingSeconds)
                : timerText(habit.id);
            return habitRow(host, habit, today, displayText, pomodoroActive);
        }).join("");
        const totalPercent = progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0;
        container.innerHTML = `<div class="ts-habits">
  <div class="ts-habits__head">
    <div class="ts-habits__heading">
      <div class="ts-habits__title">${escapeHtml(t(host, "tabHabits", "Habits"))}</div>
      <div class="ts-habits__summary">${escapeHtml(summary)}</div>
    </div>
    <div class="ts-habits__actions">
      <button class="b3-button b3-button--outline" data-habit-action="create">${escapeHtml(t(host, "habitCreate", "New habit"))}</button>
    </div>
  </div>
  <div class="ts-habits__meter" role="progressbar" aria-valuenow="${totalPercent}" aria-valuemin="0" aria-valuemax="100" title="${escapeHtml(summary)}"><span style="width:${totalPercent}%"></span></div>
  ${habits.length > 0
        ? `<div class="ts-habit-list">${rows}</div>`
        : `<div class="ts-empty ts-habits__empty">
  <div>${escapeHtml(t(host, "habitEmpty", "No habits yet. Create your first one."))}</div>
</div>`}
</div>`;
    };

    const save = async (next: Habit[]) => {
        await host.saveHabits(next);
        habits = next;
        render();
    };

    const openEditor = (existing?: Habit) => {
        const editing = Boolean(existing);
        const schedule = existing?.schedule;
        const frequency = schedule?.type ?? "daily";
        const isWeekly = frequency === "weekly";
        const selectedDays = new Set(schedule?.type === "weekly" ? schedule.days : []);
        const abandoned = existing?.abandoned === true;
        const goal = existing?.goal ?? "count";
        const timeSlot = existing?.timeSlot ?? "anytime";
        const interval = existing?.interval ?? 1;
        const startDate = existing?.created ?? dateKey();
        const endDate = existing?.endDate ?? "";
        const reminderTime = existing?.reminderTime ?? "";
        const targetCount = existing?.targetCount ?? 1;
        const targetMinutes = existing?.targetMinutes ?? DEFAULT_TARGET_MINUTES;
        const targetHours = Math.floor(targetMinutes / 60);
        const targetMinutePart = targetMinutes % 60;
        const autoCheckIn = existing?.autoCheckIn === true;
        const autoLabel = existing?.autoCheckInLabel ?? "success";
        const timerMode = existing?.timerMode ?? "pomodoro";
        const dialog = new Dialog({
            title: editing ? t(host, "habitEdit", "Edit habit") : t(host, "habitCreate", "New habit"),
            content: `<div class="b3-dialog__content ts-habit-form">
  <section class="ts-form-section">
    <div class="ts-form-section__title">${escapeHtml(t(host, "habitSectionBasics", "Basics"))}</div>
    <div class="ts-field"><label>${escapeHtml(t(host, "habitName", "Habit name"))}</label>
      <input class="b3-text-field fn__block" data-habit-name maxlength="60" placeholder="${escapeHtml(t(host, "habitNamePlaceholder", "e.g. Read for 20 minutes"))}" value="${escapeHtml(existing?.name || "")}"></div>
    <div class="ts-form-row">
      <div class="ts-field"><label>${escapeHtml(t(host, "habitFrequency", "Frequency"))}</label>
        <select class="b3-select fn__block" data-habit-frequency>
          <option value="daily"${frequency === "daily" ? " selected" : ""}>${escapeHtml(t(host, "habitFrequencyDaily", "Every day"))}</option>
          <option value="weekly"${frequency === "weekly" ? " selected" : ""}>${escapeHtml(t(host, "habitFrequencyWeekly", "Every week"))}</option>
          <option value="monthly"${frequency === "monthly" ? " selected" : ""}>${escapeHtml(t(host, "habitFrequencyMonthly", "Every month"))}</option>
          <option value="yearly"${frequency === "yearly" ? " selected" : ""}>${escapeHtml(t(host, "habitFrequencyYearly", "Every year"))}</option>
          <option value="ebbinghaus"${frequency === "ebbinghaus" ? " selected" : ""}>${escapeHtml(t(host, "habitFrequencyEbbinghaus", "Ebbinghaus"))}</option>
          <option value="none"${frequency === "none" ? " selected" : ""}>${escapeHtml(t(host, "habitFrequencyNone", "No fixed schedule"))}</option>
        </select></div>
      <div class="ts-field"><label>${escapeHtml(t(host, "habitTimeSlot", "Time of day"))}</label>
        <select class="b3-select fn__block" data-habit-slot>
          <option value="morning"${timeSlot === "morning" ? " selected" : ""}>${escapeHtml(t(host, "habitSlotMorning", "Morning"))}</option>
          <option value="afternoon"${timeSlot === "afternoon" ? " selected" : ""}>${escapeHtml(t(host, "habitSlotAfternoon", "Afternoon"))}</option>
          <option value="evening"${timeSlot === "evening" ? " selected" : ""}>${escapeHtml(t(host, "habitSlotEvening", "Evening"))}</option>
          <option value="anytime"${timeSlot === "anytime" ? " selected" : ""}>${escapeHtml(t(host, "habitSlotAnytime", "Any time"))}</option>
        </select></div>
    </div>
    <div class="ts-field ts-habit-interval"><label>${escapeHtml(t(host, "habitInterval", "Interval"))}</label>
      <div class="ts-habit-inline"><input class="b3-text-field" type="number" data-habit-interval min="1" max="365" step="1" value="${interval}"><span data-habit-interval-unit>${escapeHtml(t(host, "habitUnitDays", "day(s)"))}</span></div></div>
    <div class="ts-field ts-habit-days${isWeekly ? "" : " fn__none"}"><label>${escapeHtml(t(host, "habitWeekdays", "Weekdays"))}</label>
      <div class="ts-habit-days__row">${[0, 1, 2, 3, 4, 5, 6].map((day) => `<label class="ts-day"><input type="checkbox" data-weekday value="${day}"${selectedDays.has(day) ? " checked" : ""}><span>${escapeHtml(weekdayName(host, day))}</span></label>`).join("")}</div></div>
    <div class="ts-habit-schedule-hint fn__none" data-habit-schedule-hint></div>
    <div class="ts-field"><label>${escapeHtml(t(host, "habitReminderTime", "Reminder time (optional)"))}</label>
      <input class="b3-text-field fn__block" type="time" data-habit-reminder value="${escapeHtml(reminderTime)}"></div>
    ${editing ? `<div class="ts-field ts-habit-abandoned">
      <label class="ts-habit-auto__row"><input type="checkbox" data-habit-abandoned${abandoned ? " checked" : ""}><span>${escapeHtml(t(host, "habitAbandoned", "Abandoned habit"))}</span></label>
      <div class="ts-habit-schedule-hint">${escapeHtml(t(host, "habitAbandonedDesc", "It stays in history but is no longer scheduled."))}</div>
    </div>` : ""}
  </section>
  <section class="ts-form-section">
    <div class="ts-form-section__title">${escapeHtml(t(host, "habitSectionGoal", "Goal"))}</div>
    <div class="ts-field"><label>${escapeHtml(t(host, "habitGoal", "Check-in goal"))}</label>
      <select class="b3-select fn__block" data-habit-goal>
        <option value="count"${goal === "count" ? " selected" : ""}>${escapeHtml(t(host, "habitGoalCount", "By check-in count"))}</option>
        <option value="duration"${goal === "duration" ? " selected" : ""}>${escapeHtml(t(host, "habitGoalDuration", "By pomodoro time"))}</option>
        <option value="either"${goal === "either" ? " selected" : ""}>${escapeHtml(t(host, "habitGoalEither", "Check-in count or pomodoro time"))}</option>
      </select></div>
    <div class="ts-form-row">
      <div class="ts-field ts-habit-count${goal === "duration" ? " fn__none" : ""}"><label>${escapeHtml(t(host, "habitTargetCount", "Target count"))}</label>
        <div class="ts-habit-inline"><input class="b3-text-field" type="number" data-habit-target-count min="1" max="99" step="1" value="${targetCount}"><span>${escapeHtml(t(host, "habitTimesUnit", "time(s)"))}</span></div></div>
      <div class="ts-field ts-habit-duration${goal === "count" ? " fn__none" : ""}"><label>${escapeHtml(t(host, "habitTargetDuration", "Target duration"))}</label>
        <div class="ts-habit-inline"><input class="b3-text-field" type="number" data-habit-hours min="0" max="23" step="1" value="${targetHours}"><span>h</span><input class="b3-text-field" type="number" data-habit-minutes min="0" max="59" step="1" value="${targetMinutePart}"><span>m</span></div></div>
    </div>
    <div class="ts-habit-help" data-habit-help></div>
    <div class="ts-field ts-habit-auto${goal === "count" ? " fn__none" : ""}">
      <label class="ts-habit-auto__row"><input type="checkbox" data-habit-auto${autoCheckIn ? " checked" : ""}><span>${escapeHtml(t(host, "habitAutoCheckIn", "Check in automatically after a pomodoro"))}</span></label>
      <select class="b3-select fn__block ts-habit-auto__select" data-habit-auto-label>
        <option value="success"${autoLabel === "success" ? " selected" : ""}>${escapeHtml(t(host, "habitAutoLabelSuccess", "✅ Check-in successful!"))}</option>
        <option value="done"${autoLabel === "done" ? " selected" : ""}>${escapeHtml(t(host, "habitAutoLabelDone", "🎉 Goal reached!"))}</option>
      </select>
    </div>
  </section>
  <details class="ts-form-more">
    <summary>${escapeHtml(t(host, "habitMoreSettings", "More settings"))}</summary>
    <div class="ts-form-row">
      <div class="ts-field ts-habit-timer${goal === "count" ? " fn__none" : ""}"><label>${escapeHtml(t(host, "habitTimerMode", "Check-in button"))}</label>
        <select class="b3-select fn__block" data-habit-timer-mode>
          <option value="pomodoro"${timerMode === "pomodoro" ? " selected" : ""}>${escapeHtml(t(host, "habitTimerPomodoro", "🍅 Pomodoro"))}</option>
          <option value="stopwatch"${timerMode === "stopwatch" ? " selected" : ""}>${escapeHtml(t(host, "habitTimerStopwatch", "⏱ Stopwatch"))}</option>
        </select></div>
    </div>
    <div class="ts-form-row">
      <div class="ts-field"><label>${escapeHtml(t(host, "habitStartDate", "Start date"))}</label>
        <input class="b3-text-field fn__block" type="date" data-habit-start value="${escapeHtml(startDate)}"></div>
      <div class="ts-field"><label>${escapeHtml(t(host, "habitEndDate", "End date (optional)"))}</label>
        <input class="b3-text-field fn__block" type="date" data-habit-end value="${escapeHtml(endDate)}"></div>
    </div>
  </details>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-cancel>${escapeHtml(t(host, "cancel", "Cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-save>${escapeHtml(t(host, "save", "Save"))}</button>
</div>`,
            width: getFrontend().startsWith("mobile") ? "92vw" : "560px",
        });

        const nameInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-name]")!;
        const frequencySelect = dialog.element.querySelector<HTMLSelectElement>("[data-habit-frequency]")!;
        const daysField = dialog.element.querySelector<HTMLElement>(".ts-habit-days")!;
        const intervalField = dialog.element.querySelector<HTMLElement>(".ts-habit-interval")!;
        const intervalUnit = dialog.element.querySelector<HTMLElement>("[data-habit-interval-unit]")!;
        const scheduleHint = dialog.element.querySelector<HTMLElement>("[data-habit-schedule-hint]")!;
        const goalSelect = dialog.element.querySelector<HTMLSelectElement>("[data-habit-goal]")!;
        const slotSelect = dialog.element.querySelector<HTMLSelectElement>("[data-habit-slot]")!;
        const countField = dialog.element.querySelector<HTMLElement>(".ts-habit-count")!;
        const durationField = dialog.element.querySelector<HTMLElement>(".ts-habit-duration")!;
        const autoField = dialog.element.querySelector<HTMLElement>(".ts-habit-auto")!;
        const timerField = dialog.element.querySelector<HTMLElement>(".ts-habit-timer")!;
        const helpElement = dialog.element.querySelector<HTMLElement>("[data-habit-help]")!;
        const countInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-target-count]")!;
        const hoursInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-hours]")!;
        const minutesInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-minutes]")!;
        const autoInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-auto]")!;
        const autoLabelSelect = dialog.element.querySelector<HTMLSelectElement>("[data-habit-auto-label]")!;
        const timerModeSelect = dialog.element.querySelector<HTMLSelectElement>("[data-habit-timer-mode]")!;
        const intervalInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-interval]")!;
        const startInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-start]")!;
        const endInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-end]")!;
        const reminderInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-reminder]")!;
        const abandonedInput = dialog.element.querySelector<HTMLInputElement>("[data-habit-abandoned]");
        const saveButton = dialog.element.querySelector<HTMLButtonElement>("[data-save]")!;

        const updateFrequency = () => {
            const type = frequencySelect.value;
            const usesInterval = type === "daily" || type === "weekly" || type === "monthly" || type === "yearly";
            daysField.classList.toggle("fn__none", type !== "weekly");
            intervalField.classList.toggle("fn__none", !usesInterval);
            const units: Record<string, [string, string]> = {
                daily: ["habitUnitDays", "day(s)"],
                weekly: ["habitUnitWeeks", "week(s)"],
                monthly: ["habitUnitMonths", "month(s)"],
                yearly: ["habitUnitYears", "year(s)"],
            };
            if (usesInterval) {
                const [key, fallback] = units[type];
                intervalUnit.textContent = t(host, key, fallback);
            }
            const hints: Record<string, [string, string]> = {
                weekly: ["habitScheduleWeeklyHint", "Pick the weekdays; the interval counts weeks."],
                monthly: ["habitScheduleMonthlyHint", "Repeats on the start date's day each month; shorter months use the last day."],
                yearly: ["habitScheduleYearlyHint", "Repeats on the start date's month and day each year."],
                ebbinghaus: ["habitScheduleEbbinghausHint", "Reviews after 1, 2, 4, 7, 15 and 30 days."],
                none: ["habitScheduleNoneHint", "Not added to today's plan; check in manually whenever you like."],
            };
            const hint = hints[type];
            scheduleHint.textContent = hint ? t(host, hint[0], hint[1]) : "";
            scheduleHint.classList.toggle("fn__none", !hint);
        };
        frequencySelect.addEventListener("change", updateFrequency);
        updateFrequency();

        const updateGoal = () => {
            const value = goalSelect.value as HabitGoal;
            countField.classList.toggle("fn__none", value === "duration");
            durationField.classList.toggle("fn__none", value === "count");
            autoField.classList.toggle("fn__none", value === "count");
            timerField.classList.toggle("fn__none", value === "count");
            const [key, fallback] = value === "duration"
                ? ["habitGoalHelpDuration", "Reach the target duration to complete the day."]
                : value === "either"
                    ? ["habitGoalHelpEither", "Either the check-in count or the target duration completes the day."]
                    : ["habitGoalHelpCount", "Reach the target check-in count to complete the day."];
            helpElement.textContent = t(host, key, fallback);
        };
        const updateAutoLabel = () => {
            autoLabelSelect.classList.toggle("fn__none", !autoInput.checked);
        };
        autoInput.addEventListener("change", updateAutoLabel);
        goalSelect.addEventListener("change", () => {
            updateGoal();
            updateAutoLabel();
        });
        updateGoal();
        updateAutoLabel();

        const submit = async () => {
            const name = nameInput.value.trim();
            if (!name) {
                showMessage(t(host, "habitNameRequired", "Please enter a habit name."), 4000, "error");
                nameInput.focus();
                return;
            }
            const days = [...dialog.element.querySelectorAll<HTMLInputElement>("[data-weekday]:checked")]
                .map((input) => Number(input.value));
            if (frequencySelect.value === "weekly" && days.length === 0) {
                showMessage(t(host, "habitDaysRequired", "Choose at least one weekday."), 4000, "error");
                return;
            }
            const goalValue = goalSelect.value as HabitGoal;
            const targetCountRaw = Number(countInput.value);
            const targetCountValid = Number.isInteger(targetCountRaw) && targetCountRaw >= 1 && targetCountRaw <= 99;
            if (goalValue !== "duration" && !targetCountValid) {
                showMessage(t(host, "habitCountInvalid", "Target count must be between 1 and 99."), 4000, "error");
                countInput.focus();
                return;
            }
            const targetMinutesRaw = Number(hoursInput.value) * 60 + Number(minutesInput.value);
            const targetMinutesValid = Number.isInteger(targetMinutesRaw) && targetMinutesRaw >= 1 && targetMinutesRaw <= 1440;
            if (goalValue !== "count" && !targetMinutesValid) {
                showMessage(t(host, "habitDurationInvalid", "Please set a target duration between 1 minute and 24 hours."), 4000, "error");
                return;
            }
            const targetCountValue = targetCountValid ? targetCountRaw : 1;
            const targetMinutesValue = targetMinutesValid ? targetMinutesRaw : DEFAULT_TARGET_MINUTES;
            const usesInterval = ["daily", "weekly", "monthly", "yearly"].includes(frequencySelect.value);
            const interval = usesInterval ? Number(intervalInput.value) : 1;
            if (usesInterval && (!Number.isInteger(interval) || interval < 1 || interval > 365)) {
                showMessage(t(host, "habitIntervalInvalid", "Interval must be between 1 and 365 days."), 4000, "error");
                intervalInput.focus();
                return;
            }
            const start = startInput.value || dateKey();
            const end = endInput.value;
            if (end && end < start) {
                showMessage(t(host, "habitDateInvalid", "The end date must be on or after the start date."), 4000, "error");
                return;
            }
            const startParts = start.split("-").map(Number);
            const startDay = startParts[2] || 1;
            const startMonth = startParts[1] || 1;
            let nextSchedule: HabitSchedule;
            if (frequencySelect.value === "weekly") {
                nextSchedule = {type: "weekly", days: days.sort((a, b) => a - b)};
            } else if (frequencySelect.value === "monthly") {
                nextSchedule = {type: "monthly", day: startDay};
            } else if (frequencySelect.value === "yearly") {
                nextSchedule = {type: "yearly", month: startMonth, day: startDay};
            } else if (frequencySelect.value === "ebbinghaus") {
                nextSchedule = {type: "ebbinghaus"};
            } else if (frequencySelect.value === "none") {
                nextSchedule = {type: "none"};
            } else {
                nextSchedule = {type: "daily"};
            }
            const nextHabit: Habit = existing
                ? {
                    ...existing,
                    name,
                    schedule: nextSchedule,
                    timeSlot: slotSelect.value as HabitTimeSlot,
                    goal: goalValue,
                    targetCount: targetCountValue,
                    targetMinutes: targetMinutesValue,
                    autoCheckIn: autoInput.checked,
                    autoCheckInLabel: autoLabelSelect.value as HabitAutoLabel,
                    timerMode: timerModeSelect.value as HabitTimerMode,
                    interval,
                    created: start,
                    endDate: end || undefined,
                    abandoned: abandonedInput?.checked === true,
                    reminderTime: reminderInput.value || undefined,
                }
                : {
                    ...createHabit(name, nextSchedule, start),
                    timeSlot: slotSelect.value as HabitTimeSlot,
                    goal: goalValue,
                    targetCount: targetCountValue,
                    targetMinutes: targetMinutesValue,
                    autoCheckIn: autoInput.checked,
                    autoCheckInLabel: autoLabelSelect.value as HabitAutoLabel,
                    timerMode: timerModeSelect.value as HabitTimerMode,
                    interval,
                    endDate: end || undefined,
                    abandoned: abandonedInput?.checked === true,
                    reminderTime: reminderInput.value || undefined,
                };
            const next = existing
                ? habits.map((habit) => habit.id === existing.id ? nextHabit : habit)
                : [...habits, nextHabit];
            saveButton.disabled = true;
            try {
                await save(next);
                dialog.destroy();
            } catch (error) {
                showMessage(t(host, "habitSaveFailed", "Failed to save habit: ${msg}", {msg: errorMessage(error)}), 6000, "error");
            } finally {
                saveButton.disabled = false;
            }
        };

        dialog.element.querySelector("[data-save]")?.addEventListener("click", () => void submit());
        dialog.element.querySelector("[data-cancel]")?.addEventListener("click", () => dialog.destroy());
        nameInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                void submit();
            }
        });
        nameInput.focus();
    };

    const remove = async (habit: Habit) => {
        const confirmed = await confirmDialog({
            title: t(host, "habitDeleteTitle", "Delete habit"),
            message: t(host, "habitDeleteConfirm", "Delete \"${name}\"? Its check-in history will be lost.", {name: habit.name}),
            confirmLabel: t(host, "habitDelete", "Delete"),
            cancelLabel: t(host, "cancel", "Cancel"),
            danger: true,
        });
        if (!confirmed) {
            return;
        }
        try {
            await save(habits.filter((item) => item.id !== habit.id));
        } catch (error) {
            showMessage(t(host, "habitSaveFailed", "Failed to save habit: ${msg}", {msg: errorMessage(error)}), 6000, "error");
        }
    };

    const updateTimerDisplay = (habitId: string, text: string) => {
        const timer = container.querySelector<HTMLElement>(`.ts-habit[data-habit-id="${habitId}"] .ts-habit__timer`);
        if (timer) {
            timer.textContent = text;
        }
    };

    const persistTimerResult = async (habit: Habit, minutes: number, autoCheckIn: boolean) => {
        const today = dateKey();
        let updated = addFocusMinutes(habit, today, minutes);
        if (autoCheckIn) {
            updated = addCheckIn(updated, today, 1);
        }
        await save(habits.map((item) => item.id === habit.id ? updated : item));
    };

    const toggleTimer = (habit: Habit) => {
        const today = dateKey();
        const state = timers.get(habit.id);
        if (state) {
            if (habit.timerMode === "stopwatch") {
                const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
                const minutes = Math.max(1, Math.round(elapsed / 60));
                window.clearInterval(state.handle);
                timers.delete(habit.id);
                void persistTimerResult(habit, minutes, false)
                    .then(() => showMessage(t(host, "habitStopwatchDone", "Recorded ${minutes} minutes.", {minutes}), 3000))
                    .catch((error) => {
                        showMessage(t(host, "habitSaveFailed", "Failed to save habit: ${msg}", {msg: errorMessage(error)}), 6000, "error");
                    });
                return;
            }
            clearTimer(habit.id);
            render();
            return;
        }
        if (!isScheduled(habit, today)) {
            return;
        }
        const startedAt = Date.now();
        if (habit.timerMode === "pomodoro") {
            const minutes = Math.max(1, habit.targetMinutes);
            const endsAt = startedAt + minutes * 60000;
            const handle = window.setInterval(() => {
                const current = timers.get(habit.id);
                if (!current?.endsAt) {
                    return;
                }
                const remaining = Math.ceil((current.endsAt - Date.now()) / 1000);
                if (remaining > 0) {
                    updateTimerDisplay(habit.id, formatClock(remaining));
                    return;
                }
                window.clearInterval(current.handle);
                timers.delete(habit.id);
                void persistTimerResult(habit, minutes, habit.autoCheckIn)
                    .then(() => {
                        const label = habit.autoCheckIn
                            ? t(host, habit.autoCheckInLabel === "done" ? "habitAutoLabelDone" : "habitAutoLabelSuccess",
                                habit.autoCheckInLabel === "done" ? "🎉 Goal reached!" : "✅ Check-in successful!")
                            : t(host, "habitPomodoroDone", "Pomodoro complete: ${minutes} minutes recorded.", {minutes});
                        showMessage(label, 3000);
                    })
                    .catch((error) => {
                        showMessage(t(host, "habitSaveFailed", "Failed to save habit: ${msg}", {msg: errorMessage(error)}), 6000, "error");
                    });
            }, 1000);
            timers.set(habit.id, {startedAt, endsAt, handle});
        } else {
            const handle = window.setInterval(() => {
                const current = timers.get(habit.id);
                if (!current) {
                    return;
                }
                updateTimerDisplay(habit.id, formatClock(Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000))));
            }, 1000);
            timers.set(habit.id, {startedAt, handle});
        }
        render();
    };

    const onClick = (event: Event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-habit-action]");
        if (!target) {
            return;
        }
        const action = target.dataset.habitAction;
        if (action === "create") {
            openEditor();
            return;
        }
        const row = target.closest<HTMLElement>("[data-habit-id]");
        const habit = row ? habits.find((item) => item.id === row.dataset.habitId) : undefined;
        if (!habit) {
            return;
        }
        if (action === "edit") {
            openEditor(habit);
            return;
        }
        if (action === "delete") {
            void remove(habit);
            return;
        }
        if (action === "decrement") {
            const next = habits.map((item) => item.id === habit.id ? decrementHabit(item) : item);
            void save(next).catch((error) => {
                showMessage(t(host, "habitSaveFailed", "Failed to save habit: ${msg}", {msg: errorMessage(error)}), 6000, "error");
            });
            return;
        }
        if (action === "toggle") {
            const next = habits.map((item) => item.id === habit.id ? toggleHabit(item) : item);
            void save(next).catch((error) => {
                showMessage(t(host, "habitSaveFailed", "Failed to save habit: ${msg}", {msg: errorMessage(error)}), 6000, "error");
            });
            return;
        }
        if (action === "pomodoro") {
            host.startHabitPomodoro?.(habit);
            return;
        }
        if (action === "timer") {
            toggleTimer(habit);
            return;
        }
    };

    const onPomodoroState = (event: Event) => {
        pomodoroState = (event as CustomEvent<PomodoroState | null>).detail;
        render();
    };

    const onPomodoroTick = (event: Event) => {
        const state = (event as CustomEvent<PomodoroState>).detail;
        pomodoroState = state;
        if (state.target.kind !== "habit") {
            return;
        }
        const row = container.querySelector<HTMLElement>(`.ts-habit[data-habit-id="${state.target.id}"]`);
        const timer = row?.querySelector<HTMLElement>(".ts-habit__timer");
        if (timer) {
            timer.textContent = formatClock(state.remainingSeconds);
        } else {
            render();
        }
    };

    let contextMenu: HTMLElement | undefined;

    const closeContextMenu = () => {
        if (!contextMenu) {
            return;
        }
        contextMenu.remove();
        contextMenu = undefined;
        document.removeEventListener("mousedown", onContextMenuOutside, true);
        document.removeEventListener("keydown", onContextMenuKey, true);
        window.removeEventListener("scroll", closeContextMenu, true);
        window.removeEventListener("resize", closeContextMenu);
    };

    const onContextMenuOutside = (event: MouseEvent) => {
        if (contextMenu && !contextMenu.contains(event.target as Node)) {
            closeContextMenu();
        }
    };

    const onContextMenuKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            closeContextMenu();
        }
    };

    const onContextMenu = (event: MouseEvent) => {
        if (!host.insertHabitEmbed) {
            return;
        }
        event.preventDefault();
        closeContextMenu();
        const menu = document.createElement("div");
        menu.className = "ts-context-menu";
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "ts-context-menu__item";
        item.textContent = t(host, "habitInsertBlock", "Insert as embed block");
        item.addEventListener("click", () => {
            closeContextMenu();
            host.insertHabitEmbed?.();
        });
        menu.append(item);
        document.body.append(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
        menu.style.zIndex = String((window as any).siyuan?.zIndex ? ++(window as any).siyuan.zIndex : 9999);
        contextMenu = menu;
        window.setTimeout(() => {
            if (!contextMenu) {
                return;
            }
            document.addEventListener("mousedown", onContextMenuOutside, true);
            document.addEventListener("keydown", onContextMenuKey, true);
            window.addEventListener("scroll", closeContextMenu, true);
            window.addEventListener("resize", closeContextMenu);
        }, 0);
    };

    container.addEventListener("click", onClick);
    container.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("task-secretary-pomodoro-state", onPomodoroState);
    window.addEventListener("task-secretary-pomodoro-tick", onPomodoroTick);

    const refresh = async () => {
        try {
            habits = sortHabits(await host.getHabits());
            render();
        } catch (error) {
            if (!destroyed) {
                container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "habitLoadFailed", "Failed to load habits: ${msg}", {msg: errorMessage(error)}))}</div>`;
            }
        }
    };

    const onExternalChange = () => {
        void refresh();
    };
    window.addEventListener("task-secretary-habits-changed", onExternalChange);

    if (habits.length === 0) {
        container.innerHTML = `<div class="ts-empty">${escapeHtml(t(host, "loading", "Loading…"))}</div>`;
        void refresh();
    }

    return {
        refresh,
        destroy: () => {
            destroyed = true;
            container.removeEventListener("click", onClick);
            container.removeEventListener("contextmenu", onContextMenu);
            closeContextMenu();
            window.removeEventListener("task-secretary-pomodoro-state", onPomodoroState);
            window.removeEventListener("task-secretary-pomodoro-tick", onPomodoroTick);
            window.removeEventListener("task-secretary-habits-changed", onExternalChange);
            timers.forEach((state) => window.clearInterval(state.handle));
            timers.clear();
            container.innerHTML = "";
        },
    };
};
