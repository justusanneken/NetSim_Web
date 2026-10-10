import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeFrame, inetChecksum, writePcap } from '../src';
import { allFrames } from './encodeFixtures';

/** Unabhängige Prüfung von IPv4-Header- und Transportprüfsummen eines Frames. */
function verify(b: Uint8Array): string[] {
  const errs: string[] = [];
  let off = 14;
  let et = (b[12] as number) * 256 + (b[13] as number);
  if (et === 0x8100) {
    et = (b[16] as number) * 256 + (b[17] as number);
    off = 18;
  }
  const pseudoSum = (src: number[], dst: number[], proto: number, len: number): number => {
    let s = 0;
    const add = (a: number[]): void => {
      for (let i = 0; i < a.length; i += 2) s += ((a[i] as number) << 8) | (a[i + 1] as number);
    };
    add(src);
    add(dst);
    s += proto + len;
    return s;
  };
  if (et === 0x0800) {
    const ip = b.slice(off);
    if (inetChecksum(ip.slice(0, 20)) !== 0) errs.push('ip-header');
    const total = (ip[2] as number) * 256 + (ip[3] as number);
    const frag = ((ip[6] as number) & 0x3f) * 256 + (ip[7] as number);
    const proto = ip[9] as number;
    const seg = ip.slice(20, total);
    if (frag === 0) {
      if (proto === 1 && inetChecksum(seg) !== 0) errs.push('icmp');
      if (proto === 6 || proto === 17) {
        const src = [...ip.slice(12, 16)];
        const dst = [...ip.slice(16, 20)];
        if (inetChecksum(seg, pseudoSum(src, dst, proto, seg.length)) !== 0)
          errs.push('l4-' + proto);
      }
    }
  } else if (et === 0x86dd) {
    const ip = b.slice(off);
    const len = (ip[4] as number) * 256 + (ip[5] as number);
    const nh = ip[6] as number;
    const seg = ip.slice(40, 40 + len);
    if (nh === 58 || nh === 6 || nh === 17 || nh === 89) {
      if (
        inetChecksum(
          seg,
          pseudoSum([...ip.slice(8, 24)], [...ip.slice(24, 40)], nh, seg.length),
        ) !== 0
      )
        errs.push('l4v6-' + nh);
    }
  }
  return errs;
}

describe('encode: alle Protokolle', () => {
  const frames = allFrames();

  it('jeder Beispiel-Frame lässt sich kodieren, ist ≥ 60 Byte und deterministisch', () => {
    expect(frames.length).toBeGreaterThan(100);
    for (const f of frames) {
      const a = encodeFrame(f);
      const b = encodeFrame(f);
      expect(a.length).toBeGreaterThanOrEqual(60);
      expect([...a]).toEqual([...b]);
    }
  });

  it('IPv4-Header-, ICMP-, TCP-, UDP- und ICMPv6/OSPFv3-Prüfsummen sind gültig', () => {
    const bad: string[] = [];
    frames.forEach((f, i) => {
      const e = verify(encodeFrame(f));
      if (e.length) bad.push(`#${i} ${f.payload.kind}: ${e.join(',')}`);
    });
    expect(bad).toEqual([]);
  });

  it('PCAP-Datei aller Beispiele (optional: NETSIM_PCAP_OUT zur Prüfung mit Wireshark/Scapy)', () => {
    const pcap = writePcap(frames.map((frame, i) => ({ t: i * 1000, frame })));
    expect(pcap[0]).toBe(0xd4);
    const out = process.env.NETSIM_PCAP_OUT;
    if (out) writeFileSync(out, pcap);
  });
});
