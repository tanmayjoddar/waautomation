-- =============================================================================
-- 002_message_errors.sql - Meta's delivery-failure reason, on the message row.
--
-- HOW TO RUN (the human does this, not the AI):
--   Supabase dashboard -> your project -> SQL Editor -> New query -> paste
--   this whole file -> Run. Safe to run twice: every statement is guarded.
--
-- WHY: a failed status webhook is often the ONLY trace of why an outbound
-- message never arrived (the message id came back fine, the phone stayed
-- silent). The webhook updates messages.status, but the reason (Meta's error
-- code, title and message) lived only in that one webhook payload. These
-- columns persist it on the row, so one SELECT answers "why did it fail".
--
-- SEMANTICS: the columns record the latest FAILURE, not the current state.
-- They are written only when a status arrives WITH a Meta error (code not
-- null) and are never cleared afterwards: statuses can arrive out of order,
-- and a later 'delivered' must not erase the record of the earlier failure.
-- messages.status stays the current delivery state.
--
-- NOTE: rows that failed BEFORE this migration ran keep NULL here. The reason
-- for an old failure is gone with its webhook; only new statuses populate
-- these columns. Re-send (or wait for Meta's next status) to see them fill.
-- =============================================================================

alter table messages add column if not exists meta_error_code integer;
alter table messages add column if not exists meta_error_title text;
alter table messages add column if not exists meta_error_message text;
