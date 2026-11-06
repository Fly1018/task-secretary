import {fetchSyncPost} from "siyuan";
import type {CaptureTrigger, InboxItem, Task} from "./types";
import {fetchTasks} from "./task-store";

const DATE_SUFFIX_SQL = "%/20__-__-__";
const ID_RE = /^\d{14}-[a-z0-9]{7}$/;

const pad = (value: number) => String(value).padStart(2, "0");

const timestampToMs = (created: string): number => {
    const match = String(created || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (!match) {
        return 0;
    }
    return new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
    ).getTime();
};

export const ageHoursOf = (created: string, now = Date.now()): number => {
    const ms = timestampToMs(created);
    return ms > 0 ? Math.max(0, (now - ms) / 3600000) : 0;
};

const cutoffStamp = (days: number): string => {
    const date = new Date(Date.now() - Math.max(1, days) * 86400000);
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}000000`;
};

const stripCode = (text: string): string =>
    String(text || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ");

const firstLine = (markdown: string): string => String(markdown || "").split("\n")[0] || "";

const inlinePlain = (text: string): string => {
    let value = text.split("**").join("").split("__").join("").split("~~").join("").split("`").join("");
    while (value.startsWith("#")) {
        value = value.slice(1);
    }
    value = value.trimStart();
    if (value.startsWith(">")) {
        value = value.slice(1).trimStart();
    }
    return value.trim();
};

const displayText = (markdown: string): string =>
    inlinePlain(firstLine(markdown)
        .replace(/^\s*(?:[-*+]|\d+\.)\s+\[[^\]]\]\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
        .replace(/\u200b/g, "")
        .replace(/\s{2,}/g, " ")
        .trim());

const attrOn = (value: string | null | undefined): boolean => {
    const text = String(value ?? "").trim().toLowerCase();
    return Boolean(text) && text !== "0" && text !== "false";
};

/** Priority: knowledge > read/later > GTD > no trigger. */
export const detectTrigger = (text: string): CaptureTrigger => {
    const clean = stripCode(text);
    if (/@知识/.test(clean)) {
        return "knowledge";
    }
    if (/@阅读/.test(clean)) {
        return "read";
    }
    if (/@以后/.test(clean)) {
        return "later";
    }
    if (/@GTD\b/i.test(clean)) {
        return "gtd";
    }
    return "none";
};

export const cleanCaptureMarkdown = (raw: string | undefined): string =>
    String(raw || "")
        .replace(/^\s*(?:[-*+]|\d+\.)\s+\[[^\]]\]\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
        .replace(/\s*@(?:GTD|知识|阅读|以后)(?=\s|$|[，。；、,.!?])/gi, " ")
        .replace(/\u200b/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

interface InboxRow {
    id: string;
    root_id: string;
    hpath: string;
    type: string;
    subtype?: string | null;
    markdown: string;
    created: string;
    coldAttr?: string | null;
}

const rowsToItems = (rows: InboxRow[], source: "daily" | "custom"): InboxItem[] => {
    const now = Date.now();
    const items: InboxItem[] = [];
    rows.forEach((row) => {
        const raw = String(row.markdown || "");
        const marker = raw.match(/^\s*(?:[-*+]|\d+\.)\s*\[([^\]])\]/)?.[1];
        if (marker === "X" || marker === "-") {
            return;
        }
        const trigger = detectTrigger(raw);
        const isUnfinishedTask = row.type === "i" && row.subtype === "t" && (marker === " " || marker === "/");
        if (trigger === "none" && !isUnfinishedTask) {
            return;
        }
        const text = displayText(raw);
        if (!text) {
            return;
        }
        const blockType: InboxItem["blockType"] = row.type === "p"
            ? "paragraph"
            : row.subtype === "t"
                ? "task"
                : "list";
        items.push({
            id: row.id,
            rootID: row.root_id,
            hpath: row.hpath || "/",
            text,
            source,
            blockType,
            createdAt: String(row.created || ""),
            ageHours: ageHoursOf(String(row.created || ""), now),
            trigger,
            raw,
            cold: attrOn(row.coldAttr),
        });
    });
    return items;
};

const captureSelect = `SELECT b.id, b.root_id, b.hpath, b.type, b.subtype, b.markdown, b.created,
       acold.value AS coldAttr
FROM blocks b
LEFT JOIN attributes ac ON ac.block_id = b.id AND ac.name = 'custom-gtd-clarified'
LEFT JOIN attributes ad ON ad.block_id = b.id AND ad.name = 'custom-gtd-done'
LEFT JOIN attributes aa ON aa.block_id = b.id AND aa.name = 'custom-gtd-archived'
LEFT JOIN attributes acold ON acold.block_id = b.id AND acold.name = 'custom-gtd-cold'
WHERE b.type IN ('p', 'i')
  AND (
    b.markdown LIKE '%@GTD%'
    OR b.markdown LIKE '%@知识%'
    OR b.markdown LIKE '%@阅读%'
    OR b.markdown LIKE '%@以后%'
    OR (
      b.type = 'i' AND b.subtype = 't'
      AND b.markdown NOT LIKE '%@GTD%'
      AND b.markdown NOT LIKE '%@知识%'
      AND b.markdown NOT LIKE '%@阅读%'
      AND b.markdown NOT LIKE '%@以后%'
    )
  )
  AND COALESCE(ac.value, '') = ''
  AND COALESCE(ad.value, '') = ''
  AND COALESCE(aa.value, '') = ''
  AND NOT (b.type = 'p' AND EXISTS (
    SELECT 1 FROM blocks parent
    WHERE parent.id = b.parent_id AND parent.type = 'i' AND parent.subtype = 't'
  ))
  AND NOT (b.type = 'i' AND b.subtype = 't' AND EXISTS (
    SELECT 1 FROM blocks pl
    JOIN blocks pi ON pi.id = pl.parent_id
    WHERE pl.id = b.parent_id AND pl.type = 'l' AND pi.type = 'i' AND pi.subtype = 't'
  ))`;

const fetchDailyCaptures = async (days: number): Promise<InboxItem[]> => {
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `${captureSelect}
  AND b.hpath LIKE '${DATE_SUFFIX_SQL}'
  AND b.created >= '${cutoffStamp(days)}'
ORDER BY b.created ASC
LIMIT 500`,
    });
    if (response.code !== 0) {
        throw new Error(response.msg || `SQL error: ${response.code}`);
    }
    return rowsToItems((response.data || []) as unknown as InboxRow[], "daily");
};

const fetchCustomCaptures = async (notebook: string, docID: string): Promise<InboxItem[]> => {
    const scopes: string[] = [];
    if (ID_RE.test(notebook)) {
        scopes.push(`b.box = '${notebook}'`);
    }
    if (ID_RE.test(docID)) {
        scopes.push(`b.root_id = '${docID}'`);
    }
    if (!scopes.length) {
        return [];
    }
    const response = await fetchSyncPost("/api/query/sql", {
        stmt: `${captureSelect}
  AND (${scopes.join(" OR ")})
ORDER BY b.created ASC
LIMIT 500`,
    });
    if (response.code !== 0) {
        throw new Error(response.msg || `SQL error: ${response.code}`);
    }
    return rowsToItems((response.data || []) as unknown as InboxRow[], "custom");
};

const taskToInboxItem = (task: Task, now: number): InboxItem => ({
    id: task.id,
    rootID: task.rootID,
    hpath: task.hpath,
    text: displayText(task.markdown) || task.title,
    source: "task",
    blockType: task.blockType,
    createdAt: task.createdAt || "",
    ageHours: ageHoursOf(task.createdAt || "", now),
    trigger: detectTrigger(task.markdown),
    raw: task.markdown,
    cold: task.cold === true,
    task,
});

/** Daily, optional notebook/document, and legacy captures, each tagged with its trigger. */
export const fetchAllCaptureItems = async (days = 30, notebook = "", docID = ""): Promise<InboxItem[]> => {
    const [daily, custom, tasks] = await Promise.all([
        fetchDailyCaptures(days),
        fetchCustomCaptures(notebook, docID),
        fetchTasks(),
    ]);
    const now = Date.now();
    const byID = new Map<string, InboxItem>();
    daily.forEach((item) => byID.set(item.id, item));
    custom.forEach((item) => {
        if (!byID.has(item.id)) {
            byID.set(item.id, item);
        }
    });
    tasks
        .filter((task) => !task.clarified && !task.archived && task.type === "task" && !task.parentID)
        .forEach((task) => {
            if (!byID.has(task.id)) {
                byID.set(task.id, taskToInboxItem(task, now));
            }
        });
    return [...byID.values()].sort((a, b) => {
        const aMs = timestampToMs(a.createdAt);
        const bMs = timestampToMs(b.createdAt);
        return aMs - bMs || a.text.localeCompare(b.text);
    });
};

export const fetchInboxItems = async (days = 30, notebook = "", docID = ""): Promise<InboxItem[]> =>
    (await fetchAllCaptureItems(days, notebook, docID))
        .filter((item) => !item.cold && (item.trigger === "gtd" || item.trigger === "none"));

export const fetchKnowledgeItems = async (days = 30, notebook = "", docID = ""): Promise<InboxItem[]> =>
    (await fetchAllCaptureItems(days, notebook, docID))
        .filter((item) => item.trigger === "knowledge");

export const fetchColdItems = async (days = 30, notebook = "", docID = ""): Promise<InboxItem[]> =>
    (await fetchAllCaptureItems(days, notebook, docID))
        .filter((item) => item.trigger !== "knowledge" && (item.cold || item.trigger === "read" || item.trigger === "later"));
