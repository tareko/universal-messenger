import type { Message } from '../types';

import type { Message } from '../types';

const PROVIDER_NAME: Record<string, string> = {
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  telegram: 'Telegram',
  voipms: 'SMS',
  mattermost: 'Mattermost',
};

/**
 * Outgoing status: ⏳ sending · ✓ sent to server · ✓✓ delivered · ✓✓ blue read
 * (receipt states only exist where the provider supports them — WhatsApp,
 * Signal, Telegram). Hover shows a legend; click on 'failed' retries.
 */
export function MessageStatus({
  msg,
  onRetry,
}: {
  msg: Message;
  onRetry?: (msg: Message) => void;
}) {
  if (msg.outgoing !== 1) return null;

  const icon: 'sending' | 'sent' | 'delivered' | 'read' | 'failed' =
    msg.status === 'sending'
      ? 'sending'
      : msg.status === 'failed'
        ? 'failed'
        : msg.receipt === 'read'
          ? 'read'
          : msg.receipt === 'delivered'
            ? 'delivered'
            : 'sent';

  const provider = PROVIDER_NAME[msg.accountId.split(':')[0]] ?? 'the service';
  const label =
    icon === 'sending'
      ? 'Sending… (clock = still sending)'
      : icon === 'failed'
        ? `Failed to send${msg.error ? `: ${msg.error}` : ''} (click to retry)`
        : icon === 'read'
          ? `Read by recipient (${provider})`
          : icon === 'delivered'
            ? `Received by recipient (${provider})`
            : `Sent to ${provider} server`;

  const clickable = icon === 'failed' && onRetry && !msg.media?.length;
  return (
    <span
      className={`msg-status ${icon}${clickable ? ' clickable' : ''}`}
      data-tooltip={label}
      title={label}
      onClick={clickable ? () => onRetry(msg) : undefined}
    >
      {icon === 'sending' && <ClockSvg />}
      {icon === 'sent' && <CheckSvg />}
      {(icon === 'delivered' || icon === 'read') && <ChecksSvg blue={icon === 'read'} />}
      {icon === 'failed' && <span className="msg-status-glyph">⚠</span>}
    </span>
  );
}

  const clickable = icon === 'failed' && onRetry && !msg.media?.length;
  return (
    <span
      className={`msg-status ${icon}${clickable ? ' clickable' : ''}`}
      data-tooltip={label}
      title={label}
      onClick={clickable ? () => onRetry(msg) : undefined}
    >
      {icon === 'sending' && <ClockSvg />}
      {icon === 'sent' && <CheckSvg />}
      {(icon === 'delivered' || icon === 'read') && <ChecksSvg blue={icon === 'read'} />}
      {icon === 'failed' && <span className="msg-status-glyph">⚠</span>}
    </span>
  );
}

function ClockSvg() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="msg-status-svg spin">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 4.5V8l2.4 1.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CheckSvg() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" className="msg-status-svg">
      <path
        d="M3 8.5l3.2 3.2L13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Double checkmark (WhatsApp-style); blue when read. */
function ChecksSvg({ blue }: { blue: boolean }) {
  return (
    <svg viewBox="0 0 20 16" width="18" height="14" className={`msg-status-svg${blue ? ' blue' : ''}`}>
      <path
        d="M2 8.5l3.2 3.2L12 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 8.5l3.2 3.2L18 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
