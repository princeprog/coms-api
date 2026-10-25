# Register shifts and business day

Each branch runs one register shift at a time. The cashier who opens it counts the starting cash ("float"); only that cashier can sell until the shift is closed. Closing is a blind count: the cashier enters counted cash and the cash left for the next shift before the API reveals expected cash and the difference. A branch manager (someone other than the cashier, except Super Admin) reviews every closed shift; a review note is required when the opening or closing count differs. The daily report for a business date can be submitted only when that day has no open or unreviewed shifts.

## Business day

`business_day_rules` holds effective-dated start times (Asia/Manila, on the hour or half hour). The seed rule is 00:00, so business dates match calendar dates until Super Admin schedules a change. Database functions `coms_business_day_start(date)`, `coms_business_day_end(date)` and `coms_business_date(timestamptz)` define contiguous days; a change can make one day longer or shorter, never overlapping. Daily report ledger and sales totals, report delivery cutoffs, the void lock, sales history date filters and the dashboard use these functions. Dispatch deadlines, receiving reminders and purchase dates remain calendar dates.

- `GET /settings/business-day` (signed-in roles): current and scheduled rules, `business_today`, today's start and end.
- `PUT /settings/business-day` (Super Admin): `{start_time: "HH:00"|"HH:30", effective_from}`; the date must follow the current business day and the new start must be in the future. Replaces any scheduled rule. Rejected with 409 `SHIFT_TEMPLATES_CROSS_DAY_START` when the new start would fall inside an active branch work shift (see `docs/schedules.md`).
- `DELETE /settings/business-day/scheduled` (Super Admin).

## My shift (`GET /shifts/mine`, `shifts.read`)

Returns `{shift}`: the signed-in user's open shift in any branch they can access (Super Admin: any branch), or `null`. It is not branch-scoped so the app header can show shift status before a branch is chosen. Shift payloads include `branch_name`.

## Shifts API (`/branches/:branchId/shifts`, branch-scoped, UUID `Idempotency-Key` on open, cash and close actions)

| Route | Permission | Notes |
| --- | --- | --- |
| `GET current`, `GET /`, `GET :id` | `shifts.read` | List: 10/30/50 rows, newest business date first, status and business-date filters. While a shift is open, users without `shifts.review` receive `cash_hidden: true` with expected cash and cash totals omitted. |
| `POST /` | `shifts.operate` | `{opening_float}`. One open shift per branch; compares with the previous shift's `left_in_drawer`. |
| `POST :id/cash-movements` | `shifts.operate` | `{direction: IN|OUT, amount, reason}`; owner or reviewer, open shifts only. |
| `POST :id/close` | `shifts.operate` | Owner only. `{counted_cash, left_in_drawer}`; returns expected cash and difference. |
| `POST :id/force-close` | `shifts.review` | Same body plus required `reason`. |
| `POST :id/explanation` | `shifts.operate` | Owner, once, closed and unreviewed. |
| `POST :id/review` | `shifts.review` | `{note?}`; note required with any difference. |

Opening a register records whether the opener was on the branch work schedule (`schedule_status`: `SCHEDULED`, `UNSCHEDULED` or `NO_SCHEDULE`, plus `scheduled_shift_name`); it never blocks opening. See `docs/schedules.md`.

Expected cash = opening float + cash sales recorded in the shift (any status) − cash refunds recorded in the shift + pay-ins − pay-outs. Sales store `shift_id` and a `payment_kind` snapshot. Creating a sale requires the branch's open shift, owned by the seller, within its business day (409 `SHIFT_REQUIRED`, `SHIFT_OWNED_BY_OTHER`, `SHIFT_DAY_ENDED`). Voids record `refund_shift_id` for the open shift; voiding a cash sale with no open shift returns 409 `SHIFT_REQUIRED_FOR_REFUND`. A closed shift with any difference, or a forced close, publishes `SHIFT_NEEDS_REVIEW` to branch users with `shifts.read` + `shifts.review` and to Super Admin.

## Permissions and release

Migration `20261020234124_register_shifts_and_business_day` adds `shifts.read`, `shifts.operate` and `shifts.review`, granting operate/read to roles with `sales.create`, read to roles with `sales.read` or `daily_reports.read`, and review to roles with `daily_reports.submit`. Rollback refuses once shifts exist, business-day rules were changed, or shift grants were added afterwards. After release, cashiers must open a shift before the next sale; older sales without a shift stay valid.

Local verification: backup restore with forward, rollback and reapply preserved all 58 existing tables; the local apply kept all business tables identical. 191 unit tests and 169 disposable-database integration tests passed, including concurrent opens, blind visibility, idempotent cash and close retries, refunds into a later shift, float handover, force close, self-review denial, day-end selling lock, report blocking and business-day boundaries across start-time changes.

