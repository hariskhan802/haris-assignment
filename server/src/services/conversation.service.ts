import { pool, query } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import type { CalculationType } from './financial.service.js';

export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  calculationType: CalculationType | null;
  calculationResult: number | null;
  calculationDetails: unknown | null;
  createdAt: string;
}

interface MessageRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  calculation_type: CalculationType | null;
  calculation_result: number | null;
  calculation_details: unknown | null;
  created_at: Date;
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    calculationType: row.calculation_type,
    calculationResult: row.calculation_result,
    calculationDetails: row.calculation_details,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createConversation(title?: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    'INSERT INTO conversations (title) VALUES ($1) RETURNING id',
    [title ?? null],
  );
  return rows[0]!.id;
}

export async function conversationExists(conversationId: string): Promise<boolean> {
  const { rowCount } = await query('SELECT 1 FROM conversations WHERE id = $1', [conversationId]);
  return rowCount === 1;
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  if (!(await conversationExists(conversationId))) {
    throw new NotFoundError(`Conversation ${conversationId} does not exist.`);
  }
  const { rows } = await query<MessageRow>(
    `SELECT id, role, content, calculation_type, calculation_result, calculation_details, created_at
       FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at, id`,
    [conversationId],
  );
  return rows.map(toMessage);
}

export interface TurnToPersist {
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  calculationType: CalculationType | null;
  calculationResult: number | null;
  calculationDetails: unknown | null;
}

/**
 * Persist a complete turn (user message + assistant reply) atomically, so the
 * history can never end up with a dangling user message and no answer.
 */
export async function saveTurn(turn: TurnToPersist): Promise<{
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertSql = `
      INSERT INTO messages
        (conversation_id, role, content, calculation_type, calculation_result, calculation_details)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, role, content, calculation_type, calculation_result, calculation_details, created_at
    `;

    const userRes = await client.query<MessageRow>(insertSql, [
      turn.conversationId,
      'user',
      turn.userMessage,
      null,
      null,
      null,
    ]);

    const assistantRes = await client.query<MessageRow>(insertSql, [
      turn.conversationId,
      'assistant',
      turn.assistantMessage,
      turn.calculationType,
      turn.calculationResult,
      turn.calculationDetails === null ? null : JSON.stringify(turn.calculationDetails),
    ]);

    await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [
      turn.conversationId,
    ]);

    // First user message doubles as the thread title, ChatGPT-style.
    await client.query(
      `UPDATE conversations
          SET title = LEFT($2, 80)
        WHERE id = $1 AND title IS NULL`,
      [turn.conversationId, turn.userMessage],
    );

    await client.query('COMMIT');

    return {
      userMessage: toMessage(userRes.rows[0]!),
      assistantMessage: toMessage(assistantRes.rows[0]!),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
