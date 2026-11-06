export type PomodoroPhase = "focus" | "break";
export type PomodoroTargetKind = "task" | "habit";

export interface PomodoroTarget {
    kind: PomodoroTargetKind;
    id: string;
    title: string;
    /** Active document at start time; used to place habit records. */
    docID?: string;
    /** Complete the task's next step when the focus phase ends. */
    completeNext?: boolean;
}

export interface PomodoroState {
    running: boolean;
    paused: boolean;
    phase: PomodoroPhase;
    target: PomodoroTarget;
    focusMinutes: number;
    breakMinutes: number;
    totalSeconds: number;
    remainingSeconds: number;
    endsAt: number;
}

export interface PomodoroCallbacks {
    onState?(state: PomodoroState | null): void;
    onTick?(state: PomodoroState): void;
    onPhaseComplete?(phase: PomodoroPhase, state: PomodoroState): void;
}

const clampMinutes = (value: number, min: number, max: number, fallback: number): number => {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(minutes)));
};

/** One global pomodoro at a time. The timer is deadline based, so throttled intervals cannot drift. */
export class PomodoroTimer {
    private state?: PomodoroState;
    private interval?: number;
    private remainingMs = 0;
    private completing = false;
    private readonly callbacks: PomodoroCallbacks;

    constructor(callbacks: PomodoroCallbacks = {}) {
        this.callbacks = callbacks;
    }

    getState(): PomodoroState | undefined {
        return this.state ? {...this.state, target: {...this.state.target}} : undefined;
    }

    isActive(): boolean {
        return Boolean(this.state?.running);
    }

    isTarget(kind: PomodoroTargetKind, id: string): boolean {
        return this.state?.target.kind === kind && this.state.target.id === id;
    }

    start(target: PomodoroTarget, focusMinutes: number, breakMinutes: number): PomodoroState {
        this.clearInterval();
        const focus = clampMinutes(focusMinutes, 1, 180, 25);
        const rest = clampMinutes(breakMinutes, 0, 120, 5);
        this.completing = false;
        this.state = {
            running: true,
            paused: false,
            phase: "focus",
            target: {...target},
            focusMinutes: focus,
            breakMinutes: rest,
            totalSeconds: focus * 60,
            remainingSeconds: focus * 60,
            endsAt: Date.now() + focus * 60000,
        };
        this.startInterval();
        this.emitState();
        return this.getState()!;
    }

    pause(): void {
        if (!this.state?.running || this.state.paused) {
            return;
        }
        this.remainingMs = Math.max(0, this.state.endsAt - Date.now());
        this.state.paused = true;
        this.state.remainingSeconds = Math.ceil(this.remainingMs / 1000);
        this.clearInterval();
        this.emitState();
    }

    resume(): void {
        if (!this.state?.running || !this.state.paused) {
            return;
        }
        const remaining = Math.max(0, this.remainingMs);
        this.state.paused = false;
        this.state.endsAt = Date.now() + remaining;
        this.state.remainingSeconds = Math.ceil(remaining / 1000);
        this.startInterval();
        this.emitState();
    }

    togglePause(): void {
        if (this.state?.paused) {
            this.resume();
        } else {
            this.pause();
        }
    }

    stop(): void {
        this.clearInterval();
        this.state = undefined;
        this.completing = false;
        this.callbacks.onState?.(null);
    }

    /** Used by the mini window as a completion nudge when the main window is throttled. */
    checkComplete(): void {
        if (this.state?.running && !this.state.paused && Date.now() >= this.state.endsAt) {
            this.completePhase();
        }
    }

    private startInterval(): void {
        this.clearInterval();
        this.interval = window.setInterval(() => this.tick(), 1000);
        this.tick();
    }

    private clearInterval(): void {
        if (this.interval !== undefined) {
            window.clearInterval(this.interval);
            this.interval = undefined;
        }
    }

    private tick(): void {
        if (!this.state?.running || this.state.paused) {
            return;
        }
        const remaining = Math.max(0, this.state.endsAt - Date.now());
        this.state.remainingSeconds = Math.ceil(remaining / 1000);
        this.callbacks.onTick?.(this.getState()!);
        if (remaining <= 0) {
            this.completePhase();
        }
    }

    private completePhase(): void {
        if (!this.state?.running || this.completing) {
            return;
        }
        this.completing = true;
        const completed = this.getState()!;
        if (completed.phase === "focus" && completed.breakMinutes > 0) {
            this.state = {
                ...completed,
                phase: "break",
                totalSeconds: completed.breakMinutes * 60,
                remainingSeconds: completed.breakMinutes * 60,
                endsAt: Date.now() + completed.breakMinutes * 60000,
                paused: false,
            };
            this.startInterval();
            this.emitState();
        } else {
            this.clearInterval();
            this.state = undefined;
            this.callbacks.onState?.(null);
        }
        this.completing = false;
        this.callbacks.onPhaseComplete?.(completed.phase, completed);
    }

    private emitState(): void {
        this.callbacks.onState?.(this.getState() ?? null);
    }
}
