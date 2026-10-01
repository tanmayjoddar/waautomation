-- =============================================================================
-- 004_requeue_fix.sql - stale reaper that survives multi-running contacts.
--
-- HOW TO RUN (the human does this, not the AI):
--   Supabase dashboard -> your project -> SQL Editor -> New query -> paste
--   this whole file -> Run. Safe to run twice. Run AFTER 003_worker.sql.
--
-- WHY 003's VERSION HAD TO GO: requeue_stale_jobs() moved every stale running
-- job with two set-based UPDATEs. When one contact has TWO stale running jobs
-- (leftover of pre-003 crashes: 003 counts NULL started_at as stale, and the
-- old claimer had no per-contact guard), flipping both to pending in one
-- statement violates the partial unique index jobs_one_pending_per_contact
-- and aborts the whole call: ZERO rows move, forever. Found live 2026-10-02.
--
-- THIS VERSION processes stale rows one by one, oldest first: the first job
-- per contact goes back to pending (or failed when attempts are exhausted),
-- and a unique_violation on a sibling row fails THAT row instead of aborting
-- the batch. Returns how many rows moved, like before.
--
-- PRIVILEGES unchanged: service_role only; anon, authenticated, PUBLIC revoked.
-- =============================================================================

create or replace function requeue_stale_jobs(p_minutes int)
returns int language plpgsql
set search_path = public, pg_temp
as $$
declare
  moved int := 0;
  r record;
begin
  for r in
    select id, contact_id, attempts, last_error
      from jobs
     where status = 'running'
       and coalesce(started_at, to_timestamp(0)) < now() - make_interval(mins => p_minutes)
     order by created_at
  loop
    begin
      if r.attempts >= 3 then
        update jobs
           set status = 'failed',
               last_error = case
                 when r.last_error is null or r.last_error = '' then 'stale worker: still running'
                 else r.last_error || ' | stale worker: still running'
               end
         where id = r.id;
      else
        update jobs
           set status = 'pending',
               started_at = null
         where id = r.id;
      end if;
      moved := moved + 1;
    exception when unique_violation then
      -- A sibling stale job for this contact already went back to pending in
      -- this same run. This one can never run (the claim guard blocks a
      -- second running job per contact), so fail it with the reason on it.
      update jobs
         set status = 'failed',
             last_error = case
               when r.last_error is null or r.last_error = '' then 'stale worker: duplicate running job for this contact'
               else r.last_error || ' | stale worker: duplicate running job for this contact'
             end
       where id = r.id;
      moved := moved + 1;
    end;
  end loop;
  return moved;
end $$;

revoke all on function requeue_stale_jobs(int) from public, anon, authenticated;
grant execute on function requeue_stale_jobs(int) to service_role;
