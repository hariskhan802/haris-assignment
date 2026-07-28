# Architecture

## 1. The problem this design solves

An LLM is excellent at reading `"a $300,000 Home Loan over 30 years using the stored
rate"` and terrible at being *trusted* with the arithmetic that follows. It will produce
a plausible monthly payment, it will be wrong by a few dollars sometimes, and there is no
way to tell the two cases apart from the output.

So the split is:

- **The LLM is a parser and a writer.** It turns prose into a typed function call, and
  turns a verified result back into prose.
- **The backend is the source of truth.** It validates, reads the database, computes, and
  owns every number that reaches the user.

Everything below is in service of making that split structural rather than aspirational.

## 2. Request lifecycle

```
POST /api/chat  { message, conversationId? }
        │
        ▼
 chat.routes.ts ── Zod-validate body ── ensure/create conversation ── load history
        │
        ▼
 orchestrator.runConversationTurn()
        │
        │  ROUND 1
        ├─► provider.generate(system, history, tools)
        │        └─► returns { text: null, toolCalls: [calculate_loan_payment {...}] }
        │
        ├─► tools.ts  execute()
        │        ├─ Zod-validate the model's arguments        ← untrusted input
        │        ├─ productName present? → product.service.getFinancialProduct()
        │        │                          (PostgreSQL; DB rate OVERRIDES the model's)
        │        ├─ assertTermWithinProductRange()             ← business rule
        │        └─ financial.service.calculateLoanPayment()   ← the only place a
        │                                                        number is produced
        ├─► push { functionResponse } back into history
        │
        │  ROUND 2
        └─► provider.generate(...) → { text: "Your estimated monthly payment is …" }
        │
        ▼
 conversation.service.saveTurn()  ── single transaction: user row + assistant row
        │                            + calculation_type / result / details
        ▼
 { conversationId, userMessage, assistantMessage, trace }
```

The loop runs up to `MAX_TOOL_ROUNDS` (default 5). More than one round of tool calls is
what lets the model chain `get_financial_product → calculate_loan_payment` when it wants
to inspect a rate before using it.

## 3. Layers

| Layer | Files | Knows about |
| --- | --- | --- |
| HTTP | `routes/`, `middleware/` | Express, request shape |
| Orchestration | `llm/orchestrator.ts` | the tool loop, nothing vendor-specific |
| LLM adapter | `llm/provider.ts`, `llm/gemini.provider.ts`, `llm/mock.provider.ts` | Gemini's wire format |
| Tool contract | `llm/tools.ts` | how a model request maps to a service call |
| Domain | `services/` | money, products, conversations |
| Data | `db/` | SQL, the connection pool |

Dependencies point downward only. `financial.service.ts` has no idea an LLM exists — it
is a pure module that takes numbers and returns numbers, which is why it can be unit
tested against known values.

## 4. Key decisions and trade-offs

### 4.1 Tool calling instead of "return JSON"

**Decision:** use the provider's native function-calling API.

**Alternative considered:** ask the model to reply with a JSON blob and parse it.

**Why:** function calling gives a typed schema the provider enforces on its side, a clean
place to send results back, and native multi-step chaining. Prompt-and-parse means
writing a repair loop for malformed JSON and re-implementing the tool-result turn by hand.

**Trade-off:** it couples us to providers that support tool calling. Every serious one
does, and `LlmProvider` isolates the difference to a single file.

### 4.2 The database beats the model on rates

**Decision:** `calculate_*` tools accept **either** `annualRatePercent` **or**
`productName`. When `productName` is present, the backend reads the rate from PostgreSQL
and discards whatever rate the model may have sent in the same call.

**Why:** the obvious design is to make the model call `get_financial_product` first and
then pass the rate it read into the calculator. That works — but it puts a number the
model typed into the calculation input, and a model that has seen "Home Loan" a million
times in training will sometimes type `6.75` instead of the `6.5` we actually store. This
design makes the hallucination *unable to affect the result*.

**Trade-off:** two ways to express the same intent, so the tool schema and the system
prompt both have to explain when to use which. Worth it: this is the single guard that
makes "using the stored interest rate" mean something.

### 4.3 Tool errors are returned, not thrown

**Decision:** `tool.execute()` returns `{ ok: false, error }` instead of throwing.

**Why:** most "errors" here are conversational, not exceptional. "You didn't tell me the
term" and "Home Loan caps at 30 years" should become a follow-up question, not an HTTP
500. Feeding the failure back as a function response lets the model do exactly that, in
natural language, in the user's own framing.

**Trade-off:** a genuine bug can be swallowed into a polite apology. Mitigated by logging
unexpected (non-`AppError`) failures server-side with the real stack trace and returning
a deliberately generic message to the model.

### 4.4 Validation happens twice

Zod validates the *shape* at the tool boundary (`principal` is a positive finite number).
`financial.service.ts` validates the *domain* (principal ≤ $1B, term ≤ 100 years, rate ≤
100% with a hint that rates are percentages, compounding frequency in an allowed set).

**Why not once?** The Zod layer exists to protect the service from the model. The service
guards exist to protect the maths from *any* caller — a future REST endpoint, a batch
job, a test. `calculateLoanPayment` is safe to call from anywhere, which is a property
worth paying a few duplicated checks for.

### 4.5 Raw SQL, no ORM

**Decision:** `pg` with parameterised queries and a hand-written migration runner.

**Why:** three tables. An ORM would add a build step, a query DSL and a schema-generation
mechanism to save perhaps forty lines, and it would hide the CHECK constraints and the
partial index that are doing real work here. The SQL in `001_init.sql` *is* the schema
documentation.

**Trade-off:** manual row→object mapping and no compile-time link between the SQL and the
TypeScript interfaces. Acceptable at this size; an ORM earns its keep past ~15 tables.

### 4.6 Persist after the answer, in one transaction

`saveTurn` writes the user message and the assistant message together. If the LLM call
fails, nothing is written at all.

**Why:** a thread containing a user question with no reply is worse than no record — it
corrupts the history that gets replayed to the model on the next turn.

**Trade-off:** a message the user definitely sent is lost when the model errors. For an
audit-grade system you would write the user row immediately and mark the turn `failed`.

### 4.7 History is replayed as plain text

Previous turns go back to the model as text only; old tool calls and tool results are not
re-sent.

**Why:** the previous assistant message already contains the verified figures, so the
context is preserved. Re-sending raw tool payloads triples the token count and gives the
model stale parameters it is tempted to reuse.

**Trade-off:** the model cannot inspect the full detail of an earlier calculation, so
"and what if it were 25 years?" causes a fresh tool call rather than a cheap edit. That is
the safer failure mode.

### 4.8 A provider interface with a mock implementation

`LlmProvider` has two implementations: `GeminiProvider` (real) and `MockProvider`
(offline, regex-based).

**Why:** the whole request path — routing, validation, DB access, formulas, persistence,
error handling — can be exercised deterministically, with no API key, no network, and no
cost. It is also the proof that nothing above the interface is Gemini-specific: porting
to OpenAI or Claude is one new file.

**Trade-off:** the mock is a maintenance surface that understands only the documented
example questions. It is explicitly a test double, not a production fallback.

### 4.9 An opaque passthrough field on tool calls

**Decision:** `LlmPart` for a tool call carries an `opaque?: unknown` that the
orchestrator moves around but never reads.

**Why:** the first real integration test failed with

> `Function call is missing a thought_signature in functionCall parts.`

Gemini 3's thinking models attach a `thoughtSignature` to every `functionCall` and reject
the follow-up request with a 400 if it is not echoed back verbatim. A vendor-neutral
`LlmPart` naturally strips exactly that kind of field — which is the standard failure mode
of an abstraction over provider APIs: it normalises away state the provider needs back.

The fix is not to leak `thoughtSignature` into the shared type (that would make the
interface Gemini-shaped), but to give providers a sealed envelope. `GeminiProvider` puts
its signature in on the way out and unpacks it on the way in; OpenAI's `tool_call_id`
would use the same slot; `MockProvider` ignores it entirely.

**Trade-off:** `unknown` means no type safety on the contents, and the orchestrator is
carrying state it cannot reason about. That is the price of the abstraction being genuinely
vendor-neutral rather than nearly so.

**Related:** `GeminiProvider` reads `candidates[0].content.parts` directly rather than the
SDK's `response.functionCalls` / `response.text` helpers, because `functionCalls` drops
the signature and `text` concatenates the model's internal reasoning (parts flagged
`thought: true`) into what would be shown to the user.

## 5. Data model notes

- `annual_interest_rate` is `NUMERIC(6,3)` holding a **percentage** (`6.500` = 6.5%),
  with a `CHECK (0 ≤ rate ≤ 100)`. `NUMERIC` rather than `float` because rates are exact
  decimal quantities.
- `pg` returns `NUMERIC` as a string to preserve precision; `db/pool.ts` registers a type
  parser converting it to `number` in exactly one place.
- `messages.calculation_details` is `JSONB` and stores the complete result object —
  inputs, outputs, formula, `rateSource`, and the product row used. That is the audit
  trail: for any answer ever given you can reconstruct precisely which numbers went in.
- `CHECK (calc_only_on_assistant)` makes it structurally impossible to attach a
  calculation to a user message.
- `messages` is indexed on `(conversation_id, created_at, id)` for history replay, plus a
  partial index on `calculation_type` for "how often is each calculation used" analytics.

## 6. What I would do next

1. **Stream the final explanation** — the second model call is the bulk of the latency.
2. **Persist the user message immediately** with a `status` column, so a failed turn is
   recorded rather than discarded.
3. **Decimal money** — integer cents or `decimal.js` end to end.
4. **Conversation list in the UI** — the data is already stored and the endpoint exists.
5. **Auth + per-user rate limiting** before this is exposed to anyone.
6. **Evaluation suite** — a fixed set of questions asserting the right tool is chosen with
   the right arguments, run against the real model in CI. Prompt changes are code changes
   and deserve regression tests.
