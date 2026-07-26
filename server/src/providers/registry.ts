import type { Account, Capabilities } from '../types.js';
import type { Provider } from './types.js';
import { getAccounts } from '../store/db.js';
import { VoipMsProvider } from './voipms/index.js';
import { WhatsAppProvider } from './whatsapp/index.js';
import { TelegramProvider } from './telegram/index.js';
import { MattermostProvider } from './mattermost/index.js';
import { SignalProvider } from './signal/index.js';

const NONE: Capabilities = {
  reply: false,
  react: false,
  forward: false,
  edit: false,
  delete: false,
  groups: false,
  attachments: false,
  crossChatQuotes: false,
};

const providers = new Map<string, Provider>();

export function registerProvider(p: Provider): void {
  providers.set(p.id, p);
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

/** Provider that owns a given account id ('<provider>:<remote>'). */
export function providerForAccount(accountId: string): Provider | undefined {
  return providers.get(accountId.split(':')[0]);
}

export function capabilitiesForAccount(accountId: string): Capabilities {
  return providerForAccount(accountId)?.capabilities ?? NONE;
}

/** Accounts from the DB joined with live provider capabilities. */
export function listAccounts(): Account[] {
  return getAccounts().map((a) => ({
    ...a,
    capabilities: providers.get(a.provider)?.capabilities ?? NONE,
  }));
}

export function providerStatuses(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, p] of providers) out[id] = p.status();
  return out;
}

/** Instantiate and start all providers. Credentials-gated providers self-disable. */
export async function startProviders(): Promise<void> {
  registerProvider(new VoipMsProvider());
  registerProvider(new WhatsAppProvider());
  registerProvider(new TelegramProvider());
  registerProvider(new MattermostProvider());
  registerProvider(new SignalProvider());
  for (const p of providers.values()) {
    try {
      await p.start();
    } catch (err) {
      console.error(`[providers] ${p.id} failed to start:`, (err as Error).message);
    }
  }
}
