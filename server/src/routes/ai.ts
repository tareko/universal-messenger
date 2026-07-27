import { Router } from 'express';
import { getChat } from '../store/db.js';
import { aiEnabled, suggestReplies, summarizeChat, translateText } from '../ai/actions.js';

export const aiApi = Router();

// All AI routes are inert when the harness is disabled.
aiApi.use((_req, res, next) => {
  if (!aiEnabled()) return res.status(404).json({ error: 'ai disabled' });
  next();
});

aiApi.get('/ai/status', (_req, res) => {
  res.json({ enabled: aiEnabled() });
});

/** 3 short draft replies for a chat. */
aiApi.post('/ai/suggest', async (req, res) => {
  try {
    const { chatId } = req.body as { chatId: string };
    const chat = chatId ? getChat(chatId) : null;
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    res.json({ suggestions: await suggestReplies(chat) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Streamed backlog summary over SSE (data: {delta} / {done} / {error}). */
aiApi.post('/ai/summary', async (req, res) => {
  const { chatId, sinceTs } = req.body as { chatId: string; sinceTs?: number };
  const chat = chatId ? getChat(chatId) : null;
  if (!chat) return res.status(404).json({ error: 'chat not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  try {
    await summarizeChat(chat, {
      sinceTs,
      onDelta: (delta) => res.write(`data: ${JSON.stringify({ delta })}\n\n`),
    });
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
  }
  res.end();
});

/** Translate a text snippet (e.g. one message). */
aiApi.post('/ai/translate', async (req, res) => {
  try {
    const { text, targetLang } = req.body as { text: string; targetLang?: string };
    if (!text) return res.status(400).json({ error: 'text required' });
    res.json({ translation: await translateText(text, targetLang) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
