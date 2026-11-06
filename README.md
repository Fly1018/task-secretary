# ZhiXing GTD

A SiYuan plugin: capture with `@GTD` in daily notes, plan into four quadrants, execute with time blocks, and keep daily habits.

> The install directory and data directory remain `task-secretary`, so upgrading keeps existing habits and settings.

## Navigation

The side dock has four workspaces:

- **Inbox**: new, unarranged items; cold storage is a filter state inside it.
- **Tasks**: all arranged tasks with internal **List / Quadrants / Timeline** views. The pencil opens one unified **Task settings** dialog for the title, type, deadline, quadrant, execution block, and reminder.
- **Habits**: daily check-ins and streaks.
- **Knowledge**: `@知识` items waiting to be archived.

Refresh and fullscreen stay in the top-right toolbar instead of taking navigation space.

## Workflow

1. **Capture**: write a task in today's daily note and append `@GTD`.
2. **Plan**: open **ZhiXing GTD → Inbox** and choose a quadrant for each item.
3. **Execute**: quadrants show planned tasks only; completing a card advances its next step.
4. **Schedule**: drag a task from the Timeline's "To schedule" rail onto a time slot.
5. **Habits**: habits are separate from tasks and reset daily.

## Trigger routing

Use a trigger token at the end of a daily-note line:

| Trigger | Destination | Next step |
| --- | --- | --- |
| `@GTD` | Inbox | Arrange into a task |
| `@知识` | Knowledge queue | Pick a notebook and document to archive |
| `@阅读` / `@以后` | Cold storage | Park it, arrange or archive later |
| Untagged `- [ ]` task | Inbox | Treated as `@GTD` |

Only unfinished task list items are collected when untagged; ordinary paragraphs without a trigger are ignored. Planning, archiving, and cold storage only write block attributes and never rewrite the note text.

## Capture format

Single-step task:

```markdown
- [ ] Write the plugin guide @GTD
```

Multi-step task: nest task list items. The first unfinished child becomes the next action:

```markdown
- [ ] Ship ZhiXing GTD @GTD
    - [ ] Fix the save failure
    - [ ] Write the guide
```

- Only `@GTD` items in daily notes enter the Inbox.
- `@GTD` inside fenced code or inline code is ignored.
- Completed `[X]`, planned, and archived blocks are excluded.
- Standalone paragraphs with `@GTD` are supported as single-step tasks; use nested tasks for steps.

## Inbox

The Inbox has three sources:

- **Daily**: unplanned `@GTD` blocks from the last N daily notes (default 30 days).
- **Specified**: optional notebook and/or document configured in settings, scanned continuously for `@GTD`.
- **Legacy**: unfinished task blocks that have not been planned, so existing tasks are not lost.

Filters switch between All / Daily / Specified; Legacy appears when such tasks exist.

Age badges turn yellow after 24 hours and red after 48 hours. URL content gets a 🔖 hint and long text gets a 📖 hint. Each item has three exits:

- **Plan**: send it to the quadrants as a task.
- **Knowledge**: pick a notebook and document, then copy it there.
- **Cold**: park it in cold storage.

Plan opens a dialog with:

- read-only original capture;
- next action (first unfinished child for multi-step tasks, editable for single-step tasks);
- mandatory quadrant selection;
- attribute-only save, leaving the daily note text untouched.

Planning uses `custom-gtd-clarified`, `custom-gtd-quadrant`, and `custom-gtd-next-action`.

## Knowledge queue

`@知识` items do not enter the task inbox. They appear in the **Knowledge** workspace. Archiving:

1. choose a notebook;
2. choose a document in that notebook;
3. the content is copied into the document;
4. the original block is marked archived and leaves the queue.

## Cold storage

`@阅读`, `@以后`, and items sent to Cold from the Inbox appear under the Inbox's **Cold** filter. You can:

- **Arrange**: turn the item into a quadrant task;
- **Archive**: send it to the knowledge queue.

Cold items never appear in the timeline or create task anxiety.

## Quadrants

Only planned, quadrant-assigned, non-archived tasks are shown:

- **Important & urgent / Do now**
- **Important, not urgent / Schedule**
- **Not important, urgent / Delegate**
- **Not important, not urgent / Do less**

Each card shows the task, a grey next action, and the remaining step count. Completing a card:

- with steps: completes the first unfinished step and refreshes in place;
- without steps: completes the task;
- when all steps are done: marks the parent done and archives it.

There is no `+` button; capture only happens through `@GTD` in daily notes. Dragging a card between quadrants only changes its quadrant attribute.

**Quadrant vs value for effort**: the quadrant says what kind of work it is; value for effort says whether it is worth doing and which item to do first within that quadrant. High value is green, neutral is amber, low value is gray. It never changes the quadrant.

## Timeline

The Timeline shows planned tasks on a continuous 06:00–24:00 grid:

- **To schedule** rail grouped by quadrant for tasks without a time block;
- drag a rail item onto the grid to create a 60-minute block;
- drag a block to move it; duration is preserved and times snap to 15 minutes;
- on touch/narrow screens, tap the task then tap a time slot;
- block actions: complete next step, start pomodoro, remove from timeline.

Time blocks are stored in `custom-gtd-plan-date`, `custom-gtd-plan-start`, and `custom-gtd-plan-end`.

### Full-window screening

On desktop, today's timeline can play as a full-window, near-black continuous screening:

- click **▶ Present** in the Timeline header, press `Esc` to exit;
- hover to pause, use the wheel to browse, drag empty space to scrub;
- click a task for open / complete next step / start pomodoro;
- switch speed between 0.5× / 1× / 2× in the footer;
- speed and position are remembered for the next session;
- enable **Auto-present once a day** in settings to enter automatically on the first launch each day.

## Habits

Habits live in the **Habits** tab of the same dock and are independent of tasks:

- daily, weekly, monthly, yearly, Ebbinghaus, and no fixed schedule;
- count, duration, or either goal;
- streaks, undoing a check-in, and abandoning a habit;
- pomodoro and stopwatch;
- habit check-in embed blocks (command `⇧⌘H` or right-click the habit panel).

Habit data stays in the plugin's `habits.json` and is never written into notes.

## Pomodoro

- Start from a task card or a time block with 🍅.
- Default focus 25 minutes and break 5 minutes; configurable in settings.
- A desktop always-on-top mini timer appears while SiYuan is minimized.
- When started from a quadrant or time block, focus completion advances the next step and appends a `🍅 Focused for N min` record.
- White full-screen overlays announce focus/break completion.

## Reminders

- Tasks with a scheduled or due time remind you once using the configured lead minutes. If the advance time has already passed, they remind at the task start or deadline.
- Choose "At task time" for an exact-time reminder, or "No reminder" to disable it.
- Each reminder shows a bottom-right toast inside SiYuan and sends a system notification.
- Individual tasks can use "At task time" or "No reminder"; habits can set a reminder time.
- System notifications require SiYuan to be allowed to notify in the operating system.

## Settings

- **Inbox scan days** (default 30).
- **Specified notebook / document**: keep collecting `@GTD`, `@知识`, `@阅读`, and `@以后` from these targets.
- **Pomodoro focus / break minutes**.
- Existing reminder, ICS export, and cloud upload settings remain; ICS exports only planned, non-archived tasks.
- The AccessKey secret is read from SiYuan's secret store and never written to config.

## Data and compatibility

- Existing task blocks are not deleted or migrated; they appear in the Inbox for planning.
- Existing `custom-task-*` attributes, habits, and pomodoro data are preserved.
- New attributes use the `custom-gtd-*` prefix.
- Completion uses `[X]` or `custom-gtd-done`; archive uses `custom-gtd-archived`.

## Development

```bash
pnpm install
pnpm run check
pnpm run build
```

The production build is written to `dist/`. Copy its contents to:

```text
<workspace>/data/plugins/task-secretary/
```

Restart SiYuan or disable/enable the plugin to reload.

## Notes

- Daily-note detection expects a document path ending in `YYYY-MM-DD`; `日记/YYYY/MM/YYYY-MM-DD` works as-is.
- Habit embed blocks are JS query embeds and require safe mode to be off.
- Multi-step tasks should use nested task list items; standalone paragraphs are single-step.
