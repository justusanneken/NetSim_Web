import { parseIpv4, parseIpv6 } from '../addr';

/** Kleiner Byte-Schreiber (Big Endian / Netzwerk-Byteorder). */
export class W {
  readonly b: number[] = [];
  get length(): number {
    return this.b.length;
  }
  u8(v: number): this {
    this.b.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.b.push((v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u24(v: number): this {
    this.b.push((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u32(v: number): this {
    this.b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  bytes(v: ArrayLike<number>): this {
    for (let i = 0; i < v.length; i++) this.b.push((v[i] as number) & 0xff);
    return this;
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.b.push(0);
    return this;
  }
  /** ASCII/Latin-1 (nicht darstellbare Zeichen werden zu `?`). */
  str(s: string): this {
    return this.bytes(ascii(s));
  }
  /** Zeichenkette, mit Nullen auf feste Länge aufgefüllt bzw. gekürzt. */
  fixed(s: string, n: number): this {
    const a = ascii(s).slice(0, n);
    return this.bytes(a).zeros(n - a.length);
  }
  mac(m: string): this {
    return this.bytes(macBytes(m));
  }
  ip4(a: string): this {
    return this.bytes(ip4Bytes(a));
  }
  ip6(a: string): this {
    return this.bytes(ip6Bytes(a));
  }
  /** Position `at` (u16) nachträglich überschreiben. */
  set16(at: number, v: number): this {
    this.b[at] = (v >>> 8) & 0xff;
    this.b[at + 1] = v & 0xff;
    return this;
  }
  out(): Uint8Array {
    return Uint8Array.from(this.b);
  }
}

export function ascii(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c < 256 ? c : 0x3f);
  }
  return out;
}

export function macBytes(m: string): number[] {
  const parts = m.split(':');
  if (parts.length !== 6) return [0, 0, 0, 0, 0, 0];
  return parts.map((p) => parseInt(p, 16) & 0xff);
}

export function ip4Bytes(a: string): number[] {
  const n = parseIpv4(a);
  if (n === undefined) return [0, 0, 0, 0];
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

export function ip6Bytes(a: string): number[] {
  const w = parseIpv6(a);
  if (!w) return new Array<number>(16).fill(0);
  return w.flatMap((x) => [(x >>> 8) & 0xff, x & 0xff]);
}

/** Internet-Prüfsumme (RFC 1071) über `data`, optional mit Startsumme (Pseudo-Header). */
export function inetChecksum(data: ArrayLike<number>, init = 0): number {
  let sum = init;
  const n = data.length;
  for (let i = 0; i + 1 < n; i += 2) sum += ((data[i] as number) << 8) | (data[i + 1] as number);
  if (n % 2 === 1) sum += (data[n - 1] as number) << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

/** Summe (ungefaltet) einer Bytefolge für Pseudo-Header. */
export function sum16(data: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i + 1 < data.length; i += 2)
    sum += ((data[i] as number) << 8) | (data[i + 1] as number);
  return sum;
}

/** Adressen für Pseudo-Header der Transportprüfsummen. */
export interface IpCtx {
  v6: boolean;
  src: number[];
  dst: number[];
}

/** Prüfsumme mit Pseudo-Header (IPv4: RFC 793/768, IPv6: RFC 8200 §8.1). */
export function transportChecksum(ctx: IpCtx, proto: number, segment: ArrayLike<number>): number {
  const ph = new W();
  ph.bytes(ctx.src).bytes(ctx.dst);
  if (ctx.v6) ph.u32(segment.length).u24(0).u8(proto);
  else ph.u8(0).u8(proto).u16(segment.length);
  return inetChecksum(segment, sum16(ph.b));
}

/** Deterministisches Füllmuster für Nutzdaten (ICMP-Echo wie bei Windows: a–w). */
export function pattern(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(0x61 + (i % 23));
  return out;
}

/** Deterministischer Pseudozufall (LCG, mit Text-Hash initialisiert) für „verschlüsselte“ Nutzdaten. */
export function scramble(seed: string, n: number): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out.push(h >>> 24);
  }
  return out;
}

/** Hex-Zeichenkette als n Bytes; sonst deterministisch aus dem Text abgeleitet. */
export function digestBytes(s: string, n: number): number[] {
  if (/^[0-9a-f]+$/i.test(s) && s.length >= n * 2) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(parseInt(s.slice(i * 2, i * 2 + 2), 16));
    return out;
  }
  return scramble(s, n);
}
