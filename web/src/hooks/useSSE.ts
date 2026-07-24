import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { getToken } from '../api';
import { notifyNewMessage } from './useNotifications';
import type { SseEvent } from '../types';

export function useSSE() {
  // Subscribe to store values so this component re-renders (and refs update).
  const onMessage = useStore((s) => s.onMessage);
  const onMessageUpdated = useStore((s) => s.onMessageUpdated);
  const onMessageDeleted = useStore((s) => s.onMessageDeleted);
  const onTyping = useStore((s) => s.onTyping);
  const setAccounts = useStore((s) => s.setAccounts);
  const patchStatus = useStore((s) => s.patchStatus);
  const refreshChats = useStore((s) => s.refreshChats);
  const refreshMessages = useStore((s) => s.refreshMessages);
  const selectedChat = useStore((s) => s.selectedChat);

  // Refs updated every render — avoids stale closures inside EventSource
  // callbacks and the 30s interval (which runs once but needs fresh handlers).
  const handlers = useRef({
    onMessage, onMessageUpdated, onMessageDeleted, onTyping, setAccounts, patchStatus,
    refreshChats, refreshMessages, selectedChat,
  });
  handlers.current = {
    onMessage, onMessageUpdated, onMessageDeleted, onTyping, setAccounts, patchStatus,
    refreshChats, refreshMessages, selectedChat,
  };

  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const createES = () => {
      if (esRef.current) esRef.current.close();
      useStore.setState({ sseStatus: 'connecting' });
      const token = getToken();
      const es = new EventSource(`/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      esRef.current = es;

      es.onopen = () => {
        useStore.setState({ sseStatus: 'connected' });
        const h = handlers.current;
        void h.refreshChats();
        void h.refreshMessages();
      };

      es.onmessage = (ev) => {
        if (!ev.data) return;
        let event: SseEvent;
        try {
          event = JSON.parse(ev.data) as SseEvent;
        } catch {
          return;
        }
        const h = handlers.current;
        switch (event.type) {
          case 'message':
            void h.onMessage(event.data);
            if (event.data.outgoing === 0) {
              notifyNewMessage(event.data, h.selectedChat);
            }
            break;
          case 'message-updated':
            h.onMessageUpdated(event.data);
            break;
          case 'message-deleted':
            h.onMessageDeleted(event.data.id);
            break;
          case 'typing':
            h.onTyping(event.data);
            break;
          case 'chats-updated':
            void h.refreshChats();
            break;
          case 'accounts':
            h.setAccounts(event.data);
            break;
          case 'status':
            h.patchStatus(event.data);
            break;
          case 'contacts-refreshed':
            void h.refreshChats();
            break;
        }
      };

      es.onerror = () => {
        useStore.setState({ sseStatus: 'connecting' });
      };
    };

    createES();

    // 30s safety net: force-reconnect dead EventSource + refresh data as a
    // fallback for any events missed while SSE was down.
    const interval = setInterval(() => {
      const es = esRef.current;
      if (!es || es.readyState === EventSource.CLOSED) {
        createES();
        return;
      }
      const h = handlers.current;
      void h.refreshChats();
      if (useStore.getState().selectedChat) void h.refreshMessages();
    }, 30000);

    return () => {
      clearInterval(interval);
      if (esRef.current) esRef.current.close();
    };
  }, []); // run once — handlers via ref stay fresh
}
