import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail fast on boot rather than blowing up on the first request with a
 * confusing `undefined` somewhere deep in the call stack.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4400),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LLM_PROVIDER: z.enum(['gemini', 'mock']).default('gemini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-lite-latest'),
  MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(10).default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

/** Real Gemini calls need a key; the mock provider deliberately does not. */
export function assertLlmConfigured(): void {
  if (env.LLM_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    console.error(
      'LLM_PROVIDER=gemini but GEMINI_API_KEY is missing.\n' +
        'Get a free key at https://aistudio.google.com/apikey, or set LLM_PROVIDER=mock to run offline.',
    );
    process.exit(1);
  }
}

export const corsOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
