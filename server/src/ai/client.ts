import { config } from '../config.js';

/**
 * Minimal OpenAI-compatible client for the local AI (llama.cpp server).
 * Everything is config-gated: when AI_ENABLED is false the module inert.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** Disable Qwen-style thinking for latency-sensitive actions. */
  noThinking?: boolean;
}

export function aiEnabled(): boolean {
  return config.ai.enabled;
}

function endpoint(path: string): string {
  return `${config.ai.baseUrl}${path}`;
}

/** Non-streaming chat completion. Returns the assistant content (reasoning stripped). */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (!aiEnabled()) throw new Error('ai disabled');
  const res = await fetch(endpoint('/v1/chat/completions'), {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ai.model,
      messages,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.4,
      ...(opts.noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`ai HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * Streaming chat completion. Calls onDelta with each text chunk and returns
 * the full text. Streams via SSE from the llama.cpp server.
 */
export async function chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
  onDelta: (text: string) => void
): Promise<string> {
  if (!aiEnabled()) throw new Error('ai disabled');
  const res = await fetch(endpoint('/v1/chat/completions'), {
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ai.model,
      messages,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.4,
      stream: true,
      ...(opts.noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`ai HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string; reasoning_content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        /* partial json — skip */
      }
    }
  }
  return full.trim();
}
