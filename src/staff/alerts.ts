/**
 * Staff alerts: the ONLY staff-alert channel (no Telegram, by decision).
 *
 * One interface, one implementation, deliberately narrow so another channel
 * (email, WhatsApp to the owner) can be added later without touching the
 * pipeline:
 *
 *   notify(clientId, kind, reason, refs?) -> { created: boolean }
 *
 * `kind` is open text ('handover' | 'job_failed' | 'daily_cap' today);
 * `reason` carries fixed strings and error summaries only, never customer
 * text; `refs` links the contact and/or job. Every call writes at most one
 * row: an open (unacknowledged) alert for the same (client, kind, contact,
 * job) suppresses repeats until acknowledged. A repeat after an acknowledge
 * creates a fresh row (re-arms).
 *
 * Exactly one error-level log line is written per CREATED alert, with ids
 * only: no phone numbers, names or message text. Repeats are silent (the
 * underlying condition already has its own log line at the call site).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { StaffAlertRow } from '../db/types.js';

export type AlertRefs = {
  contactId?: string;
  jobId?: string;
};

export type StaffNotifier = {
  notify(clientId: string, kind: string, reason: string, refs?: AlertRefs): Promise<{ created: boolean }>;
};

/**
 * Records the alert as a staff_alerts row (open-deduped) and logs one error
 * line when the row is new. Concurrent duplicates lose the race on the
 * partial unique index and report created:false instead of double-alerting.
 */
export function createDbNotifier(supabase: SupabaseClient, logger: Logger): StaffNotifier {
  return {
    async notify(clientId: string, kind: string, reason: string, refs: AlertRefs = {}): Promise<{ created: boolean }> {
      const contactId = refs.contactId ?? null;
      const jobId = refs.jobId ?? null;

      // .eq(col, null) never matches in PostgREST: nulls need .is().
      let lookup = supabase
        .from('staff_alerts')
        .select('id')
        .eq('client_id', clientId)
        .eq('kind', kind)
        .is('acknowledged_at', null)
        .limit(1);
      lookup = contactId === null ? lookup.is('contact_id', null) : lookup.eq('contact_id', contactId);
      lookup = jobId === null ? lookup.is('job_id', null) : lookup.eq('job_id', jobId);
      const { data: open, error: readError } = await lookup;
      if (readError) throw new Error(`staff alert lookup failed: ${readError.message}`);
      if ((open ?? []).length > 0) return { created: false };

      const { error: insertError } = await supabase.from('staff_alerts').insert({
        client_id: clientId,
        kind,
        reason: reason.slice(0, 500),
        contact_id: contactId,
        job_id: jobId,
      });
      if (insertError) {
        // Lost a race with a concurrent duplicate: the unique index did the
        // dedupe for us. Anything else is a real failure.
        if (insertError.code === '23505') return { created: false };
        throw new Error(`staff alert insert failed: ${insertError.message}`);
      }
      logger.error({ clientId, kind, reason, contactId, jobId }, 'staff alert recorded');
      return { created: true };
    },
  };
}

/** Open alert with tenant + contact context, for the alerts CLI and summaries. */
export type OpenAlert = StaffAlertRow & { business_name: string | null; contact_phone: string | null };

/** All unacknowledged alerts, newest first. Operator tool: service role. */
export async function listOpenAlerts(supabase: SupabaseClient): Promise<OpenAlert[]> {
  const { data, error } = await supabase
    .from('staff_alerts')
    .select('*, clients!inner(business_name), contacts(phone)')
    .is('acknowledged_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listOpenAlerts failed: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    ...(row as unknown as StaffAlertRow),
    business_name: ((row['clients'] as { business_name?: unknown } | null)?.business_name as string | null) ?? null,
    contact_phone: ((row['contacts'] as { phone?: unknown } | null)?.phone as string | null) ?? null,
  }));
}

/**
 * Acknowledges one alert by id (a unique leading prefix is enough).
 * Throws when nothing matches or the prefix is ambiguous.
 */
export async function acknowledgeAlert(supabase: SupabaseClient, idPrefix: string): Promise<OpenAlert> {
  const open = await listOpenAlerts(supabase);
  const normalized = idPrefix.toLowerCase();
  const rows = open.filter((r) => r.id.toLowerCase().startsWith(normalized));
  if (rows.length === 0) throw new Error(`no open alert starts with "${idPrefix}"`);
  if (rows.length > 1) throw new Error(`"${idPrefix}" matches ${rows.length} open alerts: be more specific`);
  const row = rows[0]!;
  const { error: updateError } = await supabase
    .from('staff_alerts')
    .update({ acknowledged_at: new Date().toISOString() })
    .eq('id', row.id);
  if (updateError) throw new Error(`acknowledgeAlert update failed: ${updateError.message}`);
  return {
    ...row,
    acknowledged_at: new Date().toISOString(),
  };
}
