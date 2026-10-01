/**
 * Supabase clients.
 *
 * The SERVICE ROLE KEY IS SERVER-ONLY. It bypasses RLS, which means the server
 * code must filter by client_id itself (spec 1.5). Never import this module from
 * dashboard/front-end code, never log the key, never send it to a browser.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config.js';
import type { Client, ClientStats, Contact, Job, Message } from './types.js';

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

/** Updates one message's delivery status. Returns false when the wamid is unknown. */
export async function updateMessageStatus(
  supabase: SupabaseClient,
  clientId: string,
  wamid: string,
  status: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('messages')
    .update({ status })
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
