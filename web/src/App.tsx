import { useEffect, useState } from 'react';
import { useStore } from './store';
import { useSSE } from './hooks/useSSE';
import { requestNotificationPermission } from './hooks/useNotifications';
import { AccountSwitcher } from './components/AccountSwitcher';
import { AccountsDialog } from './components/AccountsDialog';
import { ChatList } from './components/ChatList';
import { Thread } from './components/Thread';
import { Composer } from './components/Composer';

export function App() {
  useSSE();
  const init = useStore((s) => s.init);
  const status = useStore((s) => s.status);
  const sseStatus = useStore((s) => s.sseStatus);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const selectedChat = useStore((s) => s.selectedChat);
  const [accountsOpen, setAccountsOpen] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className={`app${selectedChat ? ' chat-open' : ''}`} onClick={() => requestNotificationPermission()}>
      <aside className="sidebar">
        <header className="sidebar-header">
          <AccountSwitcher />
          <button className="tool-btn" title="Accounts" onClick={() => setAccountsOpen(true)}>
            ⚙
          </button>
        </header>
        <ChatList />
        <StatusBar status={status} sseStatus={sseStatus} />
      </aside>

      <main className="main">
        {loading && <div className="loading-bar">Connecting…</div>}
        {error && <div className="error-bar">{error}</div>}
        <Thread />
        <Composer />
      </main>

      {accountsOpen && <AccountsDialog onClose={() => setAccountsOpen(false)} />}
    </div>
  );
}

function StatusBar({
  status,
  sseStatus,
}: {
  status: ReturnType<typeof useStore.getState>['status'];
  sseStatus: 'connecting' | 'connected';
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
      <span>
        <span className={`sse-dot ${sseStatus}`} />
        {sseStatus === 'connected' ? 'Live' : 'Reconnecting'}
      </span>
      <span title={providerSummary}>📡</span>
      <span title={`Contacts: ${status.carddav}`}>👤</span>
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
