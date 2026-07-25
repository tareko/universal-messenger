import { useStore } from '../store';
import { providerBadge } from './AccountSwitcher';
import type { ProviderNotifyRules } from '../types';

const PROVIDER_LABELS: Record<string, string> = {
  voipms: 'SMS (voip.ms)',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  mattermost: 'Mattermost',
  signal: 'Signal',
};

const TYPE_LABELS: { key: keyof Omit<ProviderNotifyRules, 'enabled'>; label: string }[] = [
  { key: 'dm', label: 'Direct messages' },
  { key: 'group', label: 'Groups' },
  { key: 'channel', label: 'Channels' },
];

/** Modal: per-provider + per-chat-type notification rules. */
export function NotificationsDialog({ onClose }: { onClose: () => void }) {
  const notifySettings = useStore((s) => s.notifySettings);
  const saveNotifySettings = useStore((s) => s.saveNotifySettings);

  function rulesFor(provider: string): ProviderNotifyRules {
    return notifySettings.providers[provider] ?? { enabled: true, dm: true, group: true, channel: true };
  }

  function toggle(provider: string, key: keyof ProviderNotifyRules) {
    const current = rulesFor(provider);
    void saveNotifySettings({
      ...notifySettings,
      providers: {
        ...notifySettings.providers,
        [provider]: { ...current, [key]: !current[key] },
      },
    });
  }

  const providers = Object.keys(PROVIDER_LABELS).filter(
    (p) => Object.keys(notifySettings.providers).includes(p) || true
  );

  return (
    <>
      <div className="dialog-backdrop" onClick={onClose} />
      <div className="dialog" role="dialog" aria-label="Notification settings">
        <div className="dialog-title">Notifications</div>
        <div className="dialog-list">
          {providers.map((p) => {
            const rules = rulesFor(p);
            return (
              <div key={p} className="notify-provider">
                <label className="notify-provider-head">
                  <span className="provider-badge">{providerBadge(p)}</span>
                  <span className="notify-provider-name">{PROVIDER_LABELS[p] ?? p}</span>
                  <input
                    type="checkbox"
                    checked={rules.enabled}
                    onChange={() => toggle(p, 'enabled')}
                  />
                </label>
                {rules.enabled && (
                  <div className="notify-provider-types">
                    {TYPE_LABELS.map((t) => (
                      <label key={t.key} className="notify-type-toggle">
                        <input
                          type="checkbox"
                          checked={rules[t.key]}
                          onChange={() => toggle(p, t.key)}
                        />
                        {t.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}
