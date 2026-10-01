# WhatsApp AI Agent (multi-tenant, India)

A WhatsApp AI receptionist for small businesses: text and voice notes in
Bengali / Hindi / English / Hinglish, answers only from the business knowledge
base, books appointments, sends reminders, hands over to a human.

Built from `AI_BUILD_SPEC_WhatsApp_Agent.md` (Part 1). Official WhatsApp/Cloud
API calls live in one adapter file (`src/whatsapp/client.ts`, Slice 3) so a Meta
API change touches one place.

## Requirements

- Node.js **20.19+** (tested on 22.x)
- A Supabase project (Slice 1)

## Setup

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Fill in `.env`. Rules enforced by `src/config.ts`:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are always required.
- A feature is ON only when its **whole** group of variables is present. Setting
  `LLM_API_KEY` without `LLM_PROVIDER` and `LLM_MODEL` is a startup error, not a
  warning. Optional groups: WhatsApp (`META_APP_SECRET`, `META_VERIFY_TOKEN`,
  `GRAPH_API_VERSION`), demo mode (`WA_PHONE_NUMBER_ID`, `WA_TOKEN`), LLM, STT,
  Google Sheets, Telegram.
- `NODE_ENV=production` additionally requires `PUBLIC_BASE_URL` and
  `ENCRYPTION_KEY` (`openssl rand -base64 32`).
- Missing or invalid variables are reported **all at once**, by name, with no
  secret values in the message.
- A variable left blank (`KEY=`) counts as **not set**, so a copied
  `.env.example` with only the database keys filled in starts cleanly.
- `GOOGLE_PRIVATE_KEY` must be on **one line** with `\n` escapes, the form
  Google documents: `"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"`.
  Surrounding quotes are stripped for you, and a key pasted as real newlines is
  rejected at startup instead of failing later inside the Google client.

**Never commit `.env`, never paste a secret into a chat.** `.env` is git-ignored.

`npm run env:check` prints only `set` / `empty` for every variable, so you can
confirm what is configured without exposing any value.

## Commands

| Command | What it does |
|---------|--------------|
| `npm test` | Runs the whole vitest suite (no network, no paid API) |
| `npm run test:watch` | Same, in watch mode |
| `npm run typecheck` | `tsc --noEmit` over src + tests + scripts |
| `npm run env:check` | Prints `set` / `empty` per variable, never a value |
| `npm run seed` | Creates the demo tenant, its settings and 5 knowledge rows |
| `npm run dev` | Starts the server with reload (`tsx watch`) |
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm start` | Runs the compiled server |

## Database (Slice 1)

The schema is plain SQL, applied **by hand** so nothing can run against your
production database unnoticed.

1. Supabase dashboard -> **SQL Editor** -> **New query**.
2. Paste the whole of `supabase/migrations/001_init.sql` and run it. It is
   idempotent, so re-running it is safe (and you should re-run it whenever the
   file changes).
3. Back in this folder:

```bash
npm run env:check      # confirm SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set
npm run seed
```

The seed prints the demo client's id, name and the number of knowledge rows. It
is safe to run again: the client is found by `phone_number_id` and the five
knowledge rows are updated in place, never duplicated.

Requires these variables in `.env`:

| Variable | Where to get it |
|----------|-----------------|
| `SUPABASE_URL` | Project Settings -> API -> Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings -> API -> service_role |
| `SUPABASE_ANON_KEY` | Project Settings -> API -> anon public key |

`SUPABASE_ANON_KEY` is used **only** by the RLS test, to prove that a logged-out
caller cannot read another tenant's data. Without it that test is skipped and
the rest of the suite still runs.

`tests/db/*.test.ts` run against the real database, so they are skipped (with a
printed reason) until the migration has been applied.

## Local smoke test

```bash
npm run dev
curl http://localhost:3000/healthz
```

`/healthz` returns `ok`, the environment, uptime and which features are enabled.
No secret is ever included in the response or in the logs: tokens, API keys and
phone numbers are redacted (`919812345678` -> `91********78`).

## Build status

| Slice | Build | State |
|-------|-------|-------|
| **0** | Scaffold, `config.ts`, `.env.example`, logging, vitest, `.gitignore` | **done** |
| **1** | Migration SQL, Supabase client, seed script, RLS test | **code done, awaiting the migration being run in Supabase** |
| 2 | Webhook GET/POST, signature verification, dedupe, `simulate-webhook.ts` | not started |
| 3 | WhatsApp client adapter (`sendText`, `markReadAndType`) | not started |
| 4 | Worker + debounce + LLM adapter + prompt + zod schema | not started |
| 5 | Voice notes: media download + STT adapter | not started |
| 6 | Human-like pacing | not started |
| 7 | Slots + bookings + confirmation | not started |
| 8 | Reminders job, `message_log`, quiet hours | not started |
| 8A | Confirmation replies (button / typed / voice) | not started |
| 8B | Google Sheet sync, `client_stats`, summary script | not started |
| 9 | Handover: `bot_paused`, staff alert, resume | not started |
| 10 | Template status handling, monthly usage report | not started |
| 11 (optional) | Dashboard (Next.js + Supabase Auth) | not started |

## Security notes for this slice

- Every log line passes through a redaction layer (credentials replaced with
  `[redacted]`, phone numbers masked). Covered by `tests/logger.test.ts`.
- Config errors never echo a value, only the variable name.
- `tests/config.test.ts` asserts that `.env.example` documents every variable
  the code reads, that it documents nothing unknown, and that no credential in
  it has a value.
- No global body parser is installed: the webhook route (Slice 2) needs the raw
  body for `X-Hub-Signature-256`.
- Multi-tenancy starts in Slice 1: `client_id` on every tenant table and on every
  query in `db/supabase.ts`, plus row-level security policies in the migration and
  a two-user test that proves one tenant cannot read or write another's rows.
- `client_stats` and `claim_due_job` are the two functions a worker must call
  instead of a plain `select`, so a missing tenant scope cannot become a silent
  data leak. `claim_due_job(client_id)` claims only that tenant's work; called
  with no argument it claims from the shared queue with `FOR UPDATE SKIP LOCKED`,
  which is what the Slice 4 poller needs since it has no tenant of its own.
  Every other statement filters by `client_id`.

## Dependencies (and why)

| Package | Why |
|---------|-----|
| `express` | HTTP server for the webhook and `/healthz` |
| `pino` | Fast structured JSON logs with built-in redaction |
| `zod` | Validates `.env` and (from Slice 4) the AI's JSON output |
| `@supabase/supabase-js` | Official PostgREST + Auth client: reads/writes rows, calls `rpc()` for the SQL functions, and creates the two test users used by the RLS test |
| `typescript`, `tsx`, `vitest`, `@types/*` (dev) | Compile, run, and test |

No WhatsApp, LLM, speech or Google client library is installed yet: each one
arrives with the slice that needs it, behind an adapter interface.
