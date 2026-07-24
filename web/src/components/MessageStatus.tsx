import type { Message } from '../types';

/**
 * Renders the per-message status icon for outgoing messages:
 * ⏳ sending · ✓ sent · ⚠ failed. Hover shows a legend tooltip.
 * Click on 'failed' retries a text-only send.
 */
export function MessageStatus({
  msg,
  onRetry,
}: {
  msg: Message;
  onRetry?: (msg: Message) => void;
}) {
  if (msg.outgoing !== 1) return null;

  const icon: 'sending' | 'sent' | 'failed' =
    msg.status === 'sending' ? 'sending' : msg.status === 'failed' ? 'failed' : 'sent';

  const label =
    icon === 'sending'
      ? 'Sending… (clock = still sending)'
      : icon === 'failed'
        ? `Failed to send${msg.error ? `: ${msg.error}` : ''} (click to retry)`
        : 'Sent (single check = sent)';

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
