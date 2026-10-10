import type { EthernetPdu } from '../types';
import { encodeFrame } from './l2';

/** Referenzzeitpunkt der Aufzeichnung (2025-01-01T00:00:00Z): Simulationszeit 0 ⇒ diese Wandzeit, reproduzierbar. */
export const PCAP_EPOCH_SEC = 1735689600;
const LINKTYPE_ETHERNET = 1;
const SNAPLEN = 65535;

export interface PcapRecord {
  /** Simulationszeit in µs. */
  t: number;
  frame: EthernetPdu;
}

function le32(v: number, out: number[]): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function le16(v: number, out: number[]): void {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}

/**
 * libpcap-Datei (klassisches Format, Magic `a1b2c3d4` in Little Endian, Version 2.4, LINKTYPE_ETHERNET).
 * Die Frames werden synthetisch aus den strukturierten PDUs erzeugt (siehe `encodeFrame`).
 */
export function writePcap(records: PcapRecord[]): Uint8Array {
  const out: number[] = [];
  le32(0xa1b2c3d4, out);
  le16(2, out);
  le16(4, out);
  le32(0, out); // thiszone
  le32(0, out); // sigfigs
  le32(SNAPLEN, out);
  le32(LINKTYPE_ETHERNET, out);
  for (const r of records) {
    const bytes = encodeFrame(r.frame);
    const t = Math.max(0, Math.round(r.t));
    le32(PCAP_EPOCH_SEC + Math.floor(t / 1_000_000), out);
    le32(t % 1_000_000, out);
    le32(bytes.length, out);
    le32(bytes.length, out);
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i] as number);
  }
  return Uint8Array.from(out);
}

/** Hexdump im Stil von `hexdump -C` / Wireshark („0000  ff ff … |ASCII|“). */
export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.slice(off, off + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0'));
    const left = hex.slice(0, 8).join(' ');
    const right = hex.slice(8).join(' ');
    const ascii = [...row]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(
      `${off.toString(16).padStart(4, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  ${ascii}`,
    );
  }
  return lines.join('\n');
}
