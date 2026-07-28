export type CalculationType = 'compound_interest' | 'loan_payment';

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  calculationType: CalculationType | null;
  calculationResult: number | null;
  calculationDetails: unknown | null;
  createdAt: string;
}

export interface TraceEntry {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface ChatResponse {
  conversationId: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  trace: TraceEntry[];
}

export interface FinancialProduct {
  id: number;
  name: string;
  productType: string;
  annualInterestRate: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
