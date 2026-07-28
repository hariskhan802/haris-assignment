import type { ToolDefinition } from './tools.js';

/**
 * Provider-agnostic LLM contract.
 *
 * Everything above this interface (the orchestrator, the tools, the services)
 * is vendor-neutral; swapping Gemini for OpenAI or Claude means writing one new
 * file that implements `LlmProvider` and registering it in `index.ts`.
 */

/**
 * `opaque` carries provider-specific state that must be echoed back verbatim on
 * the next request but means nothing to us — Gemini 3's `thoughtSignature`, for
 * example, or an OpenAI `tool_call_id`. The orchestrator only ever moves it
 * around; it is never inspected outside the provider that produced it.
 */
export type LlmPart =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; name: string; args: Record<string, unknown>; opaque?: unknown }
  | { kind: 'toolResult'; name: string; response: unknown };

export interface LlmMessage {
  /** 'model' rather than 'assistant' — matches Gemini and maps cleanly onto others. */
  role: 'user' | 'model';
  parts: LlmPart[];
}

export interface LlmGenerateInput {
  systemInstruction: string;
  history: LlmMessage[];
  tools: ToolDefinition[];
}

export interface LlmGenerateOutput {
  text: string | null;
  toolCalls: { name: string; args: Record<string, unknown>; opaque?: unknown }[];
}

export interface LlmProvider {
  readonly name: string;
  generate(input: LlmGenerateInput): Promise<LlmGenerateOutput>;
}

/**
 * The system instruction is the main safety rail on the model side. The hard
 * guarantee still lives in the backend (the model literally cannot write to the
 * response without going through a tool for numbers), but stating the rules
 * explicitly dramatically reduces the number of times it tries.
 */
export const SYSTEM_INSTRUCTION = `You are FinChat, a careful financial assistant for a retail bank.

## Your one hard rule
You must NEVER perform arithmetic yourself and NEVER invent a number.
Every monetary figure, interest rate, payment or total you state must come verbatim
from a tool result in this conversation. If you have not called a tool, you do not
have a number. Do not estimate, do not round differently, do not "sanity check" by
recomputing — quote the tool's values exactly as returned.

## Tools
- get_financial_product     — the official interest rate and term limits for one stored product
- list_financial_products   — the whole product catalogue
- calculate_compound_interest — future value of a lump sum earning compound interest
- calculate_loan_payment    — fixed monthly payment for an amortising loan

## How to choose
- "What will X become after N years at R%?"  -> calculate_compound_interest
- "What is the monthly payment for ...?"     -> calculate_loan_payment
- If the user names a stored product (e.g. "Home Loan") or says "the stored rate",
  pass productName to the calculation tool INSTEAD of a rate. The backend will read
  the authoritative rate from the database. Never guess a product's rate.
- If the user asks only what a product's rate is, use get_financial_product.

## Parameters
- Rates are PERCENTAGES: send 6.5 for 6.5%, never 0.065.
- Amounts are plain numbers: "$300,000" -> 300000, "10k" -> 10000.
- Terms are in YEARS: "360 months" -> 30.
- Only set compoundsPerYear when the user actually states a frequency.
- If a required value is genuinely missing (e.g. no term given), ASK the user a short
  clarifying question instead of assuming a value or calling the tool with a guess.

## When a tool returns ok: false
Do not retry with invented values. Explain the problem in plain language and ask the
user for what is needed. If the error lists availableProducts, mention them.

## Answering
Reply in plain conversational English, 2–5 short sentences. Lead with the headline
figure, then the supporting numbers the tool returned (total interest, total paid,
effective rate) and state where the rate came from when it was read from the database.
Format money with a $ and thousands separators. Do not show the formula unless asked.
Politely decline anything that is not a personal-finance question.`;
