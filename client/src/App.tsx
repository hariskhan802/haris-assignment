import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchProducts, sendChatMessage } from './api';
import type { ChatMessage, FinancialProduct, TraceEntry } from './types';

const SUGGESTIONS = [
  'What will $10,000 become after 5 years at 8% annual interest?',
  'What is the monthly payment for a $300,000 loan at 6.5% for 30 years?',
  'Calculate the monthly payment for a $300,000 Home Loan over 30 years using the stored interest rate.',
  'What financial products do you offer?',
];

const money = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CALC_LABEL: Record<string, string> = {
  compound_interest: 'Compound interest',
  loan_payment: 'Monthly loan payment',
};

/**
 * Shows which backend function actually produced the number. Not required by
 * the brief, but it makes the "the LLM did not compute this" claim visible.
 */
function CalculationBadge({ message, trace }: { message: ChatMessage; trace?: TraceEntry[] }) {
  if (!message.calculationType || message.calculationResult === null) return null;
  const tools = trace?.filter((t) => t.ok).map((t) => t.tool) ?? [];

  return (
    <div className="badge">
      <strong>{CALC_LABEL[message.calculationType] ?? message.calculationType}</strong>
      {' verified by backend: '}
      <code>{money(message.calculationResult)}</code>
      {tools.length > 0 && <div className="badge-tools">functions called: {tools.join(' → ')}</div>}
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [traceByMessageId, setTraceByMessageId] = useState<Record<number, TraceEntry[]>>({});
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<FinancialProduct[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Purely informational; a failure here must not break the chat.
    fetchProducts()
      .then((r) => setProducts(r.products))
      .catch(() => setProducts([]));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    setError(null);
    setInput('');
    setIsLoading(true);

    // Optimistic user bubble with a temporary negative id, replaced by the
    // server's persisted row once the request resolves.
    const optimisticId = -Date.now();
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: 'user',
        content: trimmed,
        calculationType: null,
        calculationResult: null,
        calculationDetails: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const response = await sendChatMessage(trimmed, conversationId);
      setConversationId(response.conversationId);
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticId),
        response.userMessage,
        response.assistantMessage,
      ]);
      setTraceByMessageId((prev) => ({ ...prev, [response.assistantMessage.id]: response.trace }));
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setInput(trimmed); // give the text back so the user can retry
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setIsLoading(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(input);
  }

  return (
    <div className="app">
      <header>
        <h1>FinChat</h1>
        <p className="subtitle">
          Ask a financial question in plain English. Every number is calculated by the backend, not
          by the language model.
        </p>
        {products.length > 0 && (
          <p className="products">
            Stored products:{' '}
            {products.map((p) => `${p.name} (${p.annualInterestRate}%)`).join(' · ')}
          </p>
        )}
      </header>

      <main className="messages">
        {messages.length === 0 && !isLoading && (
          <div className="empty">
            <p>Try one of these:</p>
            <ul>
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button type="button" onClick={() => void submit(s)} disabled={isLoading}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            <div className="role">{message.role === 'user' ? 'You' : 'Assistant'}</div>
            <div className="content">{message.content}</div>
            <CalculationBadge message={message} trace={traceByMessageId[message.id]} />
          </div>
        ))}

        {isLoading && (
          <div className="message assistant">
            <div className="role">Assistant</div>
            <div className="content loading">Thinking…</div>
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      {error && (
        <div className="error" role="alert">
          <strong>Error:</strong> {error}
        </div>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. What is the monthly payment for a $300,000 Home Loan over 30 years?"
          disabled={isLoading}
          autoFocus
        />
        <button type="submit" disabled={isLoading || input.trim().length === 0}>
          {isLoading ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
