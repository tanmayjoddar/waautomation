-- =============================================================================
-- 005_staff_alerts.sql - operator alerts table + per-client LLM caps.
--
-- HOW TO RUN (the human does this, not the AI):
--   Supabase dashboard -> your project -> SQL Editor -> New query -> paste
--   this whole file -> Run. Safe to run twice: every statement is guarded.
--   Run AFTER 004_requeue_fix.sql.
--
-- WHAT IT ADDS:
--   1. settings.daily_llm_call_cap / daily_llm_token_cap (nullable): per-client
--      Slice 4 LLM budgets. NULL means "use the server config defaults"
--      (MAX_LLM_CALLS_PER_CLIENT_PER_DAY); the pipeline reads settings first.
--   2. staff_alerts: the ONLY staff-alert channel (no Telegram, by decision).
--      One row per thing needing a human: handover, failed job, daily cap.
--      client_id, kind (handover|job_failed|daily_cap, open text for later
--      kinds), reason (fixed strings and error summaries only, never customer
--      text), contact_id/job_id (nullable links), acknowledged_at (NULL =
--      open). Repeats never create a second open row for the same
--      (client, kind, contact, job): the partial unique index below enforces
--      it, so concurrent inserts cannot double-alert. A repeat after an
--      acknowledge creates a fresh row (re-arms).
--   3. RLS like the other tenant tables: dashboard users SELECT only their own
--      clients' rows. No insert/update/delete policies: only the server
--      (service role, bypasses RLS) writes and acknowledges.
-- =============================================================================

alter table settings add column if not exists daily_llm_call_cap int;
alter table settings add column if not exists daily_llm_token_cap int;

create table if not exists staff_alerts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null,
  reason text not null,
  contact_id uuid references contacts(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  created_at timestamptz default now(),
  acknowledged_at timestamptz
);

-- One OPEN alert per (client, kind, contact, job). NULLs never collide in a
-- plain unique index, so coalesce them to a zero uuid: alerts without a
-- contact/job still dedupe against each other.
create unique index if not exists staff_alerts_open_unique on staff_alerts (
  client_id,
  kind,
  coalesce(contact_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(job_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where acknowledged_at is null;

create index if not exists staff_alerts_client_created on staff_alerts (client_id, created_at desc);

alter table staff_alerts enable row level security;

drop policy if exists "tenant_select_staff_alerts" on staff_alerts;
create policy "tenant_select_staff_alerts" on staff_alerts for select
  using (client_id in (select client_id from client_users where user_id = auth.uid()));
