import { useCallback, useEffect, useState } from 'react';
import { api, type MattermostState, type TelegramState, type WhatsAppState } from '../api';
import { useStore } from '../store';
import { providerBadge } from './AccountSwitcher';

/** Modal: manage connected accounts + link new providers. */
export function AccountsDialog({ onClose }: { onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const refreshChats = useStore((s) => s.refreshChats);
  const [wa, setWa] = useState<WhatsAppState | null>(null);
  const [tg, setTg] = useState<TelegramState | null>(null);
  const [mm, setMm] = useState<MattermostState | null>(null);
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async () => {
    try {
      const st = await api.whatsappStatus();
      setWa(st.state === 'qr' ? await api.whatsappQr() : st);
    } catch {
      /* keep last known state */
    }
    try {
      setTg(await api.telegramStatus());
    } catch {
      /* keep last known state */
    }
    try {
      setMm(await api.mattermostStatus());
    } catch {
      /* keep last known state */
    }
  }, []);

  // Poll while the dialog is open (QR/code pairing is time-sensitive).
  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => clearInterval(t);
  }, [poll]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await poll();
      await refreshChats();
    } finally {
      setBusy(false);
    }
  }

  const waAccount = accounts.find((a) => a.provider === 'whatsapp');
  const tgAccount = accounts.find((a) => a.provider === 'telegram');
  const mmAccount = accounts.find((a) => a.provider === 'mattermost');

  return (
    <>
      <div className="dialog-backdrop" onClick={onClose} />
      <div className="dialog" role="dialog" aria-label="Accounts">
        <div className="dialog-title">Accounts</div>
        <div className="dialog-list">
          {accounts.map((a) => (
            <div key={a.id} className="account-row">
              <span className="provider-badge">{providerBadge(a.provider)}</span>
              <span className="account-label">{a.label}</span>
              <span className="account-status">{a.status}</span>
            </div>
          ))}
          {accounts.length === 0 && <div className="empty-hint">No accounts yet.</div>}
        </div>

        <div className="dialog-section">
          <div className="dialog-section-title">WhatsApp</div>
          {wa?.state === 'qr' && wa.qr ? (
            <div className="wa-qr">
              <img src={wa.qr} alt="WhatsApp pairing QR code" />
              <p>Scan with WhatsApp → Linked devices → Link a device</p>
            </div>
          ) : wa?.state === 'open' ? (
            <div className="wa-linked">
              <p>Linked{waAccount ? ` as ${waAccount.label}` : ''}.</p>
              <button
                className="dialog-cancel"
                disabled={busy}
                onClick={() => void run(() => api.whatsappLogout())}
              >
                Unlink device
              </button>
            </div>
          ) : (
            <div className="wa-linked">
              <p>
                {wa?.state === 'connecting'
                  ? 'Connecting…'
                  : 'Not linked. Link your WhatsApp like WhatsApp Web.'}
              </p>
              <button
                className="dialog-cancel"
                disabled={busy}
                onClick={() => void run(() => api.whatsappConnect())}
              >
                {wa?.state === 'connecting' ? 'Waiting…' : 'Connect WhatsApp'}
              </button>
            </div>
          )}
        </div>

        <TelegramSection tg={tg} account={tgAccount} busy={busy} run={run} />
        <MattermostSection mm={mm} account={mmAccount} busy={busy} run={run} />

        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

function MattermostSection({
  mm,
  account,
  busy,
  run,
}: {
  mm: MattermostState | null;
  account: { label: string } | undefined;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const connected = mm?.state === 'open' && !editing;
  // Pre-fill the server URL when opening the edit form.
  useEffect(() => {
    if (editing && mm?.url) setUrl(mm.url);
  }, [editing, mm?.url]);

  async function connect() {
    setError('');
    try {
      await run(() => api.mattermostConnect(url.trim(), token.trim()));
      setToken('');
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const form = (
    <div className="tg-form">
      <input
        placeholder="https://mm.example.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        placeholder={mm?.state === 'open' ? 'New personal access token' : 'Personal access token'}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <button
        className="dialog-cancel"
        disabled={busy || !url.trim() || !token.trim()}
        onClick={() => void connect()}
      >
        {mm?.state === 'connecting' ? 'Connecting…' : mm?.state === 'open' ? 'Save & reconnect' : 'Connect'}
      </button>
      {(error || mm?.state === 'error') && (
        <span className="attach-error">{error || 'Connection failed — check URL/token.'}</span>
      )}
    </div>
  );

  return (
    <div className="dialog-section">
      <div className="dialog-section-title">Mattermost</div>
      <label className="mm-dms-only">
        <input
          type="checkbox"
          checked={Boolean(mm?.dmsOnly)}
          onChange={(e) => void run(() => api.mattermostSettings(e.target.checked))}
        />
        DMs only (skip group channels)
      </label>
      {connected ? (
        <div className="wa-linked">
          <p>Connected{account ? ` as ${account.label}` : ''}.</p>
          <div className="mm-btn-row">
            <button className="dialog-cancel" disabled={busy} onClick={() => setEditing(true)}>
              Edit connection
            </button>
            <button className="dialog-cancel" disabled={busy} onClick={() => void run(() => api.mattermostLogout())}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="wa-linked">
          {!editing && (
            <p>
              Server URL and a personal access token (Mattermost → Profile → Security → Personal
              Access Tokens).
            </p>
          )}
          {form}
          {editing && (
            <button className="dialog-cancel" onClick={() => setEditing(false)}>
              Cancel edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TelegramSection({
  tg,
  account,
  busy,
  run,
}: {
  tg: TelegramState | null;
  account: { label: string } | undefined;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [value, setValue] = useState('');

  const submitCredential = () => {
    const v = value.trim();
    if (!v) return;
    setValue('');
    void run(() => api.telegramCredential(v));
  };

  return (
    <div className="dialog-section">
      <div className="dialog-section-title">Telegram</div>

      {tg?.state === 'open' ? (
        <div className="wa-linked">
          <p>Signed in{account ? ` as ${account.label}` : ''}.</p>
          <button className="dialog-cancel" disabled={busy} onClick={() => void run(() => api.telegramLogout())}>
            Sign out
          </button>
        </div>
      ) : tg?.state === 'needs-api' || (tg && !tg.hasApiCreds) ? (
        <div className="wa-linked">
          <p>
            Create an app at <code>my.telegram.org</code> → API development tools, then enter the
            credentials:
          </p>
          <div className="tg-form">
            <input
              placeholder="api_id"
              inputMode="numeric"
              value={apiId}
              onChange={(e) => setApiId(e.target.value)}
            />
            <input
              placeholder="api_hash"
              value={apiHash}
              onChange={(e) => setApiHash(e.target.value)}
            />
            <button
              className="dialog-cancel"
              disabled={busy || !apiId.trim() || !apiHash.trim()}
              onClick={() => void run(() => api.telegramCredentials(Number(apiId), apiHash.trim()))}
            >
              Save credentials
            </button>
          </div>
        </div>
      ) : tg?.state === 'awaiting-phone' ||
        tg?.state === 'awaiting-code' ||
        tg?.state === 'awaiting-password' ? (
        <div className="wa-linked">
          <p>
            {tg.state === 'awaiting-phone'
              ? 'Enter your phone number (international format, e.g. +15551234567):'
              : tg.state === 'awaiting-code'
                ? 'Enter the login code Telegram sent you:'
                : 'Enter your two-factor password:'}
          </p>
          <div className="tg-form">
            <input
              autoFocus
              type={tg.state === 'awaiting-password' ? 'password' : 'text'}
              inputMode={tg.state === 'awaiting-code' ? 'numeric' : 'text'}
              placeholder={
                tg.state === 'awaiting-phone'
                  ? '+15551234567'
                  : tg.state === 'awaiting-code'
                    ? '12345'
                    : 'Password'
              }
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCredential()}
            />
            <button className="dialog-cancel" disabled={busy || !value.trim()} onClick={submitCredential}>
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="wa-linked">
          <p>
            {tg?.state === 'connecting'
              ? 'Connecting…'
              : tg?.state === 'error'
                ? 'Sign-in failed. Try again.'
                : 'Not signed in. Sign in with your Telegram account.'}
          </p>
          <button
            className="dialog-cancel"
            disabled={busy || tg?.state === 'connecting'}
            onClick={() => void run(() => api.telegramConnect())}
          >
            {tg?.state === 'connecting' ? 'Waiting…' : 'Sign in to Telegram'}
          </button>
        </div>
      )}
    </div>
  );
}

