import { env } from '../config/env.js';
import { LlmError } from '../errors.js';
import type { StoredMessage } from '../services/conversation.service.js';
import { SYSTEM_INSTRUCTION, type LlmMessage, type LlmPart, type LlmProvider } from './provider.js';
import { toolRegistry, toolsByName, type CalculationOutcome } from './tools.js';

/**
 * ===========================================================================
 * The orchestrator implements the required flow:
 *
 *   user message
 *     -> LLM detects intent + extracts parameters   (provider.generate)
 *     -> backend validates the parameters           (Zod, inside tool.execute)
 *     -> database supplies stored information       (product.service)
 *     -> backend formula performs the calculation   (financial.service)
 *     -> LLM explains the VERIFIED result           (final provider.generate)
 *
 * The loop runs until the model answers with text instead of a tool call, or
 * until MAX_TOOL_ROUNDS is hit. Multiple rounds are what allows chaining, e.g.
 * get_financial_product -> calculate_loan_payment for "using the stored rate".
 * ===========================================================================
 */

export interface TraceEntry {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface OrchestratorOutcome {
  reply: string;
  calculation: CalculationOutcome | null;
  trace: TraceEntry[];
}

/**
 * Replays stored history as plain text. Tool calls from previous turns are not
 * replayed: the assistant's prior answer already contains the verified figures,
 * so re-sending the raw tool payloads would only add tokens and risk the model
 * reusing stale parameters.
 */
function toLlmHistory(previous: StoredMessage[], newUserMessage: string): LlmMessage[] {
  const history: LlmMessage[] = previous.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ kind: 'text', text: m.content }],
  }));
  history.push({ role: 'user', parts: [{ kind: 'text', text: newUserMessage }] });
  return history;
}

export async function runConversationTurn(params: {
  provider: LlmProvider;
  previousMessages: StoredMessage[];
  userMessage: string;
}): Promise<OrchestratorOutcome> {
  const { provider, previousMessages, userMessage } = params;

  const history = toLlmHistory(previousMessages, userMessage);
  const trace: TraceEntry[] = [];
  let lastCalculation: CalculationOutcome | null = null;

  for (let round = 1; round <= env.MAX_TOOL_ROUNDS; round++) {
    const turn = await provider.generate({
      systemInstruction: SYSTEM_INSTRUCTION,
      history,
      tools: toolRegistry,
    });

    // No tool requested -> the model is talking to the user. We are done.
    if (turn.toolCalls.length === 0) {
      const reply = turn.text?.trim();
      if (!reply) throw new LlmError('The model produced neither a tool call nor a reply.');
      return { reply, calculation: lastCalculation, trace };
    }

    // Record the model's turn verbatim so it can see its own tool calls.
    const modelParts: LlmPart[] = [];
    if (turn.text) modelParts.push({ kind: 'text', text: turn.text });
    for (const call of turn.toolCalls) {
      // `opaque` is provider-owned state (e.g. Gemini's thoughtSignature) that
      // must survive the round-trip untouched.
      modelParts.push({
        kind: 'toolCall',
        name: call.name,
        args: call.args,
        ...(call.opaque !== undefined ? { opaque: call.opaque } : {}),
      });
    }
    history.push({ role: 'model', parts: modelParts });

    // Execute every requested tool in the backend and feed the results back.
    const resultParts: LlmPart[] = [];
    for (const call of turn.toolCalls) {
      const tool = toolsByName.get(call.name);

      const result = tool
        ? await tool.execute(call.args)
        : ({
            ok: false,
            error: {
              code: 'UNKNOWN_TOOL',
              message: `No tool named "${call.name}" exists. Use one of: ${[...toolsByName.keys()].join(', ')}.`,
            },
          } as const);

      trace.push({
        round,
        tool: call.name,
        args: call.args,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error.message }),
      });

      if (result.ok && result.calculation) lastCalculation = result.calculation;

      resultParts.push({ kind: 'toolResult', name: call.name, response: result });
    }
    history.push({ role: 'user', parts: resultParts });
  }

  throw new LlmError(
    `The assistant could not settle on an answer within ${env.MAX_TOOL_ROUNDS} tool rounds.`,
    { trace },
  );
}
