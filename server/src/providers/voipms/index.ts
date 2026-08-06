import { config } from '../../config.js';
import type { Chat, Message } from '../../types.js';
import type { Provider, SendPayload, SendResult, InboundReaction } from '../types.js';
import { sendSMS, sendMMS, setSmsCallback, toVoipNumber, nowVoipDate } from './client.js';
import { startPoller, stopPoller, getPollerStatus } from './poller.js';
import { detectReaction, buildReactionText } from './reactions.js';
import { saveUploadedMedia } from '../../services/media.js';
import { ingest } from '../../services/ingest.js';
import { addReaction, getMessage, getReactionsForMessage } from '../../store/db.js';
import { broadcast } from '../../realtime/sse.js';

export class VoipMsProvider implements Provider {
  id = 'voipms';
  capabilities = {
    reply: false, // SMS has no quotes
    react: true, // via iMessage-style fallback text
    forward: false, // (forwarding is done as a copy by the server, per-provider support unneeded)
    edit: false,
    delete: false,
    groups: false, // group MMS arrives expanded into 1:1 legs
    attachments: true,
    crossChatQuotes: false,
  };

  private enabled = Boolean(config.voipms.username && config.voipms.password);

  async start(): Promise<void> {
    if (!this.enabled) {
      console.log('[voipms] disabled (missing VOIPMS_API_USERNAME/PASSWORD)');
      return;
    }
    await startPoller();
  }

  stop(): void {
    stopPoller();
  }

  status(): string {
    return this.enabled ? getPollerStatus() : 'disabled';
  }

  async send(chat: Chat, payload: SendPayload): Promise<SendResult> {
    const did = toVoipNumber(chat.accountId.slice('voipms:'.length));
    const dst = toVoipNumber(chat.remoteId);
    const body = payload.body;
    const media = payload.media ?? [];
    // MMS can only carry images — documents aren't supported by carriers.
    if (media.some((m) => !m.contentType.startsWith('image/'))) {
      throw new Error('SMS/MMS supports image attachments only');
    }
    const tooLong = body.length > 160;

    let id: string;
    let prebuilt;
    if (media.length > 0) {
      id = await sendMMS(did, dst, body, media);
      prebuilt = media.map((m) => saveUploadedMedia(Buffer.from(m.data, 'base64'), m.contentType));
    } else if (tooLong) {
      id = await sendMMS(did, dst, body, []);
    } else {
      id = await sendSMS(did, dst, body);
    }

    const localId = id || `local-${Date.now()}`;
    await ingest(
      {
        id: localId,
        accountId: chat.accountId,
        chatRemoteId: chat.remoteId,
        contactRaw: chat.contactRaw || chat.remoteId,
        ts: Date.now(),
        date: nowVoipDate(),
        outgoing: true,
        body,
        media: prebuilt,
        forwardedFrom: payload.forwardedFrom,
      },
      'send'
    );
    return { id: localId };
  }

  /** SMS "reaction" = send the iMessage-style fallback text, record the badge. */
  async react(chat: Chat, target: Message, emoji: string): Promise<void> {
    let targetText = (target.body || '').trim();
    if (!targetText && target.media?.length) targetText = 'an image';
    const body = buildReactionText(emoji, targetText);
    if (!body) throw new Error('unsupported emoji');

    const did = toVoipNumber(chat.accountId.slice('voipms:'.length));
    const dst = toVoipNumber(chat.remoteId);
    const id = await sendSMS(did, dst, body);

    addReaction({
      id: `${chat.accountId}:${id || `react-${Date.now()}`}`,
      messageId: target.id,
      chatId: chat.id,
      emoji,
      fromSender: 'me',
      ts: Date.now(),
    });

    const updated = getMessage(target.id);
    if (updated) {
      updated.reactions = getReactionsForMessage(target.id);
      broadcast({ type: 'message-updated', data: updated });
    }
  }

  classifyInbound(body: string): InboundReaction | null {
    const d = detectReaction(body);
    return d ? { emoji: d.emoji, quoted: d.quoted } : null;
  }

  /** Point a DID's SMS URL callback at our inbound webhook (UI helper). */
  static async applyWebhook(didE164: string, url: string): Promise<void> {
    await setSmsCallback(toVoipNumber(didE164), url, true);
  }
}
