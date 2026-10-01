-- =============================================================================
-- 001_init.sql  -  human-runnable initial schema
--
-- HOW TO RUN (the human does this, not the AI):
--   1. Supabase dashboard -> your project -> SQL Editor -> New query
--   2. Paste this whole file -> Run
--   3. It is safe to run twice: every statement is guarded.
--   The service role key is NOT needed for this. You can close the .env file.
--
-- TENANCY RULE (spec 1.5 / 1.12): every table has client_id. The server uses the
-- service role, which bypasses RLS, so the server code must always filter by
-- client_id. RLS only protects dashboard users.
--   The two job queues (jobs, sheet_outbox) are the documented exception: a
--   worker queue is global by nature - a worker must be able to pick up any
--   client's next job. Each row still carries client_id, and every query that
--   reads or writes tenant data after the claim filters by client_id.
--
-- CHANGES vs the SQL in the spec, with the reason for each:
--   1. Idempotent guards (if not exists / drop policy if exists). A human
--      pasting into the SQL Editor will eventually run it twice; the spec's
--      version would fail on the second run.
--   2. Added index jobs_due - the claim_due_job() query has no supporting index.
--   3. Added index bookings_contact_upcoming - the confirmation lookup in spec
--      1.6A ("earliest upcoming booking for this contact") has no index.
--   4. set search_path on the three functions, so a tampered search_path
--      cannot hijack the table they write.
--   5. claim_due_job(): explicit "row deleted between SELECT and UPDATE"
--      handling, and a written contract for the empty case.
--   6. messages.seq: a monotonic identity column, because created_at alone is
--      millisecond-resolution and "inbound since the last outbound" (spec 1.8)
--      needs a total order for a burst of quick-fire messages.
--   NOT changed, because testing showed they are correct:
--   - client_stats() with zero bookings in the period (returns exactly one row
--     of zeros; verified on PostgreSQL 17).
--   - enqueue_reply_job() debounce: two calls for one contact leave ONE pending
--     job carrying the later run_at (verified).
--   - claim_due_job() SKIP LOCKED: a second claimer returns immediately instead
--     of blocking, and 12 simultaneous claimers got 12 distinct jobs (verified).
-- =============================================================================

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------- clients
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  phone_number_id text unique,          -- maps an inbound webhook -> client
  waba_id text,
  wa_token_enc text,                    -- AES-GCM encrypted by the app (null in demo mode)
  default_language text default 'hinglish',
  timezone text default 'Asia/Kolkata',
  plan text default 'starter',
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists client_users (   -- dashboard users <-> clients
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  primary key (user_id, client_id)
);

create table if not exists settings (
  client_id uuid primary key references clients(id) on delete cascade,
  bot_name text default 'Assistant',
  business_hours jsonb default '{"mon":["10:00","19:00"],"tue":["10:00","19:00"],"wed":["10:00","19:00"],"thu":["10:00","19:00"],"fri":["10:00","19:00"],"sat":["10:00","14:00"],"sun":null}',
  slot_minutes int default 30,
  max_voice_seconds int default 120,
  voice_replies_enabled boolean default false,
  confirm_template text default 'booking_confirmation',
  reminder_template text default 'appointment_reminder',
  template_language text default 'en',
  handover_chat_id text,                -- e.g. Telegram chat id for staff alerts
  sheet_id text,                        -- client's Google Sheet id (long id in the sheet URL)
  sheet_bookings_tab text default 'Bookings',
  sheet_leads_tab text default 'Leads'
);

create table if not exists knowledge (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('price','faq','timing','address','policy','service')),
  title text not null,
  content text not null,
  created_at timestamptz default now()
);
create index if not exists knowledge_client on knowledge (client_id);

-- -------------------------------------------------------------------- contacts
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  phone text not null,                  -- E.164 digits, no '+'
  name text,
  language text,
  consent_marketing boolean default false,
  consent_at timestamptz,
  bot_paused boolean default false,
  status text default 'new' check (status in ('new','hot','booked','needs_staff')),
  last_inbound_at timestamptz,
  created_at timestamptz default now(),
  unique (client_id, phone)
);

-- -------------------------------------------------------------------- messages
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  -- Monotonic per-table counter. created_at is only millisecond-resolution, so two
  -- quick-fire messages can share a timestamp; the worker needs a TOTAL order to
  -- answer "inbound messages since the last outbound message" (spec 1.8). This is
  -- the tie-break. Never insert into this column explicitly.
  seq bigint generated always as identity,
  client_id uuid not null references clients(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  wamid text,                           -- WhatsApp message id (dedupe key)
  direction text not null check (direction in ('in','out')),
  type text not null,                   -- text | audio | template | interactive | other
  text text,
  transcript text,
  status text,                          -- sent | delivered | read | failed
  created_at timestamptz default now(),
  -- NULL wamid rows do not collide (NULLs are distinct), so outbound rows
  -- without a wamid can never block a real inbound dedupe.
  unique (client_id, wamid)
);
create index if not exists messages_contact_created on messages (contact_id, seq desc);
create index if not exists messages_wamid on messages (wamid) where wamid is not null;

-- -------------------------------------------------------------------- bookings
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  service text,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  status text default 'pending' check (status in ('pending','confirmed','cancelled','reschedule_requested','no_show','done')),
  reminded_at timestamptz,
  confirmed_at timestamptz,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);
create index if not exists bookings_client_slot on bookings (client_id, slot_start);
-- Spec 1.6A: "the contact's earliest upcoming booking with status pending or
-- confirmed". This partial index serves exactly that lookup.
create index if not exists bookings_contact_upcoming on bookings (contact_id, slot_start)
  where status in ('pending', 'confirmed');

-- ---------------------------------------------------------------- message_log
create table if not exists message_log (   -- template sends, for billing/reporting
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  template_name text not null,
  category text check (category in ('utility','marketing','authentication')),
  est_cost numeric,
  sent_at timestamptz default now()
);
create index if not exists message_log_client_sent on message_log (client_id, sent_at desc);

-- ------------------------------------------------------------------- usage_log
create table if not exists usage_log (     -- AI + speech usage, monthly cost report
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null,                   -- llm | stt
  units numeric,                        -- tokens or seconds
  est_cost numeric,
  created_at timestamptz default now()
);
create index if not exists usage_log_client_created on usage_log (client_id, created_at desc);

-- ----------------------------------------------------------------------- jobs
create table if not exists jobs (          -- debounced "reply to this contact" jobs
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  run_at timestamptz not null,
  status text default 'pending' check (status in ('pending','running','done','failed')),
  attempts int default 0,
  last_error text,
  created_at timestamptz default now()
);
-- One pending job per contact, so a burst of messages debounces into one reply.
create unique index if not exists jobs_one_pending_per_contact on jobs (contact_id) where status = 'pending';
-- Supports claim_due_job(): status = 'pending' AND run_at <= now() ORDER BY run_at.
create index if not exists jobs_due on jobs (run_at) where status = 'pending';

-- -------------------------------------------------------------- booking_events
create table if not exists booking_events (  -- audit trail of every status change
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  booking_id uuid not null references bookings(id) on delete cascade,
  old_status text,
  new_status text not null,
  source text not null check (source in ('button','text','voice','staff','ai','system')),
  created_at timestamptz default now()
);
create index if not exists booking_events_booking on booking_events (booking_id, created_at desc);

-- ---------------------------------------------------------------- sheet_outbox
create table if not exists sheet_outbox (  -- pending writes to the client's Google Sheet
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  entity text not null check (entity in ('booking','contact')),
  entity_id uuid not null,
  status text default 'pending' check (status in ('pending','running','done','failed')),
  attempts int default 0,
  run_after timestamptz default now(),
  last_error text,
  created_at timestamptz default now()
);
create index if not exists sheet_outbox_due on sheet_outbox (status, run_after);

-- =============================================================================
-- functions
-- =============================================================================

-- Counts for the client: new leads and booking outcomes in a period [from, to).
-- Contract: ALWAYS returns exactly one row, even with no bookings and no
-- contacts in the period (all counts zero). The sheet Summary tab, the dashboard
-- and the summary script must all agree with this function.
create or replace function client_stats(p_client uuid, p_from timestamptz, p_to timestamptz)
returns table (leads bigint, bookings bigint, confirmed bigint, pending bigint,
               cancelled bigint, reschedule_requested bigint, no_show bigint)
language sql stable
set search_path = public, pg_temp
as $$
  select
    (select count(*) from contacts c
       where c.client_id = p_client and c.created_at >= p_from and c.created_at < p_to),
    count(*),
    count(*) filter (where b.status = 'confirmed'),
    count(*) filter (where b.status = 'pending'),
    count(*) filter (where b.status = 'cancelled'),
    count(*) filter (where b.status = 'reschedule_requested'),
    count(*) filter (where b.status = 'no_show')
  from bookings b
  where b.client_id = p_client and b.created_at >= p_from and b.created_at < p_to;
$$;

-- Debounce: every new inbound message pushes the pending job later.
-- Contract: after N calls for the same contact there is exactly ONE pending job
-- and its run_at is the latest requested time. If a pending job was already
-- claimed (status 'running'), a NEW pending job is created instead.
create or replace function enqueue_reply_job(p_client uuid, p_contact uuid, p_delay int)
returns void language sql
set search_path = public, pg_temp
as $$
  insert into jobs (client_id, contact_id, run_at)
  values (p_client, p_contact, now() + make_interval(secs => p_delay))
  on conflict (contact_id) where status = 'pending'
  do update set run_at = excluded.run_at;
$$;

-- Safe claim: two workers can never take the same job.
-- Contract: returns the claimed job with status 'running' and attempts+1, or a
-- row whose id is NULL when there is nothing due. Callers must check `id`,
-- never assume a non-null response means "there was a job".
--
-- p_client_id: pass the tenant you are working for and only that tenant's jobs
-- are considered, so a caller that already knows its client can never take
-- another client's work. NULL keeps the shared-queue behaviour for the Slice 4
-- poller, which has no client context of its own.
--
-- Both signatures are dropped first: CREATE OR REPLACE cannot change a
-- function's parameters, so replacing the old zero-argument version would leave
-- two overloads and PostgREST would then be unable to choose between them.
drop function if exists claim_due_job();
drop function if exists claim_due_job(uuid);

create or replace function claim_due_job(p_client_id uuid default null)
returns jobs language plpgsql
set search_path = public, pg_temp
as $$
declare
  j jobs;
begin
  select * into j from jobs
   where status = 'pending' and run_at <= now()
     and (p_client_id is null or client_id = p_client_id)
   order by run_at
   for update skip locked
   limit 1;
  if not found then
    return null;                        -- no id, so no job
  end if;

  update jobs set status = 'running', attempts = attempts + 1
   where id = j.id
   returning * into j;

  if not found then
    return null;                        -- row deleted between SELECT and UPDATE
  end if;
  return j;
end $$;

-- =============================================================================
-- Row Level Security: dashboard users only ever see their own client's rows.
-- The server (service role) bypasses RLS and must filter by client_id itself.
-- =============================================================================

alter table clients enable row level security;
alter table client_users enable row level security;

drop policy if exists "own_membership" on client_users;
create policy "own_membership" on client_users for select using (user_id = auth.uid());

drop policy if exists "own_client" on clients;
create policy "own_client" on clients for select
  using (id in (select client_id from client_users where user_id = auth.uid()));

do $$
declare t text;
begin
  foreach t in array array['settings','knowledge','contacts','messages','bookings','booking_events','message_log','usage_log','jobs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', 'tenant_select_' || t, t);
    execute format(
      'create policy %I on %I for select using (client_id in (select client_id from client_users where user_id = auth.uid()))',
      'tenant_select_' || t, t);
  end loop;
end $$;

-- Dashboard may toggle takeover and update bookings. `with check` stops a user
-- from moving a row to another client_id in the same UPDATE.
drop policy if exists "tenant_update_contacts" on contacts;
create policy "tenant_update_contacts" on contacts for update
  using (client_id in (select client_id from client_users where user_id = auth.uid()))
  with check (client_id in (select client_id from client_users where user_id = auth.uid()));

drop policy if exists "tenant_update_bookings" on bookings;
create policy "tenant_update_bookings" on bookings for update
  using (client_id in (select client_id from client_users where user_id = auth.uid()))
  with check (client_id in (select client_id from client_users where user_id = auth.uid()));

-- sheet_outbox is server-only: RLS on, no policies = dashboard users cannot read it
alter table sheet_outbox enable row level security;
