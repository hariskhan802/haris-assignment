import cors from 'cors';
import express from 'express';
import { assertLlmConfigured, corsOrigins, env } from './config/env.js';
import { closePool, pool } from './db/pool.js';
import { GeminiProvider } from './llm/gemini.provider.js';
import { MockProvider } from './llm/mock.provider.js';
import type { LlmProvider } from './llm/provider.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createApiRouter } from './routes/chat.routes.js';

function buildProvider(): LlmProvider {
  if (env.LLM_PROVIDER === 'mock') {
    console.warn('LLM_PROVIDER=mock — using the offline test double, not a real model.');
    return new MockProvider();
  }
  return new GeminiProvider(env.GEMINI_API_KEY!, env.GEMINI_MODEL);
}

async function main(): Promise<void> {
  assertLlmConfigured();

  // Fail on boot rather than on the first chat request.
  await pool.query('SELECT 1');

  const app = express();
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', createApiRouter(buildProvider()));
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
    console.log(`LLM provider: ${env.LLM_PROVIDER}${env.LLM_PROVIDER === 'gemini' ? ` (${env.GEMINI_MODEL})` : ''}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
