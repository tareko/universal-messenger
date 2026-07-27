import { chat as aiChat, chatStream, aiEnabled, type ChatOptions } from './client.js';
import {
  suggestRepliesPrompt,
  summarizePrompt,
  translatePrompt,
  toHistoryLines,
  formatHistory,
  historyWithinBudget,
} from './prompts.js';
import { getMessages } from '../store/db.js';
import type { Chat } from '../types.js';

const SUGGEST_BUDGET = 8_000; // chars of history
const SUMMARY_BUDGET = 48_000; // chars of history (~13k tokens)

/** 3 short draft replies based on the tail of the conversation. */
export async function suggestReplies(chat: Chat): Promise<string[]> {
  const messages = getMessages(chat.id, 40);
  const lines = historyWithinBudget(toHistoryLines(messages), SUGGEST_BUDGET);
  if (!lines.length) return [];
  const raw = await aiChat(suggestRepliesPrompt(chat.name ?? chat.title ?? 'chat', formatHistory(lines)), {
    maxTokens: 300,
    temperature: 0.6,
    noThinking: true,
  });
  return raw
    .split('\n')
    .map((l) => l.replace(/^\s*[-*\d.)\]]+\s*/, '').trim())
    .filter((l) => l.length > 0 && l.length <= 220)
    .slice(0, 3);
}

/**
 * Streamed backlog summary. Uses the unread window when available, otherwise
 * the most recent messages. Calls onDelta with each streamed chunk.
 */
export async function summarizeChat(
  chat: Chat,
  opts: { sinceTs?: number; onDelta?: (text: string) => void } = {}
): Promise<string> {
  let messages = getMessages(chat.id, 500);
  if (opts.sinceTs) {
    const windowed = messages.filter((m) => m.ts >= (opts.sinceTs ?? 0));
    if (windowed.length) messages = windowed;
  }
  const lines = historyWithinBudget(toHistoryLines(messages), SUMMARY_BUDGET);
  if (!lines.length) return 'Nothing to summarize.';
  const prompt = summarizePrompt(chat.name ?? chat.title ?? 'chat', formatHistory(lines));
  const opts2: ChatOptions = { maxTokens: 700, temperature: 0.3, noThinking: true };
  if (opts.onDelta) return chatStream(prompt, opts2, opts.onDelta);
  return aiChat(prompt, opts2);
}

/** Translate a single message's text, preserving structure. */
export async function translateText(text: string, targetLang?: string): Promise<string> {
  if (!text.trim()) return '';
  return aiChat(translatePrompt(text, targetLang), {
    maxTokens: Math.min(1000, Math.max(200, text.length)),
    temperature: 0.2,
    noThinking: true,
  });
}

export { aiEnabled };
