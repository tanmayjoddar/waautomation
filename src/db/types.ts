/**
 * Row shapes for the tables in supabase/migrations/001_init.sql.
 *
 * These are the compile-time contract only. PostgREST returns whatever is in
 * the database, so every read still needs a runtime check where the value is
 * used for a decision (Slice 2+). Keep this file in sync with the migration.
 */

export type Client = {
  id: string;
  business_name: string;
  phone_number_id: string | null;
  waba_id: string | null;
  wa_token_enc: string | null;
  default_language: string;
  timezone: string;
  plan: string;
  active: boolean;
  created_at: string;
};

export type ClientUser = {
  user_id: string;
  client_id: string;
};

export type Settings = {
  client_id: string;
  bot_name: string;
  /** `{ mon: ["10:00","19:00"], ..., sun: null }`; read by services/slots.ts. */
  business_hours: Record<string, [string, string] | null> | null;
  slot_minutes: number;
  max_voice_seconds: number;
  voice_replies_enabled: boolean;
  confirm_template: string;
  reminder_template: string;
  template_language: string;
  handover_chat_id: string | null;
  sheet_id: string | null;
  sheet_bookings_tab: string;
  sheet_leads_tab: string;
};

export type KnowledgeKind = 'price' | 'faq' | 'timing' | 'address' | 'policy' | 'service';

export type Knowledge = {
  id: string;
  client_id: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  created_at: string;
};

export type ContactStatus = 'new' | 'hot' | 'booked' | 'needs_staff';

export type Contact = {
  id: string;
  client_id: string;
  phone: string;
  name: string | null;
  language: string | null;
  consent_marketing: boolean;
  consent_at: string | null;
  bot_paused: boolean;
  status: ContactStatus;
  last_inbound_at: string | null;
  created_at: string;
};

export type MessageType = 'text' | 'audio' | 'template' | 'interactive' | 'other';

export type Message = {
  id: string;
  /** Monotonic insertion order. See the comment in 001_init.sql. */
  seq: number;
  client_id: string;
  contact_id: string;
  wamid: string | null;
  direction: 'in' | 'out';
  type: MessageType;
  text: string | null;
  /** Meta's media id for audio; Slice 5 downloads it from this. */
  media_id: string | null;
  transcript: string | null;
  status: string | null;
  created_at: string;
};

export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'reschedule_requested'
  | 'no_show'
  | 'done';

export type Booking = {
  id: string;
  client_id: string;
  contact_id: string;
  service: string | null;
  slot_start: string;
  slot_end: string;
  status: BookingStatus;
  reminded_at: string | null;
  confirmed_at: string | null;
  updated_at: string;
  created_at: string;
};

export type BookingEvent = {
  id: string;
  client_id: string;
  booking_id: string;
  old_status: string | null;
  new_status: string;
  source: 'button' | 'text' | 'voice' | 'staff' | 'ai' | 'system';
  created_at: string;
};

export type Job = {
  id: string;
  client_id: string;
  contact_id: string;
  run_at: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: string;
};

export type SheetOutbox = {
  id: string;
  client_id: string;
  entity: 'booking' | 'contact';
  entity_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  run_after: string;
  last_error: string | null;
  created_at: string;
};

/** Row shape returned by client_stats(client, from, to). */
export type ClientStats = {
  leads: number;
  bookings: number;
  confirmed: number;
  pending: number;
  cancelled: number;
  reschedule_requested: number;
  no_show: number;
};
