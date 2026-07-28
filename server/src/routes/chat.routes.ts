import { Router } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../errors.js';
import type { LlmProvider } from '../llm/provider.js';
import { runConversationTurn } from '../llm/orchestrator.js';
import {
  conversationExists,
  createConversation,
  getMessages,
  saveTurn,
} from '../services/conversation.service.js';
import { listFinancialProducts } from '../services/product.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const chatRequestSchema = z.object({
  message: z.string().trim().min(1, 'Message cannot be empty.').max(2000, 'Message is too long.'),
  conversationId: z.string().uuid('conversationId must be a UUID.').optional(),
});

export function createApiRouter(provider: LlmProvider): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', llmProvider: provider.name });
  });

  router.get(
    '/products',
    asyncHandler(async (_req, res) => {
      res.json({ products: await listFinancialProducts() });
    }),
  );

  router.post(
    '/conversations',
    asyncHandler(async (_req, res) => {
      const conversationId = await createConversation();
      res.status(201).json({ conversationId });
    }),
  );

  router.get(
    '/conversations/:id/messages',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      res.json({ conversationId: id, messages: await getMessages(id) });
    }),
  );

  /**
   * The one endpoint that matters.
   *
   *   validate body -> load history -> orchestrate (LLM <-> tools) -> persist -> respond
   *
   * Persistence happens after the answer is produced so that a failed turn does
   * not leave a user message in the thread with no reply.
   */
  router.post(
    '/chat',
    asyncHandler(async (req, res) => {
      const { message, conversationId: incomingId } = chatRequestSchema.parse(req.body);

      let conversationId = incomingId;
      if (conversationId) {
        if (!(await conversationExists(conversationId))) {
          throw new NotFoundError(`Conversation ${conversationId} does not exist.`);
        }
      } else {
        conversationId = await createConversation();
      }

      const previousMessages = await getMessages(conversationId);

      const outcome = await runConversationTurn({ provider, previousMessages, userMessage: message });

      const saved = await saveTurn({
        conversationId,
        userMessage: message,
        assistantMessage: outcome.reply,
        calculationType: outcome.calculation?.type ?? null,
        calculationResult: outcome.calculation?.result ?? null,
        calculationDetails: outcome.calculation?.details ?? null,
      });

      res.json({
        conversationId,
        userMessage: saved.userMessage,
        assistantMessage: saved.assistantMessage,
        // Surfaced so the UI can show which backend function actually ran.
        trace: outcome.trace,
      });
    }),
  );

  return router;
}
