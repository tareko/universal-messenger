import type { ReactNode } from 'react';

/**
 * Lightweight markdown renderer for message bubbles. Handles both the
 * WhatsApp variant (*bold*, _italic_, ~strike~, `mono`, ```blocks```) and
 * common Markdown (**bold**, *italic* / _italic_, ~~strike~~), plus bare-URL
 * linkification. Renders React nodes only — no HTML injection.
 *
 * The `*text*` ambiguity (bold on WhatsApp, italic on Mattermost) is
 * resolved per provider.
 */

interface Block {
  code?: string;
  text?: string;
  quote?: string;
}

function splitCodeBlocks(text: string): Block[] {
  const re = /```([\s\S]*?)```/g;
  const out: Block[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ code: m[1].replace(/^\n+|\n+$/g, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Group consecutive "> " lines into quote blocks (fallback quote format). */
function splitQuoteLines(text: string): Block[] {
  const out: Block[] = [];
  let quote: string[] = [];
  let normal: string[] = [];
  const flushQ = () => {
    if (quote.length) {
      out.push({ quote: quote.join('\n') });
      quote = [];
    }
  };
  const flushN = () => {
    if (normal.length) {
      out.push({ text: normal.join('\n') });
      normal = [];
    }
  };
  for (const line of text.split('\n')) {
    if (line === '>' || line.startsWith('> ')) {
      flushN();
      quote.push(line.replace(/^> ?/, ''));
    } else {
      flushQ();
      normal.push(line);
    }
  }
  flushQ();
  flushN();
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inline(
  text: string,
  provider: string,
  keyBase: number,
  mentions?: { name: string; memberId: string }[],
  onMentionClick?: (memberId: string) => void
): ReactNode[] {
  const italicSingle = provider === 'mattermost'; // *x* = italic there, bold elsewhere
  // Build a mention alternation from known participant names (longest first).
  const names = (mentions ?? []).map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  const mentionRe = names.length
    ? new RegExp(`@(${names.map(escapeRe).join('|')})`, 'g')
    : null;
  const re = /(`[^`]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(~[^~\n]+~)|(https?:\/\/[^\s<>"')\]]+)/g;
  const out: ReactNode[] = [];

  function pushStyled(segment: string, k0: number) {
    let last = 0;
    let k = k0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment))) {
      if (m.index > last) out.push(segment.slice(last, m.index));
      const [full, code, bold2, single, italic, strike2, strike, link] = m;
      const key = `${keyBase}-${k++}`;
      if (code) {
        out.push(
          <code key={key} className="md-code">
            {code.slice(1, -1)}
          </code>
        );
      } else if (bold2) {
        out.push(<strong key={key}>{bold2.slice(2, -2)}</strong>);
      } else if (single) {
        const inner = single.slice(1, -1);
        out.push(italicSingle ? <em key={key}>{inner}</em> : <strong key={key}>{inner}</strong>);
      } else if (italic) {
        out.push(<em key={key}>{italic.slice(1, -1)}</em>);
      } else if (strike2) {
        out.push(<s key={key}>{strike2.slice(2, -2)}</s>);
      } else if (strike) {
        out.push(<s key={key}>{strike.slice(1, -1)}</s>);
      } else if (link) {
        out.push(
          <a key={key} href={link} target="_blank" rel="noreferrer" className="md-link">
            {link}
          </a>
        );
      }
      last = m.index + full.length;
    }
    if (last < segment.length) out.push(segment.slice(last));
    return k;
  }

  // Mentions first (they win over other inline formatting).
  if (mentionRe) {
    let last = 0;
    let k = 0;
    let m: RegExpExecArray | null;
    while ((m = mentionRe.exec(text))) {
      if (m.index > last) k = pushStyled(text.slice(last, m.index), k);
      const name = m[1];
      const mention = mentions!.find((x) => x.name === name)!;
      out.push(
        <a
          key={`${keyBase}-m${k++}`}
          className="md-mention"
          role="button"
          onClick={(e) => {
            e.preventDefault();
            onMentionClick?.(mention.memberId);
          }}
        >
          @{name}
        </a>
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) pushStyled(text.slice(last), k);
    return out;
  }

  pushStyled(text, 0);
  return out;
}

export function Formatted({
  text,
  provider,
  mentions,
  onMentionClick,
}: {
  text: string;
  provider: string;
  mentions?: { name: string; memberId: string }[];
  onMentionClick?: (memberId: string) => void;
}) {
  // Split "> " quote lines first, then code blocks + inline per segment.
  const segments = splitQuoteLines(text).flatMap((seg) =>
    seg.quote !== undefined ? [seg] : splitCodeBlocks(seg.text ?? '')
  );
  // A message that is ENTIRELY a quote renders at full strength (it's the
  // content, not a reference); a quote followed by the sender's own text
  // stays muted.
  const quoteOnly = segments.length > 0 && segments.every((b) => b.quote !== undefined);
  return (
    <>
      {segments.map((b, i) =>
        b.quote !== undefined ? (
          <div key={i} className={quoteOnly ? 'md-quote-full' : 'md-quote'} dir="auto">
            {inline(b.quote, provider, i, mentions, onMentionClick)}
          </div>
        ) : b.code !== undefined ? (
          <pre key={i} className="md-pre">
            <code>{b.code}</code>
          </pre>
        ) : (
          <span key={i}>{inline(b.text ?? '', provider, i, mentions, onMentionClick)}</span>
        )
      )}
    </>
  );
}
