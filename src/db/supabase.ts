/**
 * Supabase clients.
 *
 * The SERVICE ROLE KEY IS SERVER-ONLY. It bypasses RLS, which means the server
 * code must filter by client_id itself (spec 1.5). Never import this module from
 * dashboard/front-end code, never log the key, never send it to a browser.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config.js';
import type { Client, ClientStats, Contact, Job } from './types.js';

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
