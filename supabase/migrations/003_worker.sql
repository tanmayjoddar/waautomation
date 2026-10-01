-- =============================================================================
-- 003_worker.sql - reply-worker queue support (Slice 4)
--
-- HOW TO RUN (the human does this, not the AI):
--   Supabase dashboard -> your project -> SQL Editor -> New query -> paste
--   this whole file -> Run. Safe to run twice: every statement is guarded.
--   Run AFTER 001_init.sql and 002_message_errors.sql.
--
-- WHAT IT ADDS:
--   1. jobs.started_at: set when a job is claimed (NULL while pending). The
--      stale-job reaper uses it, not run_at: a job can sit pending for a day
--      legitimately, but a job RUNNING for minutes means its worker died.
--   2. messages.job_id + part_index with a partial unique index: the worker
--      inserts each reply part BEFORE sending it, tagged with its job and
--      position, so a retried job resumes unsent parts instead of duplicating
--      sent ones. The index is partial (job_id not null) so the millions of
--      rows without a job never enter it.
--   3. claim_due_job replaced (same signature, same global-NULL path): never
--      hands out a job for a contact that already has a 'running' job. Two
--      layers because neither alone is enough: a NOT EXISTS pre-filter skips
--      busy contacts up front, and a contact-row lock + re-check closes the
--      race where two claimers pass the filter simultaneously.
--   4. requeue_stale_jobs(p_minutes): running jobs older than p_minutes go
--      back to pending (attempts < 3, started_at cleared) or failed. Returns
--      how many rows moved. The worker calls it every minute.
--   5. usage_log index for the per-client daily LLM cap lookup.
--
-- PRIVILEGES: queues are worker-only. Both functions are service_role only;
-- anon, authenticated and PUBLIC are explicitly revoked (Postgres grants
-- EXECUTE on new functions to PUBLIC, and Supabase's anon/authenticated are
-- members of PUBLIC).
-- =============================================================================

alter table jobs add column if not exists started_at timestamptz;

alter table messages add column if not exists job_id uuid references jobs(id) on delete set null;
alter table messages add column if not exists part_index int;
create unique index if not exists messages_job_part on messages (job_id, part_index) where job_id is not null;

-- Same signature as 001 (p_client_id defaults to NULL = shared global queue
-- for the Slice 4 poller, which has no client context of its own). Dropped
-- first because CREATE OR REPLACE cannot change behaviour that callers may
-- depend on, and a stale overload would leave PostgREST unable to choose.
drop function if exists claim_due_job(uuid);

create or replace function claim_due_job(p_client_id uuid default null)
returns jobs language plpgsql
set search_path = public, pg_temp
as $$
declare
  claimed jobs;
begin
  -- Candidate: oldest due pending job for this tenant (or any tenant when the
  -- caller passes NULL), skipping contacts that already have a running job.
  -- FOR UPDATE OF j SKIP LOCKED: concurrent claimers never block on the same
  -- row; the loser just takes the next one.
  select * into claimed from jobs j
   where j.status = 'pending' and j.run_at <= now()
     and (p_client_id is null or j.client_id = p_client_id)
     and not exists (
       select 1 from jobs r
        where r.contact_id = j.contact_id and r.status = 'running'
     )
   order by j.run_at
   for update of j skip locked
   limit 1;
  if not found then
    return null;                        -- no id, so no job
  end if;

  -- Race guard: two claimers can both pass the NOT EXISTS filter for the same
  -- contact (same snapshot), then lock different rows. Serialise per contact
  -- on the contacts row, then re-check under the lock.
  perform 1 from contacts where id = claimed.contact_id for update;
  if exists (
    select 1 from jobs o
     where o.contact_id = claimed.contact_id and o.status = 'running' and o.id <> claimed.id
  ) then
    return null;                        -- our candidate stays pending for later
  end if;

  update jobs set status = 'running', attempts = attempts + 1, started_at = now()
   where id = claimed.id
   returning * into claimed;

  if not found then
    return null;                        -- row deleted between SELECT and UPDATE
  end if;
  return claimed;
end $$;

revoke all on function claim_due_job(uuid) from public, anon, authenticated;
grant execute on function claim_due_job(uuid) to service_role;

-- Stale-worker reaper. started_at NULL means "claimed by pre-003 code", which
-- is stale by definition now (003 always sets it), so NULL counts as expired.
create or replace function requeue_stale_jobs(p_minutes int)
returns int language plpgsql
set search_path = public, pg_temp
as $$
declare
  moved int := 0;
  n int;
begin
  update jobs
     set status = 'failed',
         last_error = case
           when last_error is null or last_error = '' then 'stale worker: still running'
           else last_error || ' | stale worker: still running'
         end
   where status = 'running'
     and coalesce(started_at, to_timestamp(0)) < now() - make_interval(mins => p_minutes)
     and attempts >= 3;
  get diagnostics n = row_count;
  moved := moved + n;

  update jobs
     set status = 'pending',
         started_at = null
   where status = 'running'
     and coalesce(started_at, to_timestamp(0)) < now() - make_interval(mins => p_minutes)
     and attempts < 3;
  get diagnostics n = row_count;
  moved := moved + n;

  return moved;
end $$;

revoke all on function requeue_stale_jobs(int) from public, anon, authenticated;
grant execute on function requeue_stale_jobs(int) to service_role;

-- Serves the daily LLM cap: usage_log rows for one client + kind, newest first.
create index if not exists usage_log_client_kind_created on usage_log (client_id, kind, created_at desc);
