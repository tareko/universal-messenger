import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { config } from '../config.js';

/** Normalize a phone number to E.164 (e.g. +12125551234). Returns null if unparseable. */
export function normalizeTel(raw: string, country = config.voipms.defaultCountry): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  // Strip anything that's not a digit or leading +.
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  const input = cleaned.startsWith('+')
    ? cleaned
    : cleaned.length === 10
      ? `+1${cleaned}`
      : cleaned.length === 11 && cleaned.startsWith('1')
        ? `+${cleaned}`
        : trimmed;
  const parsed = parsePhoneNumberFromString(input, country as CountryCode);
  if (!parsed || !parsed.isValid()) {
    // Fall back to digits-only if libphonenumber refuses (still useful for exact matching).
    const digits = cleaned.replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  }
  return parsed.format('E.164');
}

/** Loose significant-number comparison for tolerant matching. */
export function significantDigits(tel: string): string {
  const digits = tel.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function telMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return significantDigits(a) === significantDigits(b);
}
