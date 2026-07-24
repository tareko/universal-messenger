import type { Message } from '../../types.js';

/**
 * iMessage tapback reactions arrive at plain-SMS endpoints (like voip.ms) as
 * fallback text. We parse those into emoji reactions and (when sending) emit
 * the same format — Google Messages interprets it as a native reaction; iOS
 * shows it as text (an unavoidable SMS limitation).
 */

/** verb (as it appears in the text) -> emoji */
export const VERB_TO_EMOJI: Record<string, string> = {
  loved: '❤️',
  liked: '👍',
  disliked: '👎',
  'laughed at': '😂',
  emphasized: '‼️',
  questioned: '❓',
};

/** emoji -> verb for sending */
export const EMOJI_TO_VERB: Record<string, string> = {
  '❤️': 'Loved',
  '👍': 'Liked',
  '👎': 'Disliked',
  '😂': 'Laughed at',
  '‼️': 'Emphasized',
  '❓': 'Questioned',
};

const VERBS = Object.keys(VERB_TO_EMOJI)
  .sort((a, b) => b.length - a.length)
  .join('|');

// Quote characters we strip around the quoted message: « » " " ' ' ' "
const QUOTES = '«»“”‘’\'"';

// "Liked «msg»", "Loved "msg"", "Laughed at msg", with optional quotes/«»/-.
const RE = new RegExp(
  `^(?:(${VERBS}))\\s*[${QUOTES}\\-]?\\s*([\\s\\S]+?)[${QUOTES}]?$`,
  'i'
);

// Inline-emoji "iOS 16+" fallback: e.g. `ah "❤️ to "your message`.
// Strip typographic hair/zero-width spaces first, then look for an emoji near
// the start followed by " to " and a quoted snippet.
const ZW = /[​‌﻿]/g;
const RE_TO = new RegExp(`^\\s{0,3}\\bto\\b\\s*[${QUOTES}]?\\s*([\\s\\S]+?)\\s*[${QUOTES}]?$`, 'i');

const REACTION_EMOJI_VARIANTS: { match: string; canon: string }[] = [
  { match: '❤️', canon: '❤️' },
  { match: '❤', canon: '❤️' },
  { match: '👍', canon: '👍' },
  { match: '👎', canon: '👎' },
  { match: '😂', canon: '😂' },
  { match: '😆', canon: '😂' },
  { match: '‼️', canon: '‼️' },
  { match: '‼', canon: '‼️' },
  { match: '❗', canon: '‼️' },
  { match: '❓', canon: '❓' },
];

function stripQuotes(s: string): string {
  const set = new Set([...QUOTES]);
  let t = s;
  while (t.length && set.has(t[0])) t = t.slice(1);
  while (t.length && set.has(t[t.length - 1])) t = t.slice(0, -1);
  return t.trim();
}

export interface DetectedReaction {
  emoji: string;
  quoted: string; // the message text that was reacted to
}

/** Detect an iMessage-style reaction fallback message (verb form or inline-emoji form). */
export function detectReaction(text: string): DetectedReaction | null {
  if (!text) return null;
  const t = text.replace(ZW, '').trim();
  if (t.length > 200) return null; // reactions are short; avoid false positives on long bodies

  // Form 1: "Loved «msg»" / "Liked "msg"" / "Laughed at msg"
  const m = t.match(RE);
  if (m) {
    const verb = m[1].toLowerCase();
    const emoji = VERB_TO_EMOJI[verb];
    const quoted = stripQuotes(m[2] ?? '');
    if (emoji && quoted.length >= 1) return { emoji, quoted };
  }

  // Form 2: inline emoji + " to " + quoted message (iOS 16+ heart-style)
  for (const v of REACTION_EMOJI_VARIANTS) {
    const idx = t.indexOf(v.match);
    if (idx >= 0 && idx <= 12) {
      const rest = t.slice(idx + v.match.length);
      const m2 = rest.match(RE_TO);
      if (m2) {
        const quoted = stripQuotes(m2[1] ?? '');
        if (quoted.length >= 2) return { emoji: v.canon, quoted };
      }
    }
  }
  return null;
}

/** Build the fallback text to send a reaction to a given message body. */
export function buildReactionText(emoji: string, targetText: string): string | null {
  const verb = EMOJI_TO_VERB[emoji];
  if (!verb) return null;
  const max = 150 - (verb.length + 4); // reserve "Verb «»"
  let body = targetText.replace(/\s+/g, ' ').trim();
  if (body.length > max) body = body.slice(0, max - 1) + '…';
  return `${verb} «${body}»`;
}

function norm(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Find the best message to attach a reaction to, given the quoted text.
 * Scores by exact > prefix > substring (tiers far apart so a long substring
 * can never beat an exact match). Most recent wins ties. iOS truncates long
 * messages, so prefix/substring matches are essential. Reaction texts
 * themselves are skipped (a reaction is never a target).
 */
export function matchTarget(messages: Message[], quoted: string): Message | null {
  const q = norm(quoted);
  if (!q) return null;

  // Image/media reactions ("Loved an image") — match the most recent message
  // that has media, since there's no text to compare.
  if (/^(an?\s+(image|photo|picture|attachment|video|gif|sticker|audio))$/i.test(q)) {
    let mediaMsg: Message | null = null;
    for (const msg of messages) {
      if (detectReaction(msg.body)) continue;
      if (msg.media && msg.media.length > 0) mediaMsg = msg; // keep last (most recent)
    }
    return mediaMsg;
  }

  let best: { msg: Message; score: number } | null = null;
  // messages are oldest-first; iterate so later (more recent) entries win ties.
  for (const msg of messages) {
    if (detectReaction(msg.body)) continue; // a reaction text isn't a valid target
    const m = norm(msg.body);
    if (!m) continue;
    let score = 0;
    if (m === q) score = 100000;
    else if (m.startsWith(q) || q.startsWith(m)) score = 1000 + Math.min(m.length, q.length);
    else if (m.includes(q) || q.includes(m)) score = 100 + Math.min(m.length, q.length);
    if (score > 0 && (!best || score >= best.score)) best = { msg, score };
  }
  return best?.msg ?? null;
}
