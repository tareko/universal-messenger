import { useStore } from '../store';

const PROVIDER_BADGE: Record<string, string> = {
  voipms: 'SMS',
  whatsapp: 'WA',
  telegram: 'TG',
  mattermost: 'MM',
};

export function providerBadge(provider: string): string {
  return PROVIDER_BADGE[provider] ?? provider.slice(0, 3).toUpperCase();
}

export function AccountSwitcher() {
  const accounts = useStore((s) => s.accounts);
  const selectedAccount = useStore((s) => s.selectedAccount);
  const selectAccount = useStore((s) => s.selectAccount);

  if (accounts.length === 0) {
    return (
      <div className="did-switcher">
        <span className="did-label">No accounts connected</span>
      </div>
    );
  }

  return (
    <div className="did-switcher">
      <select
        value={selectedAccount}
        onChange={(e) => void selectAccount(e.target.value)}
        title="Filter by account"
      >
        <option value="all">All accounts</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            [{providerBadge(a.provider)}] {a.label}
          </option>
        ))}
      </select>
    </div>
  );
}
