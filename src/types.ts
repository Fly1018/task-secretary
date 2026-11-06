/** Value for effort: 1 = high, 2 = neutral, 3 = low. */
export type Priority = 1 | 2 | 3;

export type TaskMarker = " " | "/" | "X" | "-";

/** Task = actionable item; Routine/Event are shown on the timeline but not in the quadrants. */
export type TaskType = "task" | "routine" | "event";

/** Explicit Eisenhower quadrant assigned while clarifying an inbox item. */
export type GtdQuadrant = "q1" | "q2" | "q3" | "q4";

export type InboxSource = "daily" | "task" | "custom";

export type CaptureTrigger = "gtd" | "knowledge" | "read" | "later" | "none";

export type TaskBlockType = "task" | "paragraph";

export interface NewTaskInput {
    title: string;
    type: TaskType;
    dueDate?: string;
    dueTime?: string;
    /** Value-for-effort score: 1 = high, 2 = neutral, 3 = low. */
    priority: Priority;
}

export type TaskGroupKey = "overdue" | "today" | "tomorrow" | "week" | "later" | "none";

export interface RawTaskRow {
    id: string;
    root_id: string;
    hpath: string;
    content: string;
    markdown: string;
    updated: string;
    blockType?: string | null;
    created?: string | null;
    coldAttr?: string | null;
    dueAttr?: string | null;
    priorityAttr?: string | null;
    reminderAttr?: string | null;
    typeAttr?: string | null;
    clarifiedAttr?: string | null;
    quadrantAttr?: string | null;
    archivedAttr?: string | null;
    doneAttr?: string | null;
    nextActionAttr?: string | null;
    planDateAttr?: string | null;
    planStartAttr?: string | null;
    planEndAttr?: string | null;
    titleContent?: string | null;
    parentID?: string | null;
    parentMarkdown?: string | null;
    parentTitleContent?: string | null;
}

export interface Task {
    id: string;
    rootID: string;
    hpath: string;
    marker: TaskMarker;
    markdown: string;
    title: string;
    type: TaskType;
    dueDate?: string;
    dueTime?: string;
    priority: Priority;
    /** true when the task has an explicit priority attribute or inline token. */
    prioritySet?: boolean;
    /** true when the task has an explicit due date, inline token, or natural-language time. */
    dueSet?: boolean;
    /** -1 = at due time; undefined = use the global reminder; 0 = no reminder; positive = minutes before due. */
    reminderMinutes?: number;
    /** true when the task has an explicit or automatically derived reminder. */
    reminderSet?: boolean;
    /** Parent task list item when this task is nested. */
    parentID?: string;
    /** Parent task title, used to show subtask context. */
    parentTitle?: string;
    group: TaskGroupKey;
    overdue: boolean;

    /** True once the item has passed through the inbox clarify dialog. */
    clarified: boolean;
    quadrant?: GtdQuadrant;
    archived: boolean;
    blockType: TaskBlockType;
    /** First unfinished child step, or the task title for single-step tasks. */
    nextAction?: string;
    nextActionID?: string;
    /** Number of unfinished direct child steps. */
    stepCount: number;
    /** Raw block creation timestamp used by the inbox age badge. */
    createdAt?: string;
    ageHours?: number;
    inboxSource?: InboxSource;

    planDate?: string;
    planStart?: string;
    planEnd?: string;
    cold?: boolean;
}

/** An item waiting in the Inbox: an @GTD daily-note block or a legacy task. */
export interface InboxItem {
    id: string;
    rootID: string;
    hpath: string;
    text: string;
    source: InboxSource;
    blockType: "task" | "paragraph" | "list";
    createdAt: string;
    ageHours: number;
    trigger: CaptureTrigger;
    raw?: string;
    cold?: boolean;
    task?: Task;
}

export const PRIORITY_ORDER: Record<Priority, number> = {1: 0, 2: 1, 3: 2};

export const GROUP_ORDER: TaskGroupKey[] = ["overdue", "today", "tomorrow", "week", "later", "none"];

export const QUADRANT_ORDER: GtdQuadrant[] = ["q1", "q2", "q3", "q4"];
