import type { Ipv6Addr } from './types';
import { BROADCAST_MAC, type Ipv4Addr, type Mac } from './types';

export function parseIpv4(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return undefined;
    n = n * 256 + o;
  }
  return n;
}

export function formatIpv4(n: number): Ipv4Addr {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isValidIpv4(ip: string): boolean {
  return parseIpv4(ip) !== undefined;
}

/** Gültige Netzmaske = zusammenhängende führende Einsen. */
export function maskToPrefix(mask: string): number | undefined {
  const n = parseIpv4(mask);
  if (n === undefined) return undefined;
  let prefix = 0;
  let seenZero = false;
  for (let bit = 31; bit >= 0; bit--) {
    const one = ((n >>> bit) & 1) === 1;
    if (one && seenZero) return undefined;
    if (one) prefix++;
    else seenZero = true;
  }
  return prefix;
}

export function prefixToMask(prefix: number): Ipv4Addr {
  const n = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return formatIpv4(n);
}

export function sameSubnet(a: Ipv4Addr, b: Ipv4Addr, mask: string): boolean {
  const na = parseIpv4(a);
  const nb = parseIpv4(b);
  const nm = parseIpv4(mask);
  if (na === undefined || nb === undefined || nm === undefined) return false;
  return (na & nm) >>> 0 === (nb & nm) >>> 0;
}

export function broadcastAddress(ip: Ipv4Addr, mask: string): Ipv4Addr | undefined {
  const n = parseIpv4(ip);
  const m = parseIpv4(mask);
  if (n === undefined || m === undefined) return undefined;
  return formatIpv4(((n & m) | (~m >>> 0)) >>> 0);
}

export function isBroadcastMac(mac: Mac): boolean {
  return mac === BROADCAST_MAC;
}

/** Multicast-Bit (niederwertigstes Bit des ersten Oktetts). Broadcast zählt mit. */
export function isMulticastMac(mac: Mac): boolean {
  const first = parseInt(mac.slice(0, 2), 16);
  return (first & 1) === 1;
}

/** Deterministische, lokal administrierte MAC aus einem Zähler. */
export function macFromCounter(n: number): Mac {
  const b = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return ['02', '00', ...b.map((x) => x.toString(16).padStart(2, '0'))].join(':');
}

// ------------------------------------------------------------ Multicast (IPv4)

export const isMulticastIpv4 = (ip: Ipv4Addr): boolean => {
  const n = parseIpv4(ip);
  return n !== undefined && n >>> 28 === 0xe;
};

/** `224.0.0.5` → `01:00:5e:00:00:05` (untere 23 Bit der Gruppenadresse). */
export function multicastMacV4(ip: Ipv4Addr): Mac {
  const n = (parseIpv4(ip) ?? 0) & 0x7fffff;
  return ['01', '00', '5e', (n >>> 16) & 0x7f, (n >>> 8) & 255, n & 255]
    .map((x) => (typeof x === 'string' ? x : x.toString(16).padStart(2, '0')))
    .join(':');
}

// ------------------------------------------------------------ IPv6

/** Acht 16-Bit-Wörter; `undefined` bei ungültiger Schreibweise. */
export function parseIpv6(s: string): number[] | undefined {
  if (!/^[0-9a-fA-F:]+$/.test(s) || s.includes(':::')) return undefined;
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const groups = (h: string): string[] => (h === '' ? [] : h.split(':'));
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const all = [...head, ...tail];
  if (all.some((g) => g.length < 1 || g.length > 4)) return undefined;
  if (halves.length === 1 && head.length !== 8) return undefined;
  if (halves.length === 2 && head.length + tail.length > 7) return undefined;
  const fill =
    halves.length === 2 ? new Array<string>(8 - head.length - tail.length).fill('0') : [];
  return [...head, ...fill, ...tail].map((g) => parseInt(g, 16));
}

export function isValidIpv6(s: string): boolean {
  return parseIpv6(s) !== undefined;
}

/** Kanonische Kurzschreibweise (längste Null-Folge ab 2 Wörtern als `::`). */
export function formatIpv6(w: number[]): Ipv6Addr {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (w[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (x: number): string => x.toString(16);
  if (bestLen < 2) return w.map(hex).join(':');
  const left = w.slice(0, bestStart).map(hex).join(':');
  const right = w
    .slice(bestStart + bestLen)
    .map(hex)
    .join(':');
  return `${left}::${right}`;
}

export function normalizeIpv6(s: string): Ipv6Addr | undefined {
  const w = parseIpv6(s);
  return w ? formatIpv6(w) : undefined;
}

const maskWords = (plen: number): number[] =>
  Array.from({ length: 8 }, (_, i) => {
    const bits = Math.max(0, Math.min(16, plen - i * 16));
    return bits === 0 ? 0 : (0xffff << (16 - bits)) & 0xffff;
  });

export function ipv6Network(addr: Ipv6Addr, plen: number): Ipv6Addr {
  const w = parseIpv6(addr) ?? new Array<number>(8).fill(0);
  const m = maskWords(plen);
  return formatIpv6(w.map((x, i) => x & (m[i] as number)));
}

export function sameIpv6Prefix(a: Ipv6Addr, b: Ipv6Addr, plen: number): boolean {
  return ipv6Network(a, plen) === ipv6Network(b, plen);
}

/** EUI-64-Schnittstellenkennung aus einer MAC (7. Bit invertiert). */
export function eui64(mac: Mac): number[] {
  const b = mac.split(':').map((x) => parseInt(x, 16));
  return [
    (((b[0] ?? 0) ^ 2) << 8) | (b[1] ?? 0),
    ((b[2] ?? 0) << 8) | 0xff,
    (0xfe << 8) | (b[3] ?? 0),
    ((b[4] ?? 0) << 8) | (b[5] ?? 0),
  ];
}

export function linkLocalFromMac(mac: Mac): Ipv6Addr {
  return formatIpv6([0xfe80, 0, 0, 0, ...eui64(mac)]);
}

/** SLAAC: Präfix (/64) + EUI-64. */
export function slaacAddress(prefix: Ipv6Addr, mac: Mac): Ipv6Addr {
  const w = parseIpv6(prefix) ?? new Array<number>(8).fill(0);
  return formatIpv6([...w.slice(0, 4), ...eui64(mac)]);
}

export const isMulticastIpv6 = (a: Ipv6Addr): boolean =>
  ((parseIpv6(a)?.[0] ?? 0) & 0xff00) === 0xff00;
export const isLinkLocalIpv6 = (a: Ipv6Addr): boolean =>
  ((parseIpv6(a)?.[0] ?? 0) & 0xffc0) === 0xfe80;

/** `ff02::5` → `33:33:00:00:00:05` (letzte 32 Bit). */
export function multicastMacV6(a: Ipv6Addr): Mac {
  const w = parseIpv6(a) ?? new Array<number>(8).fill(0);
  const hx = (n: number): string => n.toString(16).padStart(2, '0');
  return `33:33:${hx((w[6] as number) >> 8)}:${hx((w[6] as number) & 255)}:${hx((w[7] as number) >> 8)}:${hx((w[7] as number) & 255)}`;
}

/** Solicited-Node-Multicast `ff02::1:ffXX:XXXX`. */
export function solicitedNode(a: Ipv6Addr): Ipv6Addr {
  const w = parseIpv6(a) ?? new Array<number>(8).fill(0);
  return formatIpv6([0xff02, 0, 0, 0, 0, 1, 0xff00 | ((w[6] as number) & 255), w[7] as number]);
}

export const ALL_NODES_V6 = 'ff02::1';
export const ALL_ROUTERS_V6 = 'ff02::2';
export const ALL_OSPF_V6 = 'ff02::5';
export const ALL_OSPF_DR_V6 = 'ff02::6';
