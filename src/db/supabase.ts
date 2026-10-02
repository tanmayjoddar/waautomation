/**
 * Supabase clients.
 *
 * The SERVICE ROLE KEY IS SERVER-ONLY. It bypasses RLS, which means the server
 * code must filter by client_id itself (spec 1.5). Never import this module from
 * dashboard/front-end code, never log the key, never send it to a browser.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config.js';
import type { Client, ClientStats, Contact, Job, Knowledge, Message, Settings } from './types.js';

/**
 * Service-role client for the server and for scripts/tests.
 * No session is persisted: this process is a machine, not a user.
 */
export function createServiceClient(config: AppConfig): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Anon client, used by the RLS test to prove that a logged-in dashboard user
 * cannot read another tenant's rows. Requires SUPABASE_ANON_KEY.
 */
export function createAnonClient(config: AppConfig): SupabaseClient | null {
  if (!config.supabase.anonKey) return null;
  return createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * findClientByPhoneNumberId: maps an inbound webhook to a tenant.
 * Every call site is responsible for handling null (unknown id: log and ignore).
 */
export async function findClientByPhoneNumberId(
  supabase: SupabaseClient,
  phoneNumberId: string,
): Promise<Client | null> {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();
  if (error) throw new Error(`findClientByPhoneNumberId failed: ${error.message}`);
  return (data as Client | null) ?? null;
}

/**
 * claimDueJob: calls the claim_due_job() SQL function.
 *
 * Pass `clientId` whenever the caller already knows its tenant: the function
 * then only considers that tenant's jobs, so a worker can never pick up another
 * client's work and tests do not depend on what else is in the queue. `null`
 * keeps the shared-queue behaviour for the Slice 4 poller.
 *
 * The function returns a row whose `id` is NULL when there was nothing to do, so
 * the id is checked here and the caller gets a plain null instead. Verified
 * behaviour: two workers can never receive the same job (SKIP LOCKED).
 */
export async function claimDueJob(
  supabase: SupabaseClient,
  clientId: string | null = null,
): Promise<Job | null> {
  const { data, error } = await supabase.rpc('claim_due_job', { p_client_id: clientId });
  if (error) throw new Error(`claim_due_job failed: ${error.message}`);
  const job = (data ?? null) as Job | null;
  if (!job || !job.id) return null;
  return job;
}

/** client_stats(client, from, to): always exactly one row, zeros included. */
export async function getClientStats(
  supabase: SupabaseClient,
  clientId: string,
  from: string,
  to: string,
): Promise<ClientStats> {
  const { data, error } = await supabase.rpc('client_stats', {
    p_client: clientId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`client_stats failed: ${error.message}`);
  const rows = (data ?? []) as ClientStats[];
  if (rows.length !== 1) throw new Error(`client_stats returned ${rows.length} rows, expected 1`);
  return rows[0] as ClientStats;
}

/** enqueue_reply_job(client, contact, delaySeconds): the debounce. */
export async function enqueueReplyJob(
  supabase: SupabaseClient,
  clientId: string,
  contactId: string,
  delaySeconds: number,
): Promise<void> {
  const { error } = await supabase.rpc('enqueue_reply_job', {
    p_client: clientId,
    p_contact: contactId,
    p_delay: delaySeconds,
  });
  if (error) throw new Error(`enqueue_reply_job failed: ${error.message}`);
}

/**
 * upsertContact: find-or-create a contact for this client.
 * Scoped by client_id on purpose: the same phone number can be a different
 * contact for two different clients.
 */
export async function upsertContact(
  supabase: SupabaseClient,
  clientId: string,
  phone: string,
  patch: Partial<Pick<Contact, 'name' | 'language' | 'last_inbound_at' | 'status'>> = {},
): Promise<Contact> {
  const { data, error } = await supabase
    .from('contacts')
    .upsert(
      { client_id: clientId, phone, ...patch },
      { onConflict: 'client_id,phone', ignoreDuplicates: false },
    )
    .select('*')
    .single();
  if (error) throw new Error(`upsertContact failed: ${error.message}`);
  return data as Contact;
}

/**
 * findOrCreateContact: like upsertContact, but also reports whether the contact
 * is new, because the spec only queues a sheet_outbox row for a first contact.
 *
 * Two steps instead of one upsert so that `created` is trustworthy. The insert
 * still uses ignoreDuplicates, so two concurrent deliveries of the same message
 * cannot turn into a unique-violation crash.
 */
export async function findOrCreateContact(
  supabase: SupabaseClient,
  clientId: string,
  phone: string,
  patch: Partial<Pick<Contact, 'name' | 'last_inbound_at'>> = {},
): Promise<{ contact: Contact; created: boolean }> {
  const { data: existing, error: readError } = await supabase
    .from('contacts')
    .select('*')
    .eq('client_id', clientId)
    .eq('phone', phone)
    .maybeSingle();
  if (readError) throw new Error(`findOrCreateContact lookup failed: ${readError.message}`);

  if (existing) {
    const contact = existing as Contact;
    const { data, error } = await supabase
      .from('contacts')
      .update(patch)
      .eq('id', contact.id)
      .eq('client_id', clientId)
      .select('*')
      .single();
    if (error) throw new Error(`findOrCreateContact update failed: ${error.message}`);
    return { contact: data as Contact, created: false };
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert({ client_id: clientId, phone, ...patch })
    .select('*')
    .single();
  if (!error && data) return { contact: data as Contact, created: true };

  // Lost a race with a concurrent delivery: the row exists, so take the slow path.
  if (error?.code !== '23505') {
    throw new Error(`findOrCreateContact insert failed: ${error?.message ?? 'unknown error'}`);
  }
  const { data: raced, error: readAgain } = await supabase
    .from('contacts')
    .select('*')
    .eq('client_id', clientId)
    .eq('phone', phone)
    .single();
  if (readAgain) throw new Error(`findOrCreateContact re-read failed: ${readAgain.message}`);
  return { contact: raced as Contact, created: false };
}

/** True when this wamid is already stored for this client: a duplicate delivery. */
export async function messageAlreadyStored(
  supabase: SupabaseClient,
  clientId: string,
  wamid: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('client_id', clientId)
    .eq('wamid', wamid)
    .limit(1);
  if (error) throw new Error(`messageAlreadyStored failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * insertInboundMessage: stores one inbound message.
 *
 * Returns null when the row already exists. The unique (client_id, wamid)
 * constraint is the authority here, not the caller's check, so two concurrent
 * deliveries of the same message cannot both be stored (spec 1.6 step 4).
 */
export async function insertInboundMessage(
  supabase: SupabaseClient,
  row: {
    clientId: string;
    contactId: string;
    wamid: string;
    type: Message['type'];
    text: string | null;
    mediaId?: string | null;
    at: string;
  },
): Promise<Message | null> {
  // ignoreDuplicates turns the unique (client_id, wamid) violation into "no rows
  // returned" instead of an error, which is exactly the duplicate signal wanted,
  // and it is atomic: two concurrent deliveries cannot both insert.
  const { data, error } = await supabase
    .from('messages')
    .upsert(
      {
        client_id: row.clientId,
        contact_id: row.contactId,
        wamid: row.wamid,
        direction: 'in',
        type: row.type,
        text: row.text,
        media_id: row.mediaId ?? null,
        created_at: row.at,
      },
      { onConflict: 'client_id,wamid', ignoreDuplicates: true },
    )
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`insertInboundMessage failed: ${error.message}`);
  return (data as Message | null) ?? null;
}

/**
 * Updates one message's delivery status. Returns false when the wamid is unknown.
 *
 * When the status carries Meta's failure reason (migration 002), the reason is
 * persisted on the row alongside the status. It is written ONLY on failure and
 * never cleared: statuses can arrive out of order, and a later event must not
 * erase the record of the earlier failure. messages.status stays the current
 * state; meta_error_* is the failure record.
 */
export async function updateMessageStatus(
  supabase: SupabaseClient,
  clientId: string,
  wamid: string,
  status: string,
  failure?: { code: number | null; title: string | null; message: string | null },
): Promise<boolean> {
  const patch: Record<string, unknown> = { status };
  if (failure && failure.code !== null) {
    patch.meta_error_code = failure.code;
    patch.meta_error_title = failure.title;
    patch.meta_error_message = failure.message;
  }
  const { data, error } = await supabase
    .from('messages')
    .update(patch)
    .eq('client_id', clientId)
    .eq('wamid', wamid)
    .select('id');
  if (error) throw new Error(`updateMessageStatus failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Queues a new contact for the client's Google Sheet (Slice 8B drains this). */
export async function queueSheetContact(
  supabase: SupabaseClient,
  clientId: string,
  contactId: string,
): Promise<void> {
  const { error } = await supabase.from('sheet_outbox').insert({
    client_id: clientId,
    entity: 'contact',
    entity_id: contactId,
  });
  if (error) throw new Error(`queueSheetContact failed: ${error.message}`);
}

/* -------------------------------------------------------------------------- */
/* Slice 4 worker helpers. Every read/write below is scoped by client_id       */
/* (or contact_id within a known client), except claimDueJob/requeueStaleJobs, */
/* which are the documented global-queue exceptions.                           */
/* -------------------------------------------------------------------------- */

/** Marks a finished job done. */
export async function markJobDone(supabase: SupabaseClient, jobId: string): Promise<void> {
  const { error } = await supabase.from('jobs').update({ status: 'done' }).eq('id', jobId);
  if (error) throw new Error(`markJobDone failed: ${error.message}`);
}

/**
 * Records a job failure. attempts was already incremented at claim time:
 * attempts >= 3 exhausts the retries (failed + last_error), otherwise the job
 * goes back to pending with run_at pushed out as backoff (30s per attempt).
 */
export async function failJob(supabase: SupabaseClient, job: Job, errorMessage: string): Promise<'retried' | 'failed'> {
  if (job.attempts >= 3) {
    const { error } = await supabase.from('jobs').update({ status: 'failed', last_error: errorMessage }).eq('id', job.id);
    if (error) throw new Error(`failJob failed: ${error.message}`);
    return 'failed';
  }
  const backoffSeconds = 30 * job.attempts;
  const { error } = await supabase
    .from('jobs')
    .update({ status: 'pending', started_at: null, last_error: errorMessage, run_at: new Date(Date.now() + backoffSeconds * 1000).toISOString() })
    .eq('id', job.id);
  if (error) throw new Error(`failJob failed: ${error.message}`);
  return 'retried';
}

/**
 * Records a terminal job failure immediately, without backoff or retries.
 * For permanent errors only (no token, revoked client, deleted or paused
 * contact): retrying cannot help, so attempts are left untouched and the job
 * goes straight to failed with the reason on it.
 */
export async function failJobPermanent(supabase: SupabaseClient, job: Job, errorMessage: string): Promise<void> {
  const { error } = await supabase.from('jobs').update({ status: 'failed', last_error: errorMessage }).eq('id', job.id);
  if (error) throw new Error(`failJobPermanent failed: ${error.message}`);
}

/** requeue_stale_jobs(): returns how many running jobs went back to pending/failed. */
export async function requeueStaleJobs(supabase: SupabaseClient, minutes: number): Promise<number> {
  const { data, error } = await supabase.rpc('requeue_stale_jobs', { p_minutes: minutes });
  if (error) throw new Error(`requeue_stale_jobs failed: ${error.message}`);
  return (data ?? 0) as number;
}

/** Already-sent parts of a job, oldest first. A retry resumes from these. */
export async function listJobParts(supabase: SupabaseClient, jobId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('job_id', jobId)
    .order('part_index');
  if (error) throw new Error(`listJobParts failed: ${error.message}`);
  return (data ?? []) as Message[];
}

/**
 * Inserts one reply part tagged with (job_id, part_index). Idempotent: the
 * partial unique index makes a re-insert of the same part a no-op that returns
 * the existing row, so a retried job never duplicates a part.
 */
export async function insertJobPart(
  supabase: SupabaseClient,
  row: { clientId: string; contactId: string; jobId: string; partIndex: number; text: string },
): Promise<{ message: Message; created: boolean }> {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      client_id: row.clientId,
      contact_id: row.contactId,
      wamid: null,
      direction: 'out',
      type: 'text',
      text: row.text,
      job_id: row.jobId,
      part_index: row.partIndex,
    })
    .select('*')
    .maybeSingle();
  if (error && error.code !== '23505') throw new Error(`insertJobPart failed: ${error.message}`);
  if (!error && data) return { message: data as Message, created: true };
  const { data: existing, error: readError } = await supabase
    .from('messages')
    .select('*')
    .eq('job_id', row.jobId)
    .eq('part_index', row.partIndex)
    .single();
  if (readError) throw new Error(`insertJobPart re-read failed: ${readError.message}`);
  return { message: existing as Message, created: false };
}

/** Records Meta's wamid once a part is sent. */
export async function setJobPartWamid(supabase: SupabaseClient, messageId: string, wamid: string): Promise<void> {
  const { error } = await supabase.from('messages').update({ wamid }).eq('id', messageId);
  if (error) throw new Error(`setJobPartWamid failed: ${error.message}`);
}

/** Scoped contact read: id AND client_id, so a job can never load another tenant's contact. */
export async function loadContact(supabase: SupabaseClient, clientId: string, contactId: string): Promise<Contact | null> {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw new Error(`loadContact failed: ${error.message}`);
  return (data as Contact | null) ?? null;
}

/** Scoped contact patch (handover flags, name/language learning). */
export async function updateContact(
  supabase: SupabaseClient,
  clientId: string,
  contactId: string,
  patch: Partial<Pick<Contact, 'bot_paused' | 'status' | 'name' | 'language'>>,
): Promise<Contact> {
  const { data, error } = await supabase
    .from('contacts')
    .update(patch)
    .eq('id', contactId)
    .eq('client_id', clientId)
    .select('*')
    .single();
  if (error) throw new Error(`updateContact failed: ${error.message}`);
  return data as Contact;
}

/** Client + settings + knowledge, all for one tenant. */
export async function loadClientBundle(
  supabase: SupabaseClient,
  clientId: string,
): Promise<{ client: Client | null; settings: Settings | null; knowledge: Knowledge[] }> {
  const { data: client, error: clientError } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
  if (clientError) throw new Error(`loadClientBundle client failed: ${clientError.message}`);
  const { data: settings, error: settingsError } = await supabase.from('settings').select('*').eq('client_id', clientId).maybeSingle();
  if (settingsError) throw new Error(`loadClientBundle settings failed: ${settingsError.message}`);
  const { data: knowledge, error: knowledgeError } = await supabase.from('knowledge').select('*').eq('client_id', clientId);
  if (knowledgeError) throw new Error(`loadClientBundle knowledge failed: ${knowledgeError.message}`);
  return { client: (client as Client | null) ?? null, settings: (settings as Settings | null) ?? null, knowledge: (knowledge ?? []) as Knowledge[] };
}

/** Messages of one contact, oldest first (history + unanswered computation). */
export async function listContactMessages(supabase: SupabaseClient, clientId: string, contactId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .order('seq');
  if (error) throw new Error(`listContactMessages failed: ${error.message}`);
  return (data ?? []) as Message[];
}

/** Inbound messages for a contact since an ISO instant (rate-limit window). */
export async function countRecentInbound(
  supabase: SupabaseClient,
  clientId: string,
  contactId: string,
  sinceIso: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .eq('direction', 'in')
    .gte('created_at', sinceIso);
  if (error) throw new Error(`countRecentInbound failed: ${error.message}`);
  return count ?? 0;
}

/** LLM calls for a client since a UTC-midnight ISO instant (daily cap). */
export async function countLlmCallsSince(
  supabase: SupabaseClient,
  clientId: string,
  sinceIso: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('kind', 'llm')
    .gte('created_at', sinceIso);
  if (error) throw new Error(`countLlmCallsSince failed: ${error.message}`);
  return count ?? 0;
}

/** LLM token units for a client since an ISO instant (daily token cap). */
export async function sumLlmUnitsSince(
  supabase: SupabaseClient,
  clientId: string,
  sinceIso: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('usage_log')
    .select('units')
    .eq('client_id', clientId)
    .eq('kind', 'llm')
    .gte('created_at', sinceIso);
  if (error) throw new Error(`sumLlmUnitsSince failed: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number((row as { units: unknown }).units ?? 0), 0);
}

/** True when this contact recently got exactly this outbound text (notice/fallback dedupe). */
export async function recentOutboundWithText(
  supabase: SupabaseClient,
  clientId: string,
  contactId: string,
  text: string,
  sinceIso: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .eq('direction', 'out')
    .eq('text', text)
    .gte('created_at', sinceIso)
    .limit(1);
  if (error) throw new Error(`recentOutboundWithText failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** usage_log write (kind llm | stt). Units are tokens (llm) or seconds (stt). */
export async function writeUsageLog(
  supabase: SupabaseClient,
  row: { clientId: string; kind: 'llm' | 'stt'; units: number; estCost: number | null },
): Promise<void> {
  const { error } = await supabase.from('usage_log').insert({
    client_id: row.clientId,
    kind: row.kind,
    units: row.units,
    est_cost: row.estCost,
  });
  if (error) throw new Error(`writeUsageLog failed: ${error.message}`);
}

/**
 * insertOutboundMessage: stores a message WE sent (Slice 3 echo, Slice 4+
 * worker replies) with the wamid Meta returned, so later status webhooks can
 * update it via updateMessageStatus.
 *
 * A plain insert, deliberately NOT an upsert: a fresh Meta wamid must never
 * collide, and a 23505 here means something is deeply wrong and must surface
 * instead of being silently swallowed as a "duplicate".
 */
export async function insertOutboundMessage(
  supabase: SupabaseClient,
  row: {
    clientId: string;
    contactId: string;
    wamid: string;
    type: Message['type'];
    text: string | null;
  },
): Promise<Message> {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      client_id: row.clientId,
      contact_id: row.contactId,
      wamid: row.wamid,
      direction: 'out',
      type: row.type,
      text: row.text,
    })
    .select('*')
    .single();
  if (error) throw new Error(`insertOutboundMessage failed: ${error.message}`);
  return data as Message;
}
