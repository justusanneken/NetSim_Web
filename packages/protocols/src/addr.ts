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
