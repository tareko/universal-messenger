import type { Message } from '../types';
import { useStore } from '../store';

let permissionAsked = false;

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

  // Privacy mode: no sender or content in the notification.
  const stealth = localStorage.getItem('um-hide-previews') === '1';
  const n = new Notification(stealth ? 'New message' : displayName(msg), {
    body: stealth ? '' : msg.body || (msg.media?.length ? '📎 Attachment' : ''),
    tag: `um-${msg.chatId}`,
  });
  n.onclick = () => {
    window.focus();
    void useStore.getState().selectChat(msg.chatId);
    n.close();
  };
  setTimeout(() => n.close(), 8000);
}
