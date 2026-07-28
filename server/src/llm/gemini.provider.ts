import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
  type Schema,
} from '@google/genai';
import { env } from '../config/env.js';
import { LlmError } from '../errors.js';
import type { LlmGenerateInput, LlmGenerateOutput, LlmMessage, LlmProvider } from './provider.js';
import type { JsonSchemaObject, JsonSchemaProperty, ToolDefinition } from './tools.js';

const TYPE_MAP: Record<JsonSchemaProperty['type'], Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
};

/** Translate our neutral JSON Schema into Gemini's OpenAPI-flavoured Schema. */
function toGeminiSchema(parameters: JsonSchemaObject): Schema {
  const properties: Record<string, Schema> = {};
  for (const [key, prop] of Object.entries(parameters.properties)) {
    properties[key] = {
      type: TYPE_MAP[prop.type],
      description: prop.description,
      ...(prop.enum ? { enum: prop.enum } : {}),
    };
  }
  return { type: Type.OBJECT, properties, required: parameters.required };
}

function toFunctionDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters),
  }));
}

function toGeminiContents(history: LlmMessage[]): Content[] {
  return history.map((message) => {
    const parts: Part[] = message.parts.map((part) => {
      switch (part.kind) {
        case 'text':
          return { text: part.text };
        case 'toolCall':
          // Gemini 3 thinking models attach a thoughtSignature to each
          // functionCall and REJECT the follow-up request (400) if it is not
          // echoed back exactly. It rides along as `opaque`.
          return {
            functionCall: { name: part.name, args: part.args },
            ...(typeof part.opaque === 'string' ? { thoughtSignature: part.opaque } : {}),
          };
        case 'toolResult':
          // Gemini expects the response payload to be an object.
          return {
            functionResponse: {
              name: part.name,
              response: part.response as Record<string, unknown>,
            },
          };
      }
    });
    return { role: message.role, parts };
  });
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private readonly client: GoogleGenAI;

  constructor(apiKey: string, private readonly model: string = env.GEMINI_MODEL) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateOutput> {
    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: toGeminiContents(input.history),
        config: {
          systemInstruction: input.systemInstruction,
          // Low temperature: this is an extraction/routing task, not creative writing.
          temperature: 0.2,
          tools: [{ functionDeclarations: toFunctionDeclarations(input.tools) }],
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Google retires models for newly-created API keys, which surfaces as a 404
      // on a name that still appears in ListModels. Make that actionable rather
      // than leaving a raw provider error in the chat window.
      if (message.includes('no longer available') || message.includes('NOT_FOUND')) {
        throw new LlmError(
          `The configured model "${this.model}" is not available to this API key. ` +
            'Set GEMINI_MODEL to a current model (e.g. "gemini-flash-latest") in server/.env.',
          { model: this.model },
        );
      }

      // The free tier is a few requests per minute, and one chat turn costs two
      // model calls. Surface the retry delay instead of a wall of provider JSON.
      if (message.includes('RESOURCE_EXHAUSTED') || message.includes('429')) {
        const retry = /"retryDelay":\s*"(\d+)s"/.exec(message)?.[1];
        throw new LlmError(
          'The Gemini API rate limit was reached' +
            (retry ? `. Please try again in about ${retry} seconds.` : '. Please try again shortly.'),
          { model: this.model },
        );
      }

      throw new LlmError(`Gemini request failed: ${message}`, { model: this.model });
    }

    // Walk the raw parts rather than the `functionCalls` / `text` helpers: the
    // helpers drop thoughtSignature, and `text` concatenates the model's internal
    // reasoning (parts flagged `thought: true`) into the user-facing answer.
    const parts = response.candidates?.[0]?.content?.parts ?? [];

    const toolCalls: LlmGenerateOutput['toolCalls'] = [];
    const textChunks: string[] = [];

    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name ?? '',
          args: (part.functionCall.args ?? {}) as Record<string, unknown>,
          ...(part.thoughtSignature ? { opaque: part.thoughtSignature } : {}),
        });
      } else if (part.text && !part.thought) {
        textChunks.push(part.text);
      }
    }

    const text = textChunks.join('').trim() || null;

    if (!text && toolCalls.length === 0) {
      throw new LlmError('Gemini returned an empty response.', {
        finishReason: response.candidates?.[0]?.finishReason,
      });
    }

    return { text, toolCalls };
  }
}
