# Daily report submission in development

Set `NODE_ENV=development` in the local API `.env` and restart the API. Only this exact value bypasses the daily report submission checklist: day-end, closed/reviewed shifts, complete physical counts, and pending delivery counts or explanations. Production, test, and an unset environment retain all normal requirements.

The API returns `submission_checklist_bypassed` in report details. The app uses this server-owned value to enable submission and display a development notice. Clients cannot enable the bypass through a request field. Keep `NODE_ENV=production` in deployed environments.

Authentication, permission and branch checks, active-branch requirements, valid report transitions, and input validation still apply. Unsaved edits must be saved or discarded before submission. Approval validation is unchanged; a report submitted without physical counts must be returned and completed before approval.

Development submissions retain null counts, recalculate available ledger and sales totals, and record `Submission checklist bypassed in development.` in the submission event. They do not create invented counts or delivery explanations.
