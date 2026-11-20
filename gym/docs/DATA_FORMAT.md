# Gym App — data format & how to move it to a server

This describes everything the app stores, so another version (e.g. one with its own
backend) can load the real data without guessing.

**Short version:** in the app, go to **Data → Export backup**. That JSON file holds the whole
database. Each table is an array of rows, as described below. All database access in the app
goes through one file, `src/db/dal.js`. Replace that file with API calls to a server and the
rest of the app keeps working.

---

## Where the data lives now

- **IndexedDB** (the browser/WebView database) via [Dexie](https://dexie.org), database name
  `GymApp`, schema version **5**. Schema and migrations: `src/db/db.js`.
- **Only `src/db/dal.js` touches the database.** Pages and libraries import functions from it.
  Every function is `async`, so swapping it for `fetch()` calls to a server needs no changes
  elsewhere.
- **Unsaved form input** (drafts) is kept separately in localStorage under keys starting with
  `gymapp:draft:`, plus a copy in Capacitor Preferences on Android. That's temporary data and
  is **not** part of the database or the backup.
- **The Android app sends nothing anywhere.** No accounts, no server, no analytics.

### Server version

`npm run build:server` builds the same app with `src/db/dal.api.js` in place of `dal.js`:
the data then lives in PostgreSQL on your own server (`server/`, see `server/README.md`),
one SQL table per table below, each row stored as JSONB, kept separately for every user
that logs in through Authelia. Backups use the same file format,
so a backup exported on the phone can be restored on the server and the other way around.

## The backup file

```json
{
  "meta": { "format": "gym-app-backup", "schemaVersion": 5, "exportedAt": "2026-11-16T10:00:00.000Z" },
  "dailyLogs": [ … ],
  "exercises": [ … ],
  "exerciseGoals": [ … ],
  "sessions": [ … ],
  "personalRecords": [ … ],
  "schedule": [ … ],
  "research": [ … ],
  "profile": { … },
  "aiMemory": [],
  "sessionTypes": [ … ]
}
```

Backups from before 2026-11-16 have no `meta`. Treat a missing `meta` as schema version 5.

**Restoring** a backup in the app **replaces** each table in the file (it doesn't merge): IDs are per phone,
so merging could attach one phone's sets to another phone's exercises. Library exercises that are newer
than the backup are added afterwards.

### General rules

- **Dates** are local calendar dates as text: `"YYYY-MM-DD"`. Timestamps (`createdAt`,
  `updatedAt`, `exportedAt`) are ISO-8601 UTC strings.
- **Units:** weights in **kg**, macros in **grams** (kcal in kcal), sleep in **hours**, body fat in **%**.
- **Missing values are left out** (the key is absent), not stored as `null` or `0`.
- **`updatedAt`** is set on every write since 2026-11-16. Older rows don't have it.
- **IDs** (`id`) are auto-increment integers, local to that phone. Other tables point to them
  (see Relations). Keep them as they are when importing one user's data, or remap all the
  references together.
- **Deletes are hard deletes.** A deleted row is simply gone; there's no "deleted" flag.

---

## Tables

### `dailyLogs` — one row per day
Primary key: `date`.

| field | type | meaning |
|---|---|---|
| `date` | `"YYYY-MM-DD"` | the day |
| `weight` | number | body weight in kg, **measured that morning, fasted** |
| `kcal`, `protein`, `carbs`, `fat`, `sugar`, `salt` | number | food eaten **during** that day (after the weigh-in). Grams; kcal for kcal |
| `steps` | integer | steps that day |
| `sleep` | number | hours of sleep (as entered) |
| `bf` | number | body fat % |
| `note` | string | free text |
| `important` | boolean | flagged day (sick, travel, …). Very old rows may use `sick: true` instead |
| `goalsSnapshot` | object | the targets and colour rules in force when the day was logged (below) |
| `updatedAt` | ISO string | last change |

> ⚠ **Timing:** a day's food shows up in the **next** morning's weight, not the same row's.

`goalsSnapshot`:
```json
{ "kcal": "2200", "protein": "180", "carbs": "220", "fat": "65", "sugar": "50", "salt": "6",
  "modes": { "kcal": "under", "protein": "near", "carbs": "under", "fat": "under", "sugar": "under", "salt": "under" },
  "green": 5, "amber": 15 }
```
- Target values may be **numbers stored as text** (they come straight from the Settings form). Cast them.
- `modes` per macro: `under` = at or under the target is good, `near` = close to it is good,
  `over` = at or over it is good.
- `green` / `amber` = allowed deviation in %. Within `green` → green, within `amber` → amber,
  beyond → red.
- Older rows may have only the target values (no `modes`/`green`/`amber`), or no snapshot at all.

### `exercises` — the exercise library (built-in + custom)
| field | type | meaning |
|---|---|---|
| `id` | integer | primary key |
| `name` | string | unique (case-insensitive), e.g. `"Barbell Bench Press"` |
| `muscleGroup` | string | e.g. `Chest`, `Back`, `Quads`, `Other` |
| `seedName` | string? | original built-in name, only if the user renamed a built-in exercise |
| `updatedAt` | ISO string? | |

About 460 built-in exercises come from `src/db/seedExercises.js`. Built-in names are never
renamed in code, because migrations match on them.

### `sessions` — logged sets (despite the name: one row = one set)
The app logs **one top set per exercise per workout** (taken close to failure).

| field | type | meaning |
|---|---|---|
| `id` | integer | primary key |
| `exerciseId` | integer | → `exercises.id` |
| `date` | `"YYYY-MM-DD"` | |
| `weight` | number | kg lifted (`0` = bodyweight, or only the added weight) |
| `reps` | integer | |
| `batchId` | string? | the same for all sets saved with one "Save session" press (one workout). Imported notes use `"import-<date>-<stamp>"`. Very old rows have none |
| `note` | string? | **workout** note, copied onto every set of that workout (e.g. "elbow pain") |
| `exNote` | string? | **exercise-only** note (e.g. "form upgrade"); shown as a dashed marker on the graph |
| `targetWeight`, `targetReps` | number? | the suggested set this was aiming for (used for "missed target" / stall detection) |
| `targetKind` | string? | `rep` (+1 rep), `jump` (more weight), `reset` (lighter), `hold` (match, on a cut), `bodyweight`, `wait` (same reps: the level is less than a week old), `recover` (back to the level after dropping below it) |
| `updatedAt` | ISO string? | |

### `personalRecords` — best set per exercise (**derived**)
Primary key: `exerciseId`. Fields: `exerciseId`, `date`, `weight`, `reps`, `updatedAt`.
This can always be recomputed from `sessions`: it's the set with the highest estimated 8RM (below).

### `exerciseGoals` — one goal per exercise
Primary key: `exerciseId`. Fields: `exerciseId`, `targetWeight`, `targetReps`, `updatedAt`.

### `sessionTypes` — the user's splits (e.g. "Push", "Legs")
| field | type | meaning |
|---|---|---|
| `id` | integer | primary key |
| `name` | string | |
| `exerciseIds` | integer[] | → `exercises.id`, **in display order** |
| `updatedAt` | ISO string? | |

### `schedule` — weekly template, always 7 rows
| field | type | meaning |
|---|---|---|
| `day` | 0–6 | primary key, **0 = Sunday** … 6 = Saturday |
| `type` | string | `gym`, `sport`, `rest`, `other` (older data may also have `karate`) |
| `label` | string | shown name |
| `sessionTypeId` | integer \| null | → `sessionTypes.id` (gym days) |

### `research` — notes cards
Fields: `id`, `title`, `body`, `status` (`researching` \| `active` \| `dropped`), `createdAt`
(ISO), `order` (number, display order), `updatedAt`.

### `profile` — one object (`id: 1`)
| field | meaning |
|---|---|
| `goalKcal`, `goalProtein`, `goalCarbs`, `goalFat`, `goalSugar`, `goalSalt` | current daily targets (**may be numeric strings**) |
| `height` (cm), `age`, `experience` (`beginner`/`intermediate`/`advanced`) | |
| `trainingInfo`, `personalPlan` | free text |
| `phase` | current phase id: `cut`, `bulk`, `maintain`, or `custom-<timestamp>` |
| `phaseStartDate` | `"YYYY-MM-DD"` |
| `phaseHistory` | past phases, oldest first (below) |
| `customPhases` | `[{ id, name, description, baseType: cut/bulk/maintain/neutral, progressionMode?: progress/hold/off }]` |
| `colorModes`, `colorGreenPct`, `colorAmberPct` | current colour rules (same meaning as in `goalsSnapshot`); missing = defaults for the phase type |
| `graphYMin`, `graphYMax`, `showTrendLine`, `trendDays`, `showRateOfChange` | Log graph settings |
| `weightSuggestions`, `progMinReps`, `progMaxReps` | gym suggestion settings (default rep range 6–10). Older profiles may also have `progStallAfter` / `progEveryDays` — no longer used |
| `prRecomputedV2` | internal migration flag |
| `injuries`, `trainingContext`, `dietaryNotes`, `goalWeight`, `theme`, `aiUsageCount`, `aiUsageDate` | old fields that are no longer used; safe to ignore |

`phaseHistory` entry:
```json
{ "phase": "cut", "name": "Cut", "from": "2026-09-20", "to": "2026-11-04",
  "settings": { "goalKcal": "2200", "goalProtein": "180", "colorModes": { "protein": "over" } } }
```
- `to` is the **switch day**, and that day already belongs to the **next** phase. The last day of
  this phase is `to − 1 day` (unless `from == to`).
- `settings` holds the targets and colour rules that phase had. It's missing on phases archived
  before 2026-11-16.
- Which phase a date belongs to: on or after `phaseStartDate` → the current phase; otherwise
  the newest history entry with `from ≤ date ≤ to`.

### `aiMemory`
Left over from the removed in-app AI. Always empty for new users; safe to ignore.

---

## Relations

```
exercises.id ◄── sessions.exerciseId
             ◄── exerciseGoals.exerciseId
             ◄── personalRecords.exerciseId
             ◄── sessionTypes.exerciseIds[]   (ordered)
sessionTypes.id ◄── schedule.sessionTypeId
```

## Calculations the app uses

- **Estimated 8RM** (used to compare sets with different reps, and for PRs):
  `e1RM = weight × (1 + reps / 30)` (Epley), then `8RM = e1RM / (1 + 8 / 30)`.
- **PR / "new best"**: a set whose 8RM beats every earlier set of the same exercise.
- **Level** of an exercise: its current weight (that of the last set) and the most reps done at that
  weight since switching to it. A bad day doesn't lower it. The one-week clock starts at the latest
  unbroken stretch of sets at that level; dropping below it means `recover` first, and the clock restarts.
- **Next step**: once the level has held for a week (6+ days): +1 rep, or more weight at the top of the
  rep range. Before that the target is `wait` (same reps). Too heavy (below the range) → lighter right away.
- **Stalling**: since the last step forward, the missed targets (incl. drops below the level; holding or
  recovering the level is neutral, not progress) span a week (6+ days, at least 2 misses). A step forward
  = hitting a step target or beating the best of the previous 3 sessions.
- **kg/week** on the Log graph: rolling averages over `trendDays` (default 7) at the start vs the
  end of the range, so water weight doesn't skew it.
- **Weekly change on Home**: this week's average weight vs last week's (Mon–Sun), shown once both
  weeks have at least 2 weigh-ins.

Code: `src/lib/utils.js` (8RM, colours), `src/lib/progression.js` (suggestions, PRs, stalls),
`src/lib/phases.js` (phases).

---

## Moving to a server (notes for a future version)

**One-way (load a backup into a server database): easy.**
1. Create one table per array above (`profile` is a single row, or a key/value table).
2. Import the JSON as-is. Keep the `id`s so the relations stay intact. Cast the numeric strings
   (`goal*`, snapshot targets) to numbers.
3. Replace `src/db/dal.js` with functions of the same names that call the server. Function list:
   `saveLog mergeLog getLog getLogs getAllLogs getLatestWeighedLog getAllExercises saveExercise
   getSessionTypes saveSessionType deleteSessionType getGoal saveGoal getAllGoals saveSessions
   getSessionsForExercise getAllSessions getSessionsOnDate deleteSessionsByIds getPR savePR
   getAllPRs recomputePR recomputeAllPRs getSchedule saveScheduleDay getResearch saveResearch
   deleteResearch getProfile saveProfile exportAll importAll`.
   Note that `mergeLog` merges (filled fields update the day, the original `goalsSnapshot` is
   kept), while `saveLog` fully replaces the day.

**Two-way sync (phone ↔ server): more work.** The groundwork is there (`updatedAt` on every
write), but a real sync would also need:
- IDs that can't collide between devices (e.g. UUIDs), or the server handing out IDs;
- a record of deletions (tombstones), since deletes are currently hard deletes;
- a rule for conflicts (e.g. newest `updatedAt` wins).
