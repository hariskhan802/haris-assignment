# FinChat — AI-Powered Financial Chat Application

A ChatGPT-style chat interface for simple financial questions. An LLM understands the
request and picks a backend function; **the backend performs every calculation**. The
model never produces a financial figure of its own.


```
User message
  → LLM detects intent + extracts parameters   (Gemini function calling)
  → Backend validates the parameters           (Zod schemas + domain rules)
  → Database provides stored information       (PostgreSQL product catalogue)
  → Backend financial formula calculates       (financial.service.ts)
  → LLM explains the verified result           (second Gemini call)
  → Turn persisted                             (messages table)
```

**Stack:** React 18 + TypeScript (Vite) · Node 22 + Express + TypeScript · PostgreSQL 16 (Docker) · Google Gemini (function calling)

---

## 1. Setup

### Prerequisites

- Node.js 20+ (developed on 22)
- Docker Desktop (for PostgreSQL)
- A **free** Gemini API key from <https://aistudio.google.com/apikey>

### Steps

```bash
# 1. Start PostgreSQL (host port 5433, so it will not clash with a local 5432)
docker compose up -d

# 2. Backend
cd server
npm install
cp .env.example .env          # Windows PowerShell: copy .env.example .env
#    -> open .env and paste your key into GEMINI_API_KEY
npm run db:setup              # runs migrations, then seeds the product catalogue
npm run dev                   # http://localhost:4400

# 3. Frontend (in a second terminal)
cd client
npm install
npm run dev                   # http://localhost:5173
```

Open <http://localhost:5173>.

### Troubleshooting

**`The configured model "…" is not available to this API key`** — Google retires models
for newly created keys even while they still appear in `ListModels`. `GEMINI_MODEL`
defaults to the rolling alias `gemini-flash-lite-latest` for that reason. To see what
your key can actually reach:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"
```

**`The Gemini API rate limit was reached`** — the free tier allows only a handful of
requests per minute, and **one chat turn costs two model calls** (one to pick the tool,
one to explain the result). Wait the number of seconds reported, or use `LLM_PROVIDER=mock`.

**`EADDRINUSE`** — change `PORT` in `server/.env` and the proxy target in
`client/vite.config.ts` to match.

### Running without an API key

Set `LLM_PROVIDER=mock` in `server/.env`. This swaps in an offline, rule-based test
double that implements the same `LlmProvider` interface, so the full request path —
tool selection, validation, DB lookup, formulas, persistence — runs with no network
call. It is a development and testing aid only; the real integration is Gemini.

### Other commands

```bash
cd server
npm test          # unit tests for the financial formulas
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/
```

---

## 2. Architecture

Full write-up in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Short version:

```
client/                       React chat UI (message list, input, loading, errors)
server/src/
  routes/chat.routes.ts       HTTP layer: validate body, load history, persist turn
  llm/
    provider.ts               Vendor-neutral LlmProvider interface + system prompt
    gemini.provider.ts        Google Gemini implementation
    mock.provider.ts          Offline test double
    tools.ts                  Tool registry: JSON Schema + Zod + executor per tool
    orchestrator.ts           The LLM <-> backend tool loop
  services/
    financial.service.ts      calculateCompoundInterest / calculateLoanPayment
    product.service.ts        getFinancialProduct / listFinancialProducts
    conversation.service.ts   saveTurn / getMessages (transactional)
  db/                         pool, migrations, migration runner, seed
```

### Division of responsibility

| The LLM does | The backend does |
| --- | --- |
| Understand natural language | Validate every parameter |
| Detect intent | Read the database |
| Extract parameters | Apply the financial formulas |
| Choose the backend function | Own the trusted result |
| Explain the verified result | Handle and shape errors |

### The four guarantees that keep the LLM out of the maths

1. **The model has no way to answer with a number it invented.** It can only emit a
   function call; the numbers in the final reply come from a tool result that is already
   in its context.
2. **Tool arguments are untrusted input.** Every argument is re-validated with Zod, then
   again by domain guards in `financial.service.ts` (positive principal, sane term, rate
   expressed as a percentage, allowed compounding frequency).
3. **The database wins over the model.** If a tool call includes a `productName`, the
   backend fetches the rate from PostgreSQL and **discards** any `annualRatePercent` the
   model sent alongside it. That is what makes "using the stored interest rate" safe.
4. **Failures go back to the model as data, not as exceptions.** A validation error is
   returned as `{ ok: false, error }` so the assistant asks the user a follow-up question
   instead of the request 500-ing.

---

## 3. Database

Schema: [server/src/db/migrations/001_init.sql](server/src/db/migrations/001_init.sql).
Applied by a small forward-only runner (`npm run db:migrate`) that records each file in
`schema_migrations` and runs it in a transaction.

**`financial_products`** — the product catalogue and the source of truth for stored rates.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `SERIAL PK` | |
| `name` | `TEXT UNIQUE` | e.g. `Home Loan` |
| `product_type` | `TEXT` | `loan` \| `savings` \| `investment` (CHECK) |
| `annual_interest_rate` | `NUMERIC(6,3)` | stored as a **percentage**: `6.500` = 6.5% |
| `min_term_years`, `max_term_years` | `INTEGER` | business rules enforced on calculation |
| `description` | `TEXT` | |

**`conversations`** — one chat thread (`id UUID`, `title`, `created_at`, `updated_at`).

**`messages`** — required conversation storage.

| Column | Type | Notes |
| --- | --- | --- |
| `conversation_id` | `UUID FK` | `ON DELETE CASCADE` |
| `role` | `TEXT` | `user` \| `assistant` |
| `content` | `TEXT` | the user message / the assistant response |
| `calculation_type` | `TEXT` | `compound_interest` \| `loan_payment` \| `NULL` |
| `calculation_result` | `NUMERIC(18,2)` | the headline figure |
| `calculation_details` | `JSONB` | full audit trail: inputs, outputs, rate source, product |
| `created_at` | `TIMESTAMPTZ` | timestamp |

A CHECK constraint (`calc_only_on_assistant`) makes it impossible to attach calculation
output to a user message.

Seed data (`npm run db:seed`, idempotent): Home Loan 6.5%, Auto Loan 8.25%,
Personal Loan 12%, High Yield Savings 4.25%, Fixed Deposit 7%.

---

## 4. Financial formulas

Both live in [server/src/services/financial.service.ts](server/src/services/financial.service.ts)
and are covered by unit tests in `server/tests/financial.test.ts`.

**Compound interest**

```
A = P * (1 + r/n)^(n*t)
```

`P` principal, `r` annual rate as a decimal, `n` compounds per year (default 1 = annually),
`t` years. Interest earned = `A - P`. Also returns the effective annual rate.

> $10,000 · 8% · 5 years, annually → **$14,693.28** (interest $4,693.28)

**Monthly loan payment (fixed-rate amortisation)**

```
M = P * [ i(1+i)^n ] / [ (1+i)^n - 1 ]
```

`i` monthly rate (`annual / 12`), `n` total payments (`years × 12`). At `i = 0` the
expression is 0/0, so that case falls back to `M = P / n`.

> $300,000 · 6.5% · 30 years → **$1,896.20/month**, $682,632.00 repaid, $382,632.00 interest

---

## 5. LLM integration

Four functions are advertised to the model:

| Tool | Purpose |
| --- | --- |
| `get_financial_product` | official rate + term limits for one stored product |
| `list_financial_products` | the whole catalogue |
| `calculate_compound_interest` | future value of a lump sum |
| `calculate_loan_payment` | monthly payment, total paid, total interest |

The calculation tools accept **either** `annualRatePercent` **or** `productName`. When
`productName` is present the backend reads the rate from PostgreSQL, validates the term
against that product's rules, and reports `rateSource: "database"`.

The orchestrator loops (max `MAX_TOOL_ROUNDS`, default 5) until the model replies with
text instead of a tool call, which is what allows chaining such as
`get_financial_product → calculate_loan_payment`.

---

## 6. API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | liveness + active LLM provider |
| `GET` | `/api/products` | the product catalogue |
| `POST` | `/api/conversations` | create an empty thread |
| `GET` | `/api/conversations/:id/messages` | full stored history |
| `POST` | `/api/chat` | `{ message, conversationId? }` → assistant reply + trace |

`POST /api/chat` returns a `trace` array showing which backend functions ran, with what
arguments, and whether each succeeded. The UI renders this under the answer so the
"calculated by the backend" claim is visible rather than merely asserted.

---

## 7. Example questions

- "What will $10,000 become after 5 years at 8% annual interest?"
- "What is the monthly payment for a $300,000 loan at 6.5% for 30 years?"
- "Calculate the monthly payment for a $300,000 Home Loan over 30 years using the stored interest rate."
- "What is the rate on the Home Loan?"
- "What financial products do you offer?"
- "How much will $5,000 grow to in 10 years in the High Yield Savings account?"

Error paths worth trying: a negative amount, a 40-year Home Loan (exceeds the stored
30-year maximum), a product that does not exist, or a question with no term given.

---

## 8. Assumptions

1. **Rates are percentages everywhere** — `6.5` means 6.5% per year. The conversion to a
   decimal happens only inside the formula. This is stated in the tool descriptions, the
   system prompt, the DB column comment and the validators, because mixing the two
   representations is the classic bug in this domain.
2. **Currency is USD** and is not modelled — there is no currency column and no FX.
3. **Compound interest** defaults to annual compounding unless the user states a
   frequency; allowed values are 1, 2, 4, 12, 52, 365.
4. **Loans are fixed-rate and fully amortising.** No fees, taxes, insurance, extra
   repayments, offset accounts or variable rates.
5. **Loan totals are derived from the rounded monthly payment**, so `monthly × n` always
   reconciles with the total shown. Real lenders adjust the final instalment by a few
   cents instead.
6. **No authentication or multi-tenancy.** Conversations are identified by an unguessable
   UUID held in browser memory; there is no user table.
7. **The conversation is replayed to the model as plain text.** Previous tool calls are
   not re-sent — the earlier assistant messages already contain the verified figures.
8. **English input only.**

## 9. Limitations

1. **Floating-point money.** Calculations use IEEE-754 doubles rounded to cents. Correct
   at these magnitudes, but production banking code should use integer cents or a decimal
   library.
2. **No streaming.** The reply arrives in one response, so a turn that needs a tool call
   costs two sequential model round-trips (typically 2–5s). Streaming the final
   explanation would be the first thing to add.
3. **History grows unbounded.** Every prior message is sent on every turn. A real system
   needs windowing or summarisation.
4. **No rate limiting, no auth, no cost controls** on our own endpoint — and the Gemini
   free tier imposes a low per-minute limit upstream. A 429 is translated into a readable
   message with the retry delay, but there is no queue, no backoff and no retry.
5. **Model choice is a trade-off.** `gemini-flash-lite-latest` is fast, cheap and has the
   most generous free quota, which is the right shape for what the model is asked to do
   here (extract four numbers, then write three sentences). A larger model would cope
   better with unusual phrasing; it would not make the answers more accurate, because the
   answers do not come from the model.
6. **Rolling `-latest` alias.** Chosen so the project keeps working when Google retires a
   pinned version, at the cost of the model changing under you. Production should pin a
   version and upgrade deliberately.
7. **Only two calculations.** No amortisation schedule, APR, NPV/IRR, or tax handling.
8. **Conversation state is client-side.** Refreshing the page starts a new thread; the
   history is in the database and `GET /api/conversations/:id/messages` will return it,
   but the UI does not yet list past threads.
9. **Intent detection is only as good as the model.** An ambiguous question can still be
   routed to the wrong tool. The backend guarantees the *arithmetic* is right and that
   stored rates are authoritative — it cannot guarantee the *question* was understood.
10. **The mock provider is deliberately dumb** — a handful of regexes covering the example
    questions. It exists to test plumbing, not to be a fallback in production.
11. **Single Postgres instance, no connection retry/backoff** beyond the pool defaults.

## 10. AI tool usage

This solution was written with AI assistance (Claude). The architecture decisions —
provider abstraction, tools-as-contract with double validation, database-wins-over-model
rate resolution, transactional turn persistence — were reviewed and are explained above
and in `docs/ARCHITECTURE.md`. The financial formulas are verified by unit tests against
independently known values rather than taken on trust.
