import { chat as aiChat, aiEnabled } from './client.js';
import { classifyPrompt, toHistoryLines, formatHistory, historyWithinBudget } from './prompts.js';
import {
  getChats,
  getMessages,
  getTags,
  setChatTags,
  getChatTags,
  getDb,
  createTag,
} from '../store/db.js';
import type { Chat, Tag } from '../types.js';

const CLASSIFY_BUDGET = 12_000; // chars of history per chat

/** Classify one chat into taxonomy tags. Returns assigned tag names + confidence. */
export async function classifyChat(
  chat: Chat,
  taxonomy: Tag[],
  fewShot: { sample: string; tags: string[] }[]
): Promise<{ tags: string[]; confidence: string } | null> {
  const messages = getMessages(chat.id, 30);
  const lines = historyWithinBudget(toHistoryLines(messages), CLASSIFY_BUDGET);
  if (lines.length < 2) return null;
  const raw = await aiChat(
    classifyPrompt(
      taxonomy.map((t) => ({ name: t.name, description: t.description })),
      formatHistory(lines),
      fewShot
    ),
    { maxTokens: 120, temperature: 0.1, noThinking: true }
  );
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw) as { tags?: string[]; confidence?: string };
    const valid = new Set(taxonomy.map((t) => t.name));
    return {
      tags: (parsed.tags ?? []).filter((t) => valid.has(t)),
      confidence: parsed.confidence ?? 'low',
    };
  } catch {
    return null;
  }
}

/** Few-shot examples from the owner's manual tag assignments. */
function fewShotExamples(limit = 4): { sample: string; tags: string[] }[] {
  const manual = getChatTags().filter((t) => t.source === 'manual');
  const byChat = new Map<string, string[]>();
  for (const t of manual) {
    const arr = byChat.get(t.chatId) ?? [];
    arr.push(t.name);
    byChat.set(t.chatId, arr);
  }
  const out: { sample: string; tags: string[] }[] = [];
  for (const [chatId, tags] of byChat) {
    if (out.length >= limit) break;
    const msgs = getMessages(chatId, 8);
    const lines = toHistoryLines(msgs);
    if (lines.length < 2) continue;
    out.push({ sample: formatHistory(lines).slice(0, 1500), tags });
  }
  return out;
}

export interface ClassifyProgress {
  running: boolean;
  total: number;
  done: number;
  tagged: number;
  lastError?: string;
}

const progress: ClassifyProgress = { running: false, total: 0, done: 0, tagged: 0 };

export function getClassifyProgress(): ClassifyProgress {
  return { ...progress };
}

/** Bulk-classify chats in the background (untagged + low-confidence re-tag). */
export function startBulkClassify(force = false): void {
  if (progress.running || !aiEnabled()) return;
  const taxonomy = getTags();
  if (!taxonomy.length) return;

  const all = getChats();
  const tagged = new Set(getChatTags().filter((t) => t.locked).map((t) => t.chatId));
  const targets = force
    ? all.filter((c) => !tagged.has(c.id))
    : all.filter((c) => !tagged.has(c.id) && !getChatTags(c.id).some((t) => t.source === 'ai'));

  Object.assign(progress, {
    running: true,
    total: targets.length,
    done: 0,
    tagged: 0,
    lastError: undefined,
  });

  void (async () => {
    const shots = fewShotExamples();
    for (const chat of targets) {
      try {
        const result = await classifyChat(chat, taxonomy, shots);
        if (result && result.tags.length) {
          setChatTags(
            chat.id,
            result.tags.map((name) => ({
              tagId: taxonomy.find((t) => t.name === name)!.id,
              source: 'ai' as const,
            }))
          );
          progress.tagged++;
        }
      } catch (e) {
        progress.lastError = (e as Error).message;
      }
      progress.done++;
      // Gentle pacing: ~2 chats/sec max.
      await new Promise((r) => setTimeout(r, 400));
    }
    progress.running = false;
  })();
}

/** Auto-classify one chat (fire-and-forget, e.g. for newly active chats). */
export function classifyOneAsync(chatId: string): void {
  if (!aiEnabled() || !getTags().length) return;
  const chat = getChats().find((c) => c.id === chatId);
  if (!chat) return;
  const taxonomy = getTags();
  void classifyChat(chat, taxonomy, fewShotExamples(2))
    .then((result) => {
      if (result && result.tags.length) {
        setChatTags(
          chat.id,
          result.tags.map((name) => ({
            tagId: taxonomy.find((t) => t.name === name)!.id,
            source: 'ai' as const,
          }))
        );
      }
    })
    .catch(() => {});
}

// ---------- stats-driven tags ("frequent contact") ----------

export interface FrequentContactCriteria {
  minMessages: number; // in the window
  windowDays: number;
  minOutgoingRatio: number; // two-way engagement
  activeWithinDays: number;
}

const DEFAULT_CRITERIA: FrequentContactCriteria = {
  minMessages: 50,
  windowDays: 90,
  minOutgoingRatio: 0.2,
  activeWithinDays: 14,
};

/**
 * Compute "frequent contact" from message statistics — volume, reciprocity,
 * recency. Deterministic, no model calls. Replaces the stats-source tags
 * wholesale on each run.
 */
export function computeFrequentContacts(criteria: FrequentContactCriteria = DEFAULT_CRITERIA): number {
  createTag('frequent contact', 'People you actively converse with (auto-computed)', '#7c4dff');
  const tagId = (
    getDb().prepare('SELECT id FROM tags WHERE name = ?').get('frequent contact') as { id: number }
  ).id;
  const cutoff = Date.now() - criteria.windowDays * 86400000;
  const activeCutoff = Date.now() - criteria.activeWithinDays * 86400000;

  const rows = getDb()
    .prepare(
      `SELECT m.chat_id AS chatId, COUNT(*) AS n, SUM(m.outgoing) AS outN, MAX(m.ts) AS latest
       FROM messages m
       JOIN chats c ON c.id = m.chat_id AND c.type = 'dm'
       WHERE m.ts > ?
       GROUP BY m.chat_id`
    )
    .all(cutoff) as { chatId: string; n: number; outN: number; latest: number }[];

  const qualified = new Set(
    rows
      .filter(
        (r) =>
          r.n >= criteria.minMessages &&
          r.outN / r.n >= criteria.minOutgoingRatio &&
          r.latest >= activeCutoff
      )
      .map((r) => r.chatId)
  );

  // Re-tag stats-source rows wholesale: keep only qualified chats.
  const db = getDb();
  db.prepare("DELETE FROM chat_tags WHERE source = 'stats' AND tag_id = ?").run(tagId);
  const stmt = db.prepare(
    "INSERT INTO chat_tags(chat_id, tag_id, source, locked) VALUES(?, ?, 'stats', 0) ON CONFLICT(chat_id, tag_id) DO NOTHING"
  );
  for (const chatId of qualified) stmt.run(chatId, tagId);
  return qualified.size;
}

