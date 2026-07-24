import { config } from '../config.js';
import { getPushEndpoints } from '../store/db.js';

export interface NotifyEvent {
  name: string; // display name of the chat
  chatId: string;
  preview: string;
  id: string; // message id
}

/**
 * Fan a new-message notification out to all subscribers:
 *   - the shared ntfy topic (desktop subscribers)
 *   - each registered UnifiedPush endpoint (companion apps)
 *
 * The shared topic carries Title=name + body=preview (plain text) so desktop
 * `ntfy subscribe | notify-send` works without parsing.
 */
export async function notifyMessage(ev: NotifyEvent): Promise<void> {
  const body = ev.preview.slice(0, 200);
  const headers: Record<string, string> = {
    Title: ev.name,
    Tags: 'speech_balloon',
    'X-Chat-Id': ev.chatId,
    'X-Message-Id': ev.id,
  };
  if (config.ntfy.token) headers.Authorization = `Bearer ${config.ntfy.token}`;

  const targets: string[] = [];
  if (config.ntfy.url && config.ntfy.topic) {
    targets.push(`${config.ntfy.url}/${config.ntfy.topic}`);
  }
  for (const ep of getPushEndpoints()) targets.push(ep);

  await Promise.all(
    targets.map(async (url) => {
      try {
        const res = await fetch(url, { method: 'POST', headers, body });
        if (!res.ok) console.error(`[notify] ${url} -> HTTP ${res.status}`);
      } catch (e) {
        console.error(`[notify] ${url} failed:`, (e as Error).message);
      }
    })
  );
}
