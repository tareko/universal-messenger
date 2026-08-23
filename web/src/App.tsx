import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { useSSE } from './hooks/useSSE';
import { requestNotificationPermission } from './hooks/useNotifications';
import { AccountSwitcher } from './components/AccountSwitcher';
import { AccountsDialog } from './components/AccountsDialog';
import { NotificationsDialog } from './components/NotificationsDialog';
import { AiDialog } from './components/AiDialog';
import { ChatList } from './components/ChatList';
import { Thread } from './components/Thread';
import { Composer } from './components/Composer';
import type { AppStatus } from './types';

export function App() {
  useSSE();
  const init = useStore((s) => s.init);
  const status = useStore((s) => s.status);
  const sseStatus = useStore((s) => s.sseStatus);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const selectedChat = useStore((s) => s.selectedChat);
  const aiEnabled = useStore((s) => s.status?.ai?.enabled ?? false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className={`app${selectedChat ? ' chat-open' : ''}`} onClick={() => requestNotificationPermission()}>
      <ProviderOutageBanner status={status} sseStatus={sseStatus} onOpenAccounts={() => setAccountsOpen(true)} />
      <aside className="sidebar">
        <header className="sidebar-header">
          <AccountSwitcher />
          <button className="tool-btn" title="Accounts" onClick={() => setAccountsOpen(true)}>
            ⚙
          </button>
        </header>
        <ChatList />
        <StatusBar status={status} sseStatus={sseStatus} onOpenNotify={() => setNotifyOpen(true)} onOpenAi={() => setAiOpen(true)} aiEnabled={aiEnabled} />
      </aside>

      <main className="main">
        {loading && <div className="loading-bar">Connecting…</div>}
        {error && <div className="error-bar">{error}</div>}
        <Thread />
        <Composer />
      </main>

      {accountsOpen && <AccountsDialog onClose={() => setAccountsOpen(false)} />}
      {notifyOpen && <NotificationsDialog onClose={() => setNotifyOpen(false)} />}
      {aiOpen && <AiDialog onClose={() => setAiOpen(false)} />}
    </div>
  );
}

function StatusBar({
  status,
  sseStatus,
  onOpenNotify,
  onOpenAi,
  aiEnabled,
}: {
  status: ReturnType<typeof useStore.getState>['status'];
  sseStatus: 'connecting' | 'connected';
  onOpenNotify: () => void;
  onOpenAi: () => void;
  aiEnabled: boolean;
}) {
  const [stealth, setStealth] = useState(() => localStorage.getItem('um-hide-previews') === '1');
  if (!status) return null;
  const providerSummary = Object.entries(status.providers)
    .map(([id, s]) => `${id}: ${s}`)
    .join(' · ');

  function toggleStealth() {
    const next = !stealth;
    setStealth(next);
    localStorage.setItem('um-hide-previews', next ? '1' : '0');
  }

  return (
    <footer className="status-bar">
      <button className="stealth-toggle" title="Notification settings" onClick={onOpenNotify}>
        🔔
      </button>
      <span>
        <span className={`sse-dot ${sseStatus}`} />
        {sseStatus === 'connected' ? 'Live' : 'Reconnecting'}
      </span>
      <span title={providerSummary}>📡</span>
      <span title={`Contacts: ${status.carddav}`}>👤</span>
      {aiEnabled && (
        <button className="stealth-toggle" title="AI settings" onClick={onOpenAi}>
          ✨
        </button>
      )}
      <button
        className={`stealth-toggle${stealth ? ' on' : ''}`}
        title={stealth ? 'Notification previews hidden — click to show' : 'Hide notification previews'}
        onClick={toggleStealth}
      >
        {stealth ? '🙈' : '👁'}
      </button>
    </footer>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  signal: 'Signal',
  mattermost: 'Mattermost',
  voipms: 'voip.ms SMS',
};

/** A provider is "down" when it was ever connected and now isn't.
 *  Unconfigured providers (needs-api / idle with no account) don't count. */
function providerDown(state: string): boolean {
  if (/^ok|^open/.test(state)) return false;
  if (state === 'needs-api') return false; // never configured — not an outage
  return true; // error, close, qr (logged out), connecting, etc.
}

/**
 * Prominent banner when a connected service drops (WhatsApp logout,
 * Mattermost error, …) or the realtime stream is down. Dismiss manually,
 * or it re-arms automatically once everything is healthy again.
 */
function ProviderOutageBanner({
  status,
  sseStatus,
  onOpenAccounts,
}: {
  status: AppStatus | null;
  sseStatus: 'connecting' | 'connected';
  onOpenAccounts: () => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Providers we've seen healthy this session — only they can trigger a banner
  // (avoids "voipms down" on a fresh box where it was never set up).
  const seenHealthy = useRef(new Set<string>());

  if (!status) return null;
  const downs: string[] = [];
  for (const [id, state] of Object.entries(status.providers)) {
    if (/^ok|^open/.test(state)) {
      seenHealthy.current.add(id);
    } else if (seenHealthy.current.has(id) && providerDown(state)) {
      downs.push(id);
    }
  }
  const sseDown = sseStatus !== 'connected';
  const sseKey = sseDown ? 'sse' : '';
  const key = [sseKey, ...downs].sort().join(',') || null;
  const allHealthy = !sseDown && downs.length === 0;
  // Once everything recovers, forget the dismissal so a new outage re-banners.
  if (allHealthy && dismissed !== null) setDismissed(null);
  const show = key && key !== dismissed;
  if (!show) return null;

  const names = downs.map((id) => PROVIDER_LABELS[id] ?? id);
  let text: string;
  if (sseDown && downs.length) {
    text = `Connection lost — ${names.join(', ')} ${downs.length > 1 ? 'are' : 'is'} down`;
  } else if (sseDown) {
    text = 'Connection lost — reconnecting…';
  } else {
    text = `${names.join(', ')} ${downs.length > 1 ? 'are' : 'is'} disconnected`;
  }

  return (
    <div className="outage-banner" role="alert">
      <span className="outage-icon">⚠</span>
      <span className="outage-text">
        {text}
        {downs.length === 1 && downs[0] === 'whatsapp' && /qr|close/.test(status.providers.whatsapp) && (
          <button className="outage-action" onClick={onOpenAccounts}>
            Re-link (QR)
          </button>
        )}
      </span>
      <button className="outage-dismiss" title="Dismiss" onClick={() => setDismissed(key)}>
        ✕
      </button>
    </div>
  );
}
