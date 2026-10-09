import { describe, expect, it } from 'vitest';
import { encodeFrame, inetChecksum } from '@netsim/protocols';
import { Engine, logToPcap, newOspf, pcapRecords } from '../src';
import { pcOn, rip4, rlink, sec } from './labs4';

/** Zwei Router (OSPF) mit je einem PC; PC1 pingt PC2. */
function lab() {
  const e = new Engine({ seed: 1 });
  const r = ['R1', 'R2'].map((n) => e.addDevice('router', { name: n })) as [string, string];
  rlink(e, r[0], 'p0', r[1], 'p0');
  rip4(e, r[0], 'p0', '10.0.12.1');
  rip4(e, r[1], 'p0', '10.0.12.2');
  rip4(e, r[0], 'p2', '10.1.0.1');
  rip4(e, r[1], 'p2', '10.2.0.1');
  const pc1 = pcOn(e, r[0], 'p2', '10.1.0.10', '10.1.0.1', 'PC1');
  pcOn(e, r[1], 'p2', '10.2.0.10', '10.2.0.1', 'PC2');
  for (const id of r) {
    const d = e.getDevice(id);
    if (d?.config.kind !== 'router') throw new Error('router');
    const c = newOspf(1);
    c.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255', area: '0' }];
    d.config.routing.ospf[1] = c;
    e.routingChanged(id);
  }
  sec(e, 60);
  e.ping(pc1, '10.2.0.10', { count: 2 });
  e.runAll();
  return e;
}

describe('PCAP-Export aus dem Event-Log', () => {
  it('Routing-Protokoll-Frames (OSPF) tragen ihren Frame im Log', () => {
    const e = lab();
    const ospf = e.logSlice(0, 100000).filter((l) => l.proto === 'OSPF' && l.kind === 'rx');
    expect(ospf.length).toBeGreaterThan(10);
    expect(ospf.every((l) => l.frame?.payload.kind === 'ipv4')).toBe(true);
  });

  it('pcapRecords: ein Datensatz je Ankunft, aufsteigende Zeit, nur Frames', () => {
    const e = lab();
    const recs = pcapRecords(e.logSlice(0, 100000));
    expect(recs.length).toBeGreaterThan(30);
    for (let i = 1; i < recs.length; i++)
      expect((recs[i] as { t: number }).t).toBeGreaterThanOrEqual((recs[i - 1] as { t: number }).t);
    const protos = new Set(recs.map((r) => r.frame.payload.kind));
    expect(protos.has('arp')).toBe(true);
    expect(protos.has('ipv4')).toBe(true);
  });

  it('Capture je Gerät filtert auf die Ankunftsgeräte', () => {
    const e = lab();
    const log = e.logSlice(0, 100000);
    const r1 = Object.values(e.state.devices).find((d) => d.name === 'R1')?.id;
    const some = pcapRecords(log, r1);
    const all = pcapRecords(log);
    expect(some.length).toBeGreaterThan(0);
    expect(some.length).toBeLessThan(all.length);
  });

  it('jeder Frame ergibt gültige Bytes: IPv4-Header-Prüfsummen stimmen', () => {
    const e = lab();
    for (const r of pcapRecords(e.logSlice(0, 100000))) {
      const b = encodeFrame(r.frame);
      if (r.frame.payload.kind === 'ipv4') expect(inetChecksum(b.slice(14, 34))).toBe(0);
    }
  });

  it('logToPcap liefert eine libpcap-Datei (Magic, LINKTYPE_ETHERNET)', () => {
    const e = lab();
    const b = logToPcap(e.logSlice(0, 100000));
    expect([...b.slice(0, 4)]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
    expect(b[20]).toBe(1);
    expect(b.length).toBeGreaterThan(24 + 16 + 60);
  });

  it('das Nachtragen des Frames verändert die Log-Reihenfolge und -Texte nicht (deterministisch)', () => {
    const a = lab()
      .logSlice(0, 100000)
      .map((l) => `${l.t} ${l.atDeviceName} ${l.msg.key}`);
    const b = lab()
      .logSlice(0, 100000)
      .map((l) => `${l.t} ${l.atDeviceName} ${l.msg.key}`);
    expect(a).toEqual(b);
  });
});
