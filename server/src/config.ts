import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Project root (server/src -> server -> <root>), so paths are cwd-independent. */
export const projectRoot = resolve(__dirname, '..', '..');

// Load .env from the project root (where .env.example lives). Falls back to cwd.
const rootEnv = resolve(projectRoot, '.env');
dotenv.config({ path: existsSync(rootEnv) ? rootEnv : resolve(process.cwd(), '.env') });

function warn(name: string) {
  console.warn(`[config] ${name} is not set — that feature will be disabled until it is.`);
}

export const config = {
  port: Number(process.env.PORT || 8317),
  host: process.env.HOST || '0.0.0.0',
  webDir: resolve(projectRoot, process.env.WEB_DIR || 'web/dist'),
  dbPath: resolve(projectRoot, process.env.DB_PATH || 'data/app.db'),
  voipms: {
    username: process.env.VOIPMS_API_USERNAME || '',
    password: process.env.VOIPMS_API_PASSWORD || '',
    defaultCountry: (process.env.VOIPMS_DEFAULT_COUNTRY || 'US').toUpperCase(),
    timezone: process.env.VOIPMS_TIMEZONE || 'America/Toronto',
    dids: (process.env.VOIPMS_DIDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    pollIntervalMs: Number(process.env.VOIPMS_POLL_INTERVAL_MS || 20000),
  },
  nextcloud: {
    url: (process.env.NEXTCLOUD_URL || '').replace(/\/+$/, ''),
    username: process.env.NEXTCLOUD_USERNAME || '',
    password: process.env.NEXTCLOUD_PASSWORD || '',
    addressbook: process.env.NEXTCLOUD_ADDRESSBOOK || '',
    syncIntervalMs: Number(process.env.CONTACTS_SYNC_INTERVAL_MS || 1800000),
  },
  webhook: {
    key: process.env.WEBHOOK_KEY || '',
    publicUrl: process.env.PUBLIC_WEBHOOK_URL || '',
  },
  ntfy: {
    url: (process.env.NTFY_URL || '').replace(/\/+$/, ''),
    topic: process.env.NTFY_TOPIC || '',
    token: process.env.NTFY_TOKEN || '',
  },
  auth: {
    token: process.env.APP_API_TOKEN || '', // optional bearer token; if unset, open (rely on VPN)
  },
};

export function checkConfig() {
  if (!config.voipms.username || !config.voipms.password) {
    warn('VOIPMS_API_USERNAME / VOIPMS_API_PASSWORD (voip.ms provider will be disabled)');
  }
  if (config.nextcloud.url && (!config.nextcloud.username || !config.nextcloud.password)) {
    warn('NEXTCLOUD_USERNAME / NEXTCLOUD_PASSWORD');
  }
}
