import {fetchSyncPost} from "siyuan";
import type {Task} from "./types";
import {habitDone, type Habit} from "./habit-store";

export interface AiBlock {
    time?: string;
    period?: string;
    title: string;
    kind?: string;
    reason?: string;
}

export interface AiPlan {
    date: string;
    generatedAt: string;
    summary: string;
    blocks: AiBlock[];
    /** Present when the model returned prose instead of the requested JSON. */
    raw?: string;
}

export type AiLanguage = "zh" | "en";

const MAX_TASKS = 50;
const MAX_HABITS = 30;
const MAX_BLOCKS = 30;

const stripFence = (value: string): string => value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

const scheduleText = (habit: Habit): string => {
    const interval = Math.max(1, Math.round(habit.interval || 1));
    switch (habit.schedule.type) {
        case "weekly":
            return `weekly:${habit.schedule.days.join(",")}:${interval}`;
        case "monthly":
            return `monthly:${habit.schedule.day}:${interval}`;
        case "yearly":
            return `yearly:${habit.schedule.month}-${habit.schedule.day}:${interval}`;
        case "ebbinghaus":
            return "ebbinghaus";
        case "none":
            return "none";
        default:
            return interval > 1 ? `daily:${interval}` : "daily";
    }
};

const buildContext = (date: string, tasks: Task[], habits: Habit[]) => {
    const now = new Date();
    return {
        date,
        now: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} `
            + `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
        tasks: tasks.slice(0, MAX_TASKS).map((task) => ({
            title: task.title,
            dueDate: task.dueDate || "",
            dueTime: task.dueTime || "",
            priority: task.priority,
            overdue: task.overdue,
            path: task.hpath,
        })),
        habits: habits.slice(0, MAX_HABITS).map((habit) => ({
            name: habit.name,
            schedule: scheduleText(habit),
            timeSlot: habit.timeSlot,
            reminderTime: habit.reminderTime || "",
            goal: habit.goal,
            targetCount: habit.targetCount,
            targetMinutes: habit.targetMinutes,
            doneOnDate: habitDone(habit, date),
        })),
    };
};

const buildPrompt = (date: string, tasks: Task[], habits: Habit[], language: AiLanguage): string => {
    const replyLanguage = language === "zh" ? "Chinese" : "English";
    return [
        "This is a standalone day-planning request. Ignore any earlier conversation context.",
        "You are a practical day planner inside a note-taking app.",
        "Use only the tasks and habits in the planning context below. Do not invent tasks or habits.",
        "Honor fixed due times and habit reminder times. Prefer overdue and high-value work earlier.",
        "Leave realistic gaps and short breaks; do not overpack the day.",
        "If the requested date has very little work, say so and keep the plan light.",
        `Write the summary and reasons in ${replyLanguage}.`,
        "Return JSON only, with this shape:",
        "{\"summary\":\"one short paragraph\",\"blocks\":[{\"time\":\"09:00-09:30\",\"period\":\"morning|afternoon|evening|anytime\",\"title\":\"task or habit name\",\"kind\":\"task|habit|break\",\"reason\":\"short reason\"}]}",
        "Planning context:",
        JSON.stringify(buildContext(date, tasks, habits)),
    ].join("\n");
};

const normalizeBlocks = (raw: any): AiBlock[] => {
    if (!Array.isArray(raw)) {
        return [];
    }
    const blocks: AiBlock[] = [];
    raw.slice(0, MAX_BLOCKS).forEach((item: any) => {
        if (!item || typeof item !== "object") {
            return;
        }
        const title = String(item.title ?? "").trim();
        if (!title) {
            return;
        }
        const block: AiBlock = {title};
        const time = String(item.time ?? "").trim();
        const period = String(item.period ?? "").trim().toLowerCase();
        const kind = String(item.kind ?? "").trim().toLowerCase();
        const reason = String(item.reason ?? "").trim();
        if (time) {
            block.time = time;
        }
        if (["morning", "afternoon", "evening", "anytime"].includes(period)) {
            block.period = period;
        }
        if (["task", "habit", "break"].includes(kind)) {
            block.kind = kind;
        }
        if (reason) {
            block.reason = reason;
        }
        blocks.push(block);
    });
    return blocks;
};

/** Uses SiYuan's built-in AI editing model through /api/ai/chatGPT. */
export const generateAiPlan = async (
    date: string,
    tasks: Task[],
    habits: Habit[],
    language: AiLanguage,
): Promise<AiPlan> => {
    const response = await fetchSyncPost("/api/ai/chatGPT", {
        msg: buildPrompt(date, tasks, habits, language),
    });
    if (response.code !== 0) {
        throw new Error(response.msg || `SiYuan AI failed: ${response.code}`);
    }
    const content = typeof response.data === "string" ? response.data : "";
    if (!content.trim()) {
        throw new Error("SIYUAN_AI_EMPTY");
    }
    const cleaned = stripFence(content);
    let summary = "";
    let blocks: AiBlock[] = [];
    try {
        const parsed = JSON.parse(cleaned);
        summary = String(parsed?.summary ?? "").trim();
        blocks = normalizeBlocks(parsed?.blocks);
    } catch {
        summary = cleaned;
    }
    return {
        date,
        generatedAt: new Date().toISOString(),
        summary: summary || cleaned,
        blocks,
        raw: blocks.length === 0 ? cleaned : undefined,
    };
};
