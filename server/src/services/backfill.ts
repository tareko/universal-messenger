import { getMessages, getReactionEvent, addReaction, deleteMessage, getChats } from '../store/db.js';
import { detectReaction, matchTarget } from '../providers/voipms/reactions.js';

export interface BackfillResult {
  chats: number;
  scanned: number;
  reactions: number;
  matched: number;
  removed: number;
}

/**
 * Scan all stored voip.ms messages for iMessage-style reaction texts, convert
 * them into reaction rows attached to their matched target, and delete the
 * now-redundant "Liked …" text bubbles. Self-healing and idempotent.
 * (Only applies to the SMS tapback convention; native-reaction providers
 * never store reaction texts as messages in the first place.)
 */
export function backfillReactions(): BackfillResult {
  const chats = getChats().filter((c) => c.provider === 'voipms');
  const result: BackfillResult = { chats: chats.length, scanned: 0, reactions: 0, matched: 0, removed: 0 };

  for (const chat of chats) {
    const msgs = getMessages(chat.id, 10000);
    const candidates = msgs.filter((m) => !detectReaction(m.body));
    for (const m of msgs) {
      result.scanned++;
      const d = detectReaction(m.body);
      if (!d) continue;
      const existing = getReactionEvent(m.id);
      const target = matchTarget(candidates, d.quoted);
      if (target) {
        if (!existing) result.reactions++;
        if (!existing || existing.message_id !== target.id) {
          addReaction({
            id: m.id,
            messageId: target.id,
            chatId: chat.id,
            emoji: d.emoji,
            fromSender: m.outgoing ? 'me' : chat.remoteId,
            ts: m.ts,
          });
        }
        deleteMessage(m.id);
        result.removed++;
        result.matched++;
      } else if (!existing) {
        addReaction({
          id: m.id,
          messageId: null,
          chatId: chat.id,
          emoji: d.emoji,
          fromSender: m.outgoing ? 'me' : chat.remoteId,
          ts: m.ts,
        });
        result.reactions++;
      }
    }
  }
  console.log(
    `[backfill] chats=${result.chats} scanned=${result.scanned} reactions=${result.reactions} matched=${result.matched} removed=${result.removed}`
  );
  return result;
}
