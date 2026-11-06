import {fetchSyncPost} from "siyuan";
import type {GtdQuadrant, Priority, RawTaskRow, Task, TaskBlockType, TaskGroupKey, TaskMarker, TaskType} from "./types";
import {parseNaturalTime} from "./natural-time";

export const DUE_ATTR = "custom-task-due";
/** Legacy attribute name; the UI now presents it as value for effort. */
export const PRIORITY_ATTR = "custom-task-priority";
export const REMINDER_ATTR = "custom-task-reminder";
export const TYPE_ATTR = "custom-task-type";
export const CLARIFIED_ATTR = "custom-gtd-clarified";
export const QUADRANT_ATTR = "custom-gtd-quadrant";
export const NEXT_ACTION_ATTR = "custom-gtd-next-action";
export const ARCHIVED_ATTR = "custom-gtd-archived";
export const DONE_ATTR = "custom-gtd-done";
export const PLAN_DATE_ATTR = "custom-gtd-plan-date";
export const PLAN_START_ATTR = "custom-gtd-plan-start";
export const PLAN_END_ATTR = "custom-gtd-plan-end";
export const COLD_ATTR = "custom-gtd-cold";

const DATE_RE = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/;
const DUE_TOKEN = /(?:@|📅)\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/;
const DUE_TOKEN_G = /(?:@|📅)\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2})?/g;
const PRIORITY_TOKEN = /(?:!|！)(高|中|低|[123])/;
const PRIORITY_TOKEN_G = /(?:!|！)(高|中|低|[123])/g;
const GTD_TOKEN_G = /\s*@(?:GTD|知识|阅读|以后)(?=\s|$|[，。；、,.!?])/gi;
const TASK_ID_RE = /^\d{14}-[a-z0-9]{7}$/;
const PLAN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (value: number) => String(value).padStart(2, "0");

export const dateKey = (date: Date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const firstLine = (markdown: string): string => String(markdown || "").split("\n")[0] || "";

const stripListPrefix = (text: string): string =>
    text.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");

export const stripGtdToken = (text: string): string =>
    String(text || "").replace(GTD_TOKEN_G, " ").replace(/\s{2,}/g, " ").trim();

const attrOn = (value: string | null | undefined): boolean => {
    const text = String(value ?? "").trim().toLowerCase();
    return Boolean(text) && text !== "0" && text !== "false";
};

export const normalizePriority = (value: unknown): Priority => {
    const text = String(value ?? "").trim().toLowerCase();
    if (["1", "high", "高", "p1", "urgent"].includes(text)) {
        return 1;
    }
    if (["3", "low", "低", "p3"].includes(text)) {
        return 3;
    }
    return 2;
};

export const normalizeTaskType = (value: unknown): TaskType => {
    const text = String(value ?? "").trim().toLowerCase();
    if (["routine", "日常", "习惯"].includes(text)) {
        return "routine";
    }
    if (["event", "日程"].includes(text)) {
        return "event";
    }
    return "task";
};

const parseQuadrant = (value: string | null | undefined): GtdQuadrant | undefined => {
    const text = String(value ?? "").trim().toLowerCase();
    return text === "q1" || text === "q2" || text === "q3" || text === "q4" ? text : undefined;
};

export const parseDue = (value: string | null | undefined): {dueDate?: string; dueTime?: string} => {
    if (!value) {
        return {};
    }
    const match = String(value).match(DATE_RE);
    if (!match) {
        return {};
    }
    return {
        dueDate: `${match[1]}-${pad(Number(match[2]))}-${pad(Number(match[3]))}`,
        dueTime: match[4] ? `${pad(Number(match[4]))}:${match[5]}` : undefined,
    };
};

export const REMINDER_GLOBAL = -2;

/** -2 = explicitly use global, -1 = at due time, undefined = not set, 0 = no reminder, positive = minutes before due. */
export const parseReminder = (value: string | null | undefined): number | undefined => {
    if (value === null || value === undefined) {
        return undefined;
    }
    const text = String(value).trim();
    if (!text) {
        return undefined;
    }
    if (text.toLowerCase() === "global") {
        return REMINDER_GLOBAL;
    }
    if (text.toLowerCase() === "at") {
        return -1;
    }
    const minutes = Number(text);
    if (!Number.isFinite(minutes)) {
        return undefined;
    }
    if (minutes === -1) {
        return -1;
    }
    if (minutes < 0) {
        return undefined;
    }
    return Math.min(10080, Math.round(minutes));
};

const classify = (dueDate: string | undefined, dueTime: string | undefined, now: Date): TaskGroupKey => {
    if (!dueDate) {
        return "none";
    }
    const due = new Date(`${dueDate}T${dueTime || "23:59"}:59`);
    if (due.getTime() < now.getTime()) {
        return "overdue";
    }
    const today = startOfDay(now);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const dueDay = new Date(`${dueDate}T00:00:00`);
    if (dueDay.getTime() === today.getTime()) {
        return "today";
    }
    if (dueDay.getTime() === tomorrow.getTime()) {
        return "tomorrow";
    }
    if (dueDay.getTime() < weekEnd.getTime()) {
        return "week";
    }
    return "later";
};

export const taskTextFromBlock = (markdown: string): string => {
    const line = firstLine(markdown);
    const withoutMarker = line.replace(/^\s*(?:[-*+]|\d+\.)\s+\[[^\]]\]\s?/, "");
    return stripGtdToken(
        stripListPrefix(withoutMarker)
            .replace(DUE_TOKEN_G, "")
            .replace(PRIORITY_TOKEN_G, "")
            .replace(/\u200b/g, "")
            .replace(/\s{2,}/g, " "),
    ) || "(untitled)";
};

const toTask = (row: RawTaskRow, now: Date): Task | undefined => {
    const markerMatch = row.markdown.match(/^\s*(?:[-*+]|\d+\.)\s+\[([^\]])\]\s?/);
    const clarified = attrOn(row.clarifiedAttr);
    const archived = attrOn(row.archivedAttr);
    const done = attrOn(row.doneAttr);
    const blockType: TaskBlockType = row.blockType === "p" ? "paragraph" : "task";

    if (clarified) {
        if (archived || done) {
            return undefined;
        }
        if (markerMatch && (markerMatch[1] === "X" || markerMatch[1] === "-")) {
            return undefined;
        }
    } else {
        if (!markerMatch || (markerMatch[1] !== " " && markerMatch[1] !== "/")) {
            return undefined;
        }
    }

    const marker = (markerMatch?.[1] as TaskMarker | undefined) ?? " ";
    const rawText = stripGtdToken(
        (row.titleContent || stripListPrefix(firstLine(row.markdown)))
            .replace(/^\s*(?:[-*+]|\d+\.)\s+\[[^\]]\]\s?/, "")
            .replace(/\u200b/g, "")
            .trim(),
    );
    const inlineDue = rawText.match(DUE_TOKEN);
    const inlinePriority = rawText.match(PRIORITY_TOKEN);
    const attrDue = parseDue(row.dueAttr);
    const inlineDueParsed = inlineDue ? {
        dueDate: `${inlineDue[1]}-${pad(Number(inlineDue[2]))}-${pad(Number(inlineDue[3]))}`,
        dueTime: inlineDue[4] ? `${pad(Number(inlineDue[4]))}:${inlineDue[5]}` : undefined,
    } : {};

    const natural = parseNaturalTime(rawText.replace(DUE_TOKEN_G, " ").replace(PRIORITY_TOKEN_G, " "), now);
    const explicitDate = attrDue.dueDate || inlineDueParsed.dueDate;
    const dueDate = explicitDate || natural?.dueDate;
    const dueTime = attrDue.dueDate
        ? (attrDue.dueTime || natural?.dueTime)
        : (inlineDueParsed.dueTime || natural?.dueTime);
    const priority = normalizePriority(row.priorityAttr || inlinePriority?.[1]);
    const type = normalizeTaskType(row.typeAttr);
    const title = rawText
        .replace(DUE_TOKEN_G, "")
        .replace(PRIORITY_TOKEN_G, "")
        .replace(/\s{2,}/g, " ")
        .trim() || "(untitled)";
    const group = classify(dueDate, dueTime, now);
    const parsedReminder = parseReminder(row.reminderAttr);
    const hasExplicitReminder = parsedReminder !== undefined;
    const reminderMinutes = parsedReminder === REMINDER_GLOBAL
        ? undefined
        : parsedReminder !== undefined
            ? parsedReminder
            : (natural ? -1 : undefined);
    const parentLine = String(row.parentMarkdown || "").split("\n")[0];
    const parentMatch = parentLine.match(/^\s*(?:[-*+]|\d+\.)\s+\[[^\]]\]\s?(.*)$/);
    const parentTitle = stripGtdToken(
        (row.parentTitleContent || parentMatch?.[1] || "")
            .replace(DUE_TOKEN_G, "")
            .replace(PRIORITY_TOKEN_G, "")
            .replace(/\u200b/g, "")
            .replace(/\s{2,}/g, " ")
            .trim(),
    );
    const planDate = PLAN_DATE_RE.test(String(row.planDateAttr ?? "")) ? String(row.planDateAttr) : undefined;
    const planStart = PLAN_TIME_RE.test(String(row.planStartAttr ?? "")) ? String(row.planStartAttr) : undefined;
    const planEnd = PLAN_TIME_RE.test(String(row.planEndAttr ?? "")) ? String(row.planEndAttr) : undefined;
    const nextActionOverride = stripGtdToken(String(row.nextActionAttr ?? ""));
    const createdAt = String(row.created ?? "").trim();

    return {
        id: row.id,
        rootID: row.root_id,
        hpath: row.hpath || "/",
        marker,
        markdown: row.markdown,
        title,
        type,
        dueDate,
        dueTime,
        dueSet: Boolean(explicitDate || natural?.dueDate),
        priority,
        prioritySet: Boolean(String(row.priorityAttr ?? "").trim()) || Boolean(inlinePriority?.[1]),
        reminderMinutes,
        reminderSet: hasExplicitReminder || Boolean(natural),
        parentID: parentTitle ? (row.parentID || undefined) : undefined,
        parentTitle: parentTitle || undefined,
        group,
        overdue: group === "overdue",
        clarified,
        quadrant: parseQuadrant(row.quadrantAttr),
        archived,
        blockType,
        nextAction: nextActionOverride || undefined,
        stepCount: 0,
        createdAt: createdAt || undefined,
        planDate,
        planStart,
        planEnd,
        cold: attrOn(row.coldAttr),
    };
};

const BASE_SELECT = `SELECT b.id, b.root_id, b.hpath, b.content, b.markdown, b.updated,
       b.type AS blockType, b.created,
       ad.value AS dueAttr, ap.value AS priorityAttr, ar.value AS reminderAttr, at.value AS typeAttr,
       ac.value AS clarifiedAttr, aq.value AS quadrantAttr, aa.value AS archivedAttr,
       adone.value AS doneAttr, an.value AS nextActionAttr,
       apd.value AS planDateAttr, aps.value AS planStartAttr, ape.value AS planEndAttr,
       acold.value AS coldAttr,
       (SELECT content FROM blocks WHERE parent_id = b.id AND type = 'p' ORDER BY id ASC LIMIT 1) AS titleContent,
       pi.id AS parentID, pi.markdown AS parentMarkdown,
       (SELECT content FROM blocks WHERE parent_id = pi.id AND type = 'p' ORDER BY id ASC LIMIT 1) AS parentTitleContent
FROM blocks b
LEFT JOIN attributes ad ON ad.block_id = b.id AND ad.name = '${DUE_ATTR}'
LEFT JOIN attributes ap ON ap.block_id = b.id AND ap.name = '${PRIORITY_ATTR}'
LEFT JOIN attributes ar ON ar.block_id = b.id AND ar.name = '${REMINDER_ATTR}'
LEFT JOIN attributes at ON at.block_id = b.id AND at.name = '${TYPE_ATTR}'
LEFT JOIN attributes ac ON ac.block_id = b.id AND ac.name = '${CLARIFIED_ATTR}'
LEFT JOIN attributes aq ON aq.block_id = b.id AND aq.name = '${QUADRANT_ATTR}'
LEFT JOIN attributes aa ON aa.block_id = b.id AND aa.name = '${ARCHIVED_ATTR}'
LEFT JOIN attributes adone ON adone.block_id = b.id AND adone.name = '${DONE_ATTR}'
LEFT JOIN attributes an ON an.block_id = b.id AND an.name = '${NEXT_ACTION_ATTR}'
LEFT JOIN attributes apd ON apd.block_id = b.id AND apd.name = '${PLAN_DATE_ATTR}'
LEFT JOIN attributes aps ON aps.block_id = b.id AND aps.name = '${PLAN_START_ATTR}'
LEFT JOIN attributes ape ON ape.block_id = b.id AND ape.name = '${PLAN_END_ATTR}'
LEFT JOIN attributes acold ON acold.block_id = b.id AND acold.name = '${COLD_ATTR}'
LEFT JOIN blocks pl ON pl.id = b.parent_id AND pl.type = 'l'
LEFT JOIN blocks pi ON pi.id = pl.parent_id AND pi.type = 'i' AND pi.subtype = 't'
WHERE (
  (b.type = 'i' AND b.subtype = 't')
  OR (b.type IN ('i', 'p') AND ac.value IS NOT NULL AND ac.value <> '')
)`;

const query = async (stmt: string): Promise<Task[]> => {
    const response = await fetchSyncPost("/api/query/sql", {stmt});
    if (response.code !== 0) {
        throw new Error(response.msg || `SQL error: ${response.code}`);
    }
    const now = new Date();
    const tasks = ((response.data || []) as unknown as RawTaskRow[])
        .map((row) => toTask(row, now))
        .filter((task): task is Task => Boolean(task));

    const childrenByParent = new Map<string, Task[]>();
    tasks.forEach((task) => {
        if (!task.parentID) {
            return;
        }
        const list = childrenByParent.get(task.parentID) ?? [];
        list.push(task);
        childrenByParent.set(task.parentID, list);
    });
    tasks.forEach((task) => {
        const children = (childrenByParent.get(task.id) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
        if (children.length) {
            task.stepCount = children.length;
            task.nextAction = children[0].title;
            task.nextActionID = children[0].id;
        } else {
            task.stepCount = 0;
            task.nextAction = task.nextAction || task.title;
        }
    });
    return tasks;
};

export const fetchTasks = async (): Promise<Task[]> =>
    query(`${BASE_SELECT} ORDER BY b.updated DESC LIMIT 2000`);

export const fetchExecutionTasks = async (): Promise<Task[]> =>
    (await fetchTasks()).filter((task) => task.clarified && !task.archived && task.type === "task");

export const fetchTaskByID = async (id: string): Promise<Task | undefined> => {
    if (!TASK_ID_RE.test(id)) {
        return undefined;
    }
    const tasks = await query(`${BASE_SELECT} AND b.id = '${id}' LIMIT 1`);
    return tasks[0];
};

const flushIndex = async (): Promise<void> => {
    await fetchSyncPost("/api/sqlite/flushTransaction", {});
};

const setBlockAttrs = async (id: string, attrs: Record<string, string>): Promise<void> => {
    const response = await fetchSyncPost("/api/attr/setBlockAttrs", {id, attrs});
    if (response.code !== 0) {
        throw new Error(response.msg || `setBlockAttrs failed: ${response.code}`);
    }
};

interface ChildRow {
    id: string;
    markdown: string;
    type: string;
}

const fetchChildRows = async (parentID: string): Promise<ChildRow[]> => {
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT c.id, c.markdown, c.type
FROM blocks c
LEFT JOIN blocks l ON l.id = c.parent_id AND l.type = 'l'
WHERE (l.parent_id = '${parentID}' OR c.parent_id = '${parentID}')
  AND c.type = 'i' AND c.subtype = 't'
ORDER BY c.id ASC`,
    });
    if (response.code !== 0) {
        throw new Error(response.msg || `query failed: ${response.code}`);
    }
    return (response.data || []) as unknown as ChildRow[];
};

const childMarker = (markdown: string): string | undefined => {
    const match = String(markdown || "").match(/^\s*(?:[-*+]|\d+\.)\s+\[([^\]])\]/);
    return match?.[1];
};

const isUnfinishedChild = (row: ChildRow): boolean => {
    const marker = childMarker(row.markdown);
    return marker === " " || marker === "/";
};

const childTitle = (row: ChildRow): string => taskTextFromBlock(row.markdown);

const fetchCustomAttrs = async (id: string): Promise<Record<string, string>> => {
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT name, value FROM attributes WHERE block_id = '${id}' AND name LIKE 'custom-%'`,
    });
    if (response.code !== 0) {
        return {};
    }
    const attrs: Record<string, string> = {};
    ((response.data || []) as unknown as Array<{name: string; value: string}>).forEach((row) => {
        if (row.name) {
            attrs[row.name] = row.value ?? "";
        }
    });
    return attrs;
};

const fetchBlockMarkdown = async (id: string): Promise<string | undefined> => {
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT markdown FROM blocks WHERE id = '${id}' LIMIT 1`,
    });
    if (response.code !== 0) {
        return undefined;
    }
    return (response.data as unknown as Array<{markdown?: string}>)[0]?.markdown;
};

const finishBlock = async (id: string, markdown: string, archive: boolean): Promise<void> => {
    const marker = childMarker(markdown);
    const preserved = await fetchCustomAttrs(id);
    if (marker) {
        const latest = await fetchBlockMarkdown(id);
        const next = String(latest || markdown).replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[[^\]]\]/, "$1[X]");
        const response = await fetchSyncPost("/api/block/updateBlock", {
            id,
            dataType: "markdown",
            data: next,
        });
        if (response.code !== 0) {
            throw new Error(response.msg || `updateBlock failed: ${response.code}`);
        }
    }
    const attrs = {...preserved};
    if (!marker) {
        attrs[DONE_ATTR] = "1";
    }
    if (archive) {
        attrs[ARCHIVED_ATTR] = "1";
    }
    if (Object.keys(attrs).length) {
        await setBlockAttrs(id, attrs);
    }
};

export interface CompleteResult {
    completedID?: string;
    nextAction?: string;
    nextActionID?: string;
    parentDone: boolean;
}

export const completeNextAction = async (task: Task): Promise<CompleteResult> => {
    if (task.type !== "task") {
        throw new Error("Only task items can be completed");
    }
    const children = await fetchChildRows(task.id);
    const next = children.find(isUnfinishedChild);
    if (!next) {
        await finishBlock(task.id, task.markdown, true);
        await flushIndex();
        return {parentDone: true};
    }
    await finishBlock(next.id, next.markdown, false);
    await flushIndex();
    const remaining = (await fetchChildRows(task.id)).filter(isUnfinishedChild);
    if (remaining.length === 0) {
        await finishBlock(task.id, task.markdown, true);
        await flushIndex();
        return {completedID: next.id, parentDone: true};
    }
    return {
        completedID: next.id,
        nextAction: childTitle(remaining[0]),
        nextActionID: remaining[0].id,
        parentDone: false,
    };
};

export interface NextActionCandidate {
    text: string;
    hasChildren: boolean;
}

export const getNextActionCandidate = async (blockID: string): Promise<NextActionCandidate> => {
    const children = await fetchChildRows(blockID);
    const next = children.find(isUnfinishedChild);
    if (next) {
        return {text: childTitle(next), hasChildren: true};
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT markdown FROM blocks WHERE id = '${blockID}' LIMIT 1`,
    });
    if (response.code !== 0) {
        throw new Error(response.msg || `query failed: ${response.code}`);
    }
    const row = (response.data as unknown as Array<{markdown?: string}>)[0];
    return {text: taskTextFromBlock(row?.markdown || ""), hasChildren: children.length > 0};
};

export const clarifyBlock = async (
    blockID: string,
    quadrant: GtdQuadrant,
    nextAction?: string,
): Promise<void> => {
    const attrs: Record<string, string> = {
        [CLARIFIED_ATTR]: "1",
        [QUADRANT_ATTR]: quadrant,
    };
    const action = String(nextAction ?? "").trim();
    if (action) {
        attrs[NEXT_ACTION_ATTR] = action;
    }
    await setBlockAttrs(blockID, attrs);
    await flushIndex();
};

export const setTaskQuadrant = async (task: Task, quadrant: GtdQuadrant): Promise<void> => {
    await setBlockAttrs(task.id, {[QUADRANT_ATTR]: quadrant});
    await flushIndex();
};

export const setCaptureCold = async (blockID: string, cold: boolean): Promise<void> => {
    await setBlockAttrs(blockID, {[COLD_ATTR]: cold ? "1" : ""});
    await flushIndex();
};

export const archiveCapture = async (blockID: string): Promise<void> => {
    await setBlockAttrs(blockID, {[ARCHIVED_ATTR]: "1"});
    await flushIndex();
};

export const setPlanBlock = async (
    task: Task,
    date: string,
    start: string,
    end: string,
): Promise<void> => {
    if (!PLAN_DATE_RE.test(date) || !PLAN_TIME_RE.test(start) || !PLAN_TIME_RE.test(end) || end <= start) {
        throw new Error("Invalid time block");
    }
    await setBlockAttrs(task.id, {
        [PLAN_DATE_ATTR]: date,
        [PLAN_START_ATTR]: start,
        [PLAN_END_ATTR]: end,
    });
    await flushIndex();
};

export const clearPlanBlock = async (task: Task): Promise<void> => {
    await setBlockAttrs(task.id, {
        [PLAN_DATE_ATTR]: "",
        [PLAN_START_ATTR]: "",
        [PLAN_END_ATTR]: "",
    });
    await flushIndex();
};

export const markTaskDone = async (task: Task): Promise<void> => {
    if (task.type !== "task") {
        throw new Error("Only task items can be completed");
    }
    const marker = childMarker(task.markdown);
    const preserved = await fetchCustomAttrs(task.id);
    if (marker) {
        const latest = await fetchBlockMarkdown(task.id);
        const markdown = String(latest || task.markdown).replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[[^\]]\]/, "$1[X]");
        if (markdown === (latest || task.markdown)) {
            throw new Error("Task marker not found");
        }
        const response = await fetchSyncPost("/api/block/updateBlock", {
            id: task.id,
            dataType: "markdown",
            data: markdown,
        });
        if (response.code !== 0) {
            throw new Error(response.msg || `updateBlock failed: ${response.code}`);
        }
    } else {
        preserved[DONE_ATTR] = "1";
    }
    if (Object.keys(preserved).length) {
        await setBlockAttrs(task.id, preserved);
    }
    await flushIndex();
};

export const saveTaskMeta = async (
    task: Task,
    dueDate: string,
    dueTime: string,
    priority: Priority,
    reminderMinutes: number | null,
): Promise<void> => {
    const due = dueDate ? (dueTime ? `${dueDate} ${dueTime}` : dueDate) : "";
    await setBlockAttrs(task.id, {
        [DUE_ATTR]: due,
        [PRIORITY_ATTR]: String(priority),
        [REMINDER_ATTR]: reminderMinutes === null ? "global" : String(reminderMinutes),
    });
    await flushIndex();
};

const taskParagraphID = async (taskID: string): Promise<string | undefined> => {
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT id FROM blocks WHERE parent_id = '${taskID}' AND type = 'p' LIMIT 1`,
    });
    if (response.code !== 0) {
        throw new Error(response.msg || `query failed: ${response.code}`);
    }
    return (response.data as unknown as Array<{id: string}>)[0]?.id;
};

export const updateTaskTitle = async (task: Task, title: string): Promise<void> => {
    const text = title.trim();
    if (!text) {
        throw new Error("Task title is empty");
    }
    const targetID = task.blockType === "paragraph" ? task.id : await taskParagraphID(task.id);
    if (!targetID) {
        throw new Error("Task paragraph not found");
    }
    const response = await fetchSyncPost("/api/block/updateBlock", {
        id: targetID,
        dataType: "markdown",
        data: text,
    });
    if (response.code !== 0) {
        throw new Error(response.msg || `updateBlock failed: ${response.code}`);
    }
    await flushIndex();
};

export const updateTask = async (
    task: Task,
    title: string,
    type: TaskType,
    dueDate: string,
    dueTime: string,
    priority: Priority,
    reminderMinutes: number | null,
): Promise<void> => {
    await updateTaskTitle(task, title);
    await saveTaskMeta(task, dueDate, dueTime, priority, reminderMinutes);
    await setBlockAttrs(task.id, {[TYPE_ATTR]: type});
    await flushIndex();
};

export const deleteTask = async (task: Task): Promise<void> => {
    const response = await fetchSyncPost("/api/block/deleteBlock", {id: task.id});
    if (response.code !== 0) {
        throw new Error(response.msg || `deleteBlock failed: ${response.code}`);
    }
    await flushIndex();
};
