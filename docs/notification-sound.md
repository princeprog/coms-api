# Notification arrival metadata

`GET /notifications/unread-count` returns `{ unread_count, latest_unread_at }`, where the timestamp is the maximum recipient creation time among the current user's visible, unread notifications, or null when none remain. Existing permission and active-branch scope apply to both fields in the same aggregate query. The timestamp serializes as UTC ISO 8601.

The frontend uses this alongside the existing 30-second poll to announce new unread arrivals even when a simultaneous read keeps the unread count unchanged. No schema migration, notification write, extra endpoint, or new scheduler is needed. Existing clients ignore the additive field; the new frontend can also accept older responses.

Verified with the disposable-database notification suite, including empty metadata and a scoped receiver timestamp matching its personal inbox. Browser behavior is documented in `coms-app/docs/notification-sound.md`.
