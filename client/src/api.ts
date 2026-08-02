import type { ApiErrorBody, ChatResponse, FinancialProduct } from './types';

/**
 * In dev, Vite proxies /api to the backend on the same origin (see vite.config.ts).
 * In production the frontend and backend are deployed as separate services, so
 * VITE_API_URL (set at build time to the backend's hostname) is required.
 */
const apiHost = import.meta.env.VITE_API_URL as string | undefined;
const BASE = apiHost ? `https://${apiHost}/api` : '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch {
    throw new Error('Could not reach the server. Is the backend running on port 4400?');
  }

  if (!response.ok) {
    // Prefer the API's structured message; fall back to the status line.
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  }

  return (await response.json()) as T;
}

export function sendChatMessage(message: string, conversationId: string | null): Promise<ChatResponse> {
  return request<ChatResponse>('/chat', {
    method: 'POST',
    body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
  });
}

export function fetchProducts(): Promise<{ products: FinancialProduct[] }> {
  return request<{ products: FinancialProduct[] }>('/products');
}
