import { getKv, setKv, getChat, getChatPersonMap } from '../store/db.js';

export interface ProviderNotifyRules {
  enabled: boolean;
  dm: boolean;
  group: boolean;
  channel: boolean;
}

export interface NotifySettings {
  providers: Record<string, ProviderNotifyRules>;
  /** Muted chats ('<chatId>') and muted people ('person:<id>'). */
  mutedChats: string[];
  /** Explicitly UNmuted chats/people (overrides the default group mute). */
  unmutedChats: string[];
}

const DEFAULT_RULES: ProviderNotifyRules = { enabled: true, dm: true, group: true, channel: true };

export function getNotifySettings(): NotifySettings {
  try {
    const raw = getKv('notify:settings');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NotifySettings>;
      return {
        providers: parsed.providers ?? {},
        mutedChats: parsed.mutedChats ?? [],
        unmutedChats: parsed.unmutedChats ?? [],
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return { providers: {}, mutedChats: [], unmutedChats: [] };
}

export function saveNotifySettings(s: NotifySettings): void {
  setKv('notify:settings', JSON.stringify(s));
}

/** Should a message in this chat produce a notification? */
export function shouldNotify(chatId: string, settings?: NotifySettings): boolean {
  const s = settings ?? getNotifySettings();
  const chat = getChat(chatId);

  // Hidden conversations never notify.
  if (chat?.hidden) return false;

  // Muted chat, or muted person containing this chat.
  if (s.mutedChats.includes(chatId)) return false;
  const personId = getChatPersonMap().get(chatId);
  if (personId !== undefined && s.mutedChats.includes(`person:${personId}`)) return false;

  // Per-provider rules (default: everything on).
  const provider = chatId.split(':')[0];
  const rules = s.providers[provider] ?? DEFAULT_RULES;
  if (!rules.enabled) return false;
  const type = chat?.type ?? 'dm';
  if (type === 'dm' && !rules.dm) return false;
  if (type === 'group' && !rules.group) return false;
  if (type === 'channel' && !rules.channel) return false;

  // Groups/channels are muted BY DEFAULT unless pinned into the main list
  // or explicitly unmuted (chat or person level).
  if (type !== 'dm') {
    const pinned = Boolean(chat?.pinned);
    const unmuted =
      s.unmutedChats.includes(chatId) ||
      (personId !== undefined && s.unmutedChats.includes(`person:${personId}`));
    if (!pinned && !unmuted) return false;
  }
  return true;
}
