import type { Message } from '../types';
import { useStore } from '../store';

let permissionAsked = false;

/** Per-chat unread counters for stealth-mode notifications. */
const stealthCounts = new Map<string, number>();

// Reset a chat's counter when it becomes the open chat (member chats too
// when a linked person is opened).
useStore.subscribe((s, prev) => {
  if (s.selectedChat && s.selectedChat !== prev.selectedChat) {
    stealthCounts.delete(s.selectedChat);
    const person = s.people.find(
      (p) => `person:${p.id}` === s.selectedChat || p.chatIds.includes(s.selectedChat!)
    );
    for (const id of person?.chatIds ?? []) stealthCounts.delete(id);
  }
});

export function requestNotificationPermission() {
  if (permissionAsked || typeof Notification === 'undefined') return;
  permissionAsked = true;
  if (Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

function displayName(msg: Message): string {
  const chat = useStore.getState().chats.find((c) => c.id === msg.chatId);
  return chat?.name ?? chat?.title ?? chat?.contactRaw ?? msg.chatId;
}

/** Show a browser notification for an inbound message if the chat isn't focused. */
export function notifyNewMessage(msg: Message, selectedChat: string | null) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  const isFocusedChat =
    document.visibilityState === 'visible' && selectedChat === msg.chatId;
  if (isFocusedChat) return;

  const s = useStore.getState();
  // Fine-grained rules: muted chat/person, per-provider toggles.
  if (s.notifySettings.mutedChats.includes(msg.chatId)) return;
  const person = s.people.find((p) => p.chatIds.includes(msg.chatId));
  if (person && s.notifySettings.mutedChats.includes(`person:${person.id}`)) return;
  const provider = msg.accountId.split(':')[0];
  const chat = s.chats.find((c) => c.id === msg.chatId);
  const rules = s.notifySettings.providers[provider];
  if (rules) {
    if (!rules.enabled) return;
    const type = chat?.type ?? 'dm';
    if (type === 'dm' && !rules.dm) return;
    if (type === 'group' && !rules.group) return;
    if (type === 'channel' && !rules.channel) return;
  }

  // Privacy mode: sender + count, never the content.
  const stealth = localStorage.getItem('um-hide-previews') === '1';
  const name = displayName(msg);
  let title = name;
  let body: string = msg.body || (msg.media?.length ? '📎 Attachment' : '');
  if (stealth) {
    const n = (stealthCounts.get(msg.chatId) ?? 0) + 1;
    stealthCounts.set(msg.chatId, n);
    title = name;
    body = `${n} new message${n === 1 ? '' : 's'}`;
  }
  const n = new Notification(title, { body, tag: `um-${msg.chatId}` });
  n.onclick = () => {
    window.focus();
    void useStore.getState().selectChat(msg.chatId);
    n.close();
  };
  setTimeout(() => n.close(), 8000);
}
