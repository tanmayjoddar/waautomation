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
| `npm run simulate:webhook` | Sends signed sample deliveries (text, audio, button, interactive, status) to a running server |
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

`SUPABASE_ANON_KEY` is used **only** by the RLS and function-privilege tests, to
prove that a logged-out caller cannot read another tenant's data and cannot call
the queue functions. If the key is missing, or if Supabase rejects it ("Invalid
API key"), those tests are **skipped with that reason printed** rather than
failed: a stale key is refused by the API gateway before Postgres ever sees a
function call, so "refused" would prove nothing about privileges. Copy the current
anon (or publishable) key from Project Settings -> API whenever Supabase rotates
keys.

`tests/db/*.test.ts` run against the real database, so they are skipped (with a
printed reason) until the migration has been applied.

## Webhook (Slice 2)

Meta posts to `POST /webhook` and verifies the URL with `GET /webhook`. Start the
server, then drive it without Meta:

```bash
npm run dev                                        # terminal 1
npm run simulate:webhook                           # terminal 2
npm run simulate:webhook -- --url https://host/webhook
```

The simulator signs every request with `META_APP_SECRET` exactly the way Meta does
(`sha256=` + HMAC-SHA256 over the exact bytes sent), then finishes with a request
signed with the **wrong** secret, which the server must refuse with 401. Samples
cover text, a voice note, a template button tap, an interactive reply, delivery
statuses, one payload containing several entries / changes / messages, a message
for an unknown `phone_number_id`, and an unsupported type. Re-running it is a
duplicate delivery, which is how you watch the dedupe path work.

Needs `META_APP_SECRET`, `META_VERIFY_TOKEN` and `GRAPH_API_VERSION` in `.env`;
without them the simulator signs with a placeholder secret and skips the GET
handshake. `WA_PHONE_NUMBER_ID` sets which tenant the samples are routed to (it
must match the `phone_number_id` of the seeded client).

How the route behaves:

| Request | Answer |
|---------|--------|
| `GET /webhook` with the right token | 200, the challenge echoed as **plain text** |
| `GET /webhook` wrong token / missing / duplicated challenge | 403 |
| `POST /webhook` valid signature | **200 first**, then the work runs in the background |
| `POST /webhook` missing / malformed / wrong signature | 401, nothing is stored |
| `POST /webhook` empty body | 400 |
| `POST /webhook` while `META_*` is unset | 503 |

Meta retries anything that answers too slowly, and a retry is a duplicate
delivery, so the 200 must not wait for the database. Duplicates are caught by the
`unique (client_id, wamid)` constraint, which is the authority: a repeated
delivery stores no second row and triggers no job, hook or sheet row. A
`phone_number_id` that matches no client is logged and ignored (another business
on the same WABA), never used to create a tenant.

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
| **1** | Migration SQL, Supabase client, seed script, RLS and function tests | **done** (88 tests green against a real project) |
| **2** | Webhook GET/POST, signature verification, dedupe, `simulate-webhook.ts` | **done** (code done; the live suites need the updated migration re-run) |
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
- No global body parser is installed: the webhook route mounts its own
  `express.raw` for `/webhook`, because `X-Hub-Signature-256` is computed over the
  exact bytes Meta sent and a JSON body parser would consume them.
- The signature is compared with `crypto.timingSafeEqual`, and a missing or
  malformed header is refused rather than skipped.
- Multi-tenancy starts in Slice 1: `client_id` on every tenant table and on every
  query in `db/supabase.ts`, plus row-level security policies in the migration and
  a two-user test that proves one tenant cannot read or write another's rows.
- `claim_due_job`, `enqueue_reply_job` and `client_stats` are the functions the
  server calls instead of plain selects, so a missing tenant scope cannot become a
  silent data leak. `claim_due_job(client_id)` claims only that tenant's work;
  called with no argument it claims from the shared queue with
  `FOR UPDATE SKIP LOCKED`, which is what the Slice 4 poller needs since it has no
  tenant of its own. Every other statement filters by `client_id`.
- Postgres grants `EXECUTE` on a new function to `PUBLIC`, and Supabase's `anon`
  and `authenticated` roles are members of `PUBLIC`. The migration therefore ends
  with an explicit `REVOKE ... FROM public, anon, authenticated` and grants only
  what each role needs: the queue functions to `service_role`, `client_stats` to
  `service_role` and `authenticated` (the dashboard reads it; it is
  `SECURITY INVOKER`, so RLS still limits it to the caller). `tests/db/privileges.test.ts`
  proves the refusals live, and that an unusable anon key skips loudly instead of
  proving nothing.
- The webhook logs ids, types and counts only: never a customer phone number and
  never message text. A test asserts a distinctive body of customer text and a
  real-looking phone number are both absent from the captured log.

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
