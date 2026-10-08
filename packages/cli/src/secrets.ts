/** Vereinfachte Passwort-Behandlung (siehe docs/simplifications.md). */

const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
const SEED = 8;

/** Cisco-Typ-7 (umkehrbar, nur Verschleierung). Fester Seed ⇒ deterministisch. */
export function type7Encrypt(plain: string): string {
  let out = SEED.toString().padStart(2, '0');
  for (let i = 0; i < plain.length; i++) {
    const k = XLAT.charCodeAt((SEED + i) % XLAT.length);
    out += (plain.charCodeAt(i) ^ k).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function type7Decrypt(enc: string): string | undefined {
  if (!/^\d{2}([0-9A-Fa-f]{2})+$/.test(enc)) return undefined;
  const seed = Number(enc.slice(0, 2));
  let out = '';
  for (let i = 2, n = 0; i < enc.length; i += 2, n++) {
    const k = XLAT.charCodeAt((seed + n) % XLAT.length);
    out += String.fromCharCode(parseInt(enc.slice(i, i + 2), 16) ^ k);
  }
  return out;
}

const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Deterministischer Pseudo-Hash im Aussehen von `enable secret 5` (kein echtes MD5-crypt). */
export function secretHash(plain: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < plain.length; i++) {
    h1 = Math.imul(h1 ^ plain.charCodeAt(i), 16777619) >>> 0;
    h2 = (Math.imul(h2, 31) + plain.charCodeAt(i)) >>> 0;
  }
  let body = '';
  let a = h1;
  let b = h2;
  for (let i = 0; i < 22; i++) {
    a = (Math.imul(a, 1103515245) + 12345) >>> 0;
    b = (b ^ (a >>> 7)) >>> 0;
    body += B64[(a ^ b) & 63];
  }
  return `$1$mERr$${body}`;
}
