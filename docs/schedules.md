# Branch work schedules

Schedules say who should work when. They sit beside register (cash) shifts, which record who handled the cash; opening a register is never blocked by the schedule.

## Model

- **Shift templates** (`branch_shift_templates`): per branch, a name (unique among active shifts, up to 40 characters), start and end time on the hour or half hour, and the weekdays it runs (ISO 1 = Monday … 7 = Sunday). A shift may pass midnight. Shifts at one branch may overlap; gaps mean the branch is closed. Up to 12 active shifts per branch. Deactivating keeps assignments for reactivation. Edits use `revision`; removing a weekday drops it from everyone's pattern. Row changes are audited (`shift_template.*`).
- **Weekly pattern** (`staff_shift_assignments`): user × shift × weekday, no dates; changes apply from now on (last write wins, audited as `staff.schedule_updated`).
- **Dated exceptions** (`staff_shift_exceptions`): `OFF` removes a pattern shift on one business date; `EXTRA` adds a one-off shift. Adding an extra for someone on their day off cancels the day off. Dates must be today's business date or later (within a year). Audited as `staff.schedule_day_off`, `staff.schedule_extra_shift`, `staff.schedule_change_removed`.

## Rules

- **One business day per shift.** A shift belongs to one business date and starts at the moment within that business day whose Manila time is its start time. With a 06:00 day start, a 02:00 shift falls on the next calendar morning.
- **No crossing the day start.** The business day's start time may not fall strictly inside a shift (starting or ending exactly at it is fine), checked against the current and any scheduled rule (`SHIFT_CROSSES_DAY_START`). With the default 00:00 start, an overnight 22:00–06:00 shift needs the business day start moved to 06:00 first. `PUT /settings/business-day` returns 409 `SHIFT_TEMPLATES_CROSS_DAY_START` listing the shifts a new start would split.
- **Who is scheduled** on a date: pattern rows for that weekday whose shift is active and runs that day, minus `OFF`, plus `EXTRA`; only active staff still assigned to the active branch (`schedule-occurrences.ts`).
- **No double booking.** A person can't hold overlapping shifts on the same weekday or date, across all branches (`SCHEDULE_OVERLAP`).
- **Cleanup.** Removing someone from a branch deletes their pattern and upcoming exceptions there; deactivating the account deletes all of them.

## Register link

Opening a register records `schedule_status` and `scheduled_shift_name` on `register_shifts`: `SCHEDULED` when the opener has a shift at that branch running now (opening up to 30 minutes early counts), `UNSCHEDULED` when the branch has active shifts but not for them, `NO_SCHEDULE` when the branch has none. Older shifts are null. The Dashboard adds `register_not_opened` (a scheduled shift started at least 15 minutes ago with no open register) and `register_opened_unscheduled` (today's registers opened by someone not scheduled), both for `schedules.read`.

## Access

`schedules.read` views a branch schedule; `schedules.manage` edits shifts, patterns and exceptions. Both are branch-scoped; the migration grants them to the predefined Branch Manager. Any active role can read `GET /schedules/mine`.

## API

| Route | Permission |
| --- | --- |
| `GET /branches/:branchId/shift-templates` | `schedules.read` |
| `POST /branches/:branchId/shift-templates` `{name, start_time, end_time, weekdays}` | `schedules.manage` |
| `PATCH /branches/:branchId/shift-templates/:id` (plus `revision`) | `schedules.manage` |
| `POST /branches/:branchId/shift-templates/:id/deactivate`, `/reactivate` | `schedules.manage` |
| `GET /branches/:branchId/schedule?week=YYYY-MM-DD` (any date; normalized to its Monday) | `schedules.read` |
| `PUT /branches/:branchId/schedule/pattern/:userId` `{assignments: [{template_id, weekday}]}` | `schedules.manage` |
| `POST /branches/:branchId/schedule/exceptions` `{user_id, template_id, work_date, kind, reason?}` | `schedules.manage` |
| `DELETE /branches/:branchId/schedule/exceptions/:id` | `schedules.manage` |
| `GET /schedules/mine` (next 14 business days, all branches) | active role |

Migration `20261025150804_branch_work_schedules` adds the tables, register columns, permissions and audit trigger. Tests: `src/modules/schedules/schedule-policy.spec.ts` and `test/schedules.e2e-spec.ts` (disposable database).
