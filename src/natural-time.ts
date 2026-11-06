import {dateKey} from "./habit-store";

export interface NaturalTime {
    dueDate: string;
    dueTime: string;
}

const CN_DIGITS: Record<string, number> = {
    "零": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
};

const pad = (value: number) => String(value).padStart(2, "0");

const cnNumber = (value: string): number | undefined => {
    if (/^\d+$/.test(value)) {
        return Number(value);
    }
    if (!/^[零一二两三四五六七八九十]+$/.test(value)) {
        return undefined;
    }
    if (value === "十") {
        return 10;
    }
    if (value.includes("十")) {
        const [tensText, onesText] = value.split("十");
        const tens = tensText ? CN_DIGITS[tensText] : 1;
        const ones = onesText ? CN_DIGITS[onesText] : 0;
        if (tens === undefined || ones === undefined) {
            return undefined;
        }
        return tens * 10 + ones;
    }
    return value.length === 1 ? CN_DIGITS[value] : undefined;
};

const normalizeText = (text: string) => String(text)
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xFF10))
    .replace(/[：]/g, ":");

/**
 * Reads simple Chinese/English clock expressions from task text.
 * Examples: 晚上8点吃饭, 明天下午3点半, 8:30, 明早八点, tomorrow at 9pm.
 */
export const parseNaturalTime = (text: string, now = new Date()): NaturalTime | undefined => {
    const source = normalizeText(text);
    let dayOffset = 0;
    let hasDateWord = false;
    if (/大后天/.test(source)) {
        dayOffset = 3;
        hasDateWord = true;
    } else if (/后天/.test(source)) {
        dayOffset = 2;
        hasDateWord = true;
    } else if (/明天|明日|明早|明晚|tomorrow/i.test(source)) {
        dayOffset = 1;
        hasDateWord = true;
    } else if (/今天|今日|今早|今晚|today/i.test(source)) {
        hasDateWord = true;
    }

    let period = (source.match(/凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今晚|明晚|明早|(?:am|pm)/i) || [])[0]?.toLowerCase();
    let hour: number | undefined;
    let minute = 0;

    const colon = source.match(/(\d{1,2}):(\d{1,2})/);
    if (colon) {
        hour = Number(colon[1]);
        minute = Number(colon[2]);
    } else {
        const clock = source.match(/(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*[点时時]\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/);
        if (clock) {
            hour = cnNumber(clock[1]);
            if (clock[2] === "半") {
                minute = 30;
            } else if (clock[2] === "一刻") {
                minute = 15;
            } else if (clock[2] === "三刻") {
                minute = 45;
            } else if (clock[3]) {
                minute = Number(clock[3]);
            }
        } else {
            const english = source.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
            if (english) {
                hour = Number(english[1]);
                minute = english[2] ? Number(english[2]) : 0;
                period = english[3].toLowerCase();
            }
        }
    }

    if (hour === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23
        || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return undefined;
    }

    if (period) {
        if (["下午", "傍晚", "晚上", "夜里", "今晚", "明晚", "pm"].includes(period) && hour < 12) {
            hour += 12;
        } else if (period === "中午" && hour < 11) {
            hour += 12;
        } else if (period === "凌晨" && hour === 12) {
            hour = 0;
        } else if (period === "am" && hour === 12) {
            hour = 0;
        }
    }

    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    if (!hasDateWord && hour * 60 + minute <= currentMinutes) {
        due.setDate(due.getDate() + 1);
    }
    due.setDate(due.getDate() + dayOffset);

    return {
        dueDate: dateKey(due),
        dueTime: `${pad(hour)}:${pad(minute)}`,
    };
};
