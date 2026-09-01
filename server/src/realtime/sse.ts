import type { Response } from 'express';
import type { SseEvent } from '../types.js';

const clients = new Set<Response>();

export function addClient(res: Response): () => void {
  clients.add(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  // Diagnostic: connection churn — log who connects and how long they stay.
  const connectedAt = Date.now();
  const req = res.req;
  const who = `${req.ip}${req.headers['x-forwarded-for'] ? ` (via ${req.headers['x-forwarded-for']})` : ''} ${String(req.headers['user-agent'] ?? '').slice(0, 60)}`;
  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 25000);
  const remove = () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(
      `[sse] client left after ${Math.round((Date.now() - connectedAt) / 1000)}s (${clients.size} remaining) — ${who}`
    );
  };
  res.on('close', remove);
  console.log(`[sse] client connected (${clients.size} total) — ${who}`);
  return remove;
}

export function broadcast(event: SseEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

/** Relay a "someone is typing" hint (auto-expires client-side). */
export function broadcastTyping(chatId: string, name: string | null, ttlMs = 6000): void {
  broadcast({ type: 'typing', data: { chatId, name, expiresAt: Date.now() + ttlMs } });
}
