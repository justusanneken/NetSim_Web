import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Engine, PingResult, TraceSession } from '../src';
import { chainLab, keys, routerLab, serializeLog } from './helpers';

const pings = (e: Engine, id: string): PingResult[] => {
  const c = e.getDevice(id)?.config;
  return c && 'pings' in c ? c.pings : [];
};
const traces = (e: Engine, id: string): TraceSession[] => {
  const c = e.getDevice(id)?.config;
  return c && 'traces' in c ? c.traces : [];
};

describe('Abnahme Phase 2: zwei Subnetze über einen Router', () => {
  it('Ping über den Router funktioniert (TTL 127, ARP je Segment)', () => {
    const { e, pc0 } = routerLab();
    e.ping(pc0, '10.0.2.10');
    e.runAll();
    const [p] = pings(e, pc0);
    expect(p).toMatchObject({ status: 'reply', from: '10.0.2.10', ttl: 127 });
    expect(keys(e.log).filter((k) => k === 'router.forward')).toHaveLength(2);
    expect(e.arpTable(pc0).map((a) => a.ip)).toEqual(['10.0.1.1']);
  });

  it('Router-Schnittstellen sind standardmäßig down; Connected-Routen folgen dem Link', () => {
    const { e, r1 } = routerLab();
    expect(e.routingTable(r1).filter((x) => x.type === 'C')).toHaveLength(2);
    e.setPortAdmin(r1, 'p1', false);
    expect(e.routingTable(r1).filter((x) => x.type === 'C')).toHaveLength(1);
    const fresh = chainLab().e;
    expect(fresh.getDevice(chainLab().r1)?.ports[2]?.adminUp).toBe(false);
  });

  it('Traceroute über zwei Router zeigt jeden Hop und das Ziel', () => {
    const { e, pc0 } = chainLab();
    expect(e.trace(pc0, '10.0.2.10')).toMatchObject({ ok: true });
    e.runAll();
    const [t] = traces(e, pc0);
    expect(t?.done).toBe(true);
    expect(t?.hops.map((h) => h.probes[0]?.from)).toEqual(['10.0.1.1', '10.0.12.2', '10.0.2.10']);
    expect(t?.hops.map((h) => h.probes[0]?.outcome)).toEqual(['hop', 'hop', 'reached']);
    expect(t?.hops.every((h) => h.probes.length === 3)).toBe(true);
  });

  it('TTL abgelaufen: Router verwirft und sendet Time Exceeded', () => {
    const { e, pc0 } = chainLab();
    e.trace(pc0, '10.0.2.10');
    e.runAll();
    expect(keys(e.log)).toContain('router.ttlExpired');
    expect(keys(e.log)).toContain('host.icmp.error');
  });

  it('kein Gateway → noRoute; Gateway existiert nicht → Host unreachable (lokal)', () => {
    const { e, pc0 } = routerLab();
    e.setHostIp(pc0, '10.0.1.10', '255.255.255.0');
    e.ping(pc0, '10.0.2.10');
    e.runAll();
    expect(pings(e, pc0)[0]).toMatchObject({ status: 'unreachable', note: 'ping.noRoute' });
    e.setHostIp(pc0, '10.0.1.10', '255.255.255.0', '10.0.1.99');
    e.ping(pc0, '10.0.2.10');
    e.runAll();
    expect(pings(e, pc0)[1]).toMatchObject({
      status: 'unreachable',
      note: 'ping.hostUnreachable',
      from: '10.0.1.10',
    });
  });

  it('Router ohne Route: Destination Net Unreachable vom Router', () => {
    const { e, pc0 } = routerLab();
    e.ping(pc0, '172.16.0.1');
    e.runAll();
    expect(pings(e, pc0)[0]).toMatchObject({
      status: 'unreachable',
      note: 'ping.netUnreachable',
      from: '10.0.1.1',
    });
    expect(keys(e.log)).toContain('router.noRoute');
  });

  it('Router kann Ziel im Connected-Netz nicht auflösen: Destination Host Unreachable', () => {
    const { e, pc0 } = routerLab();
    e.ping(pc0, '10.0.2.99');
    e.runAll();
    expect(pings(e, pc0)[0]).toMatchObject({
      status: 'unreachable',
      note: 'ping.hostUnreachable',
      from: '10.0.1.1',
    });
  });

  it('Router pingt selbst: eigene und fremde Adressen, Antwort auf Ping an die Schnittstelle', () => {
    const { e, pc0, r1 } = routerLab();
    e.ping(r1, '10.0.1.10');
    e.ping(pc0, '10.0.1.1');
    e.runAll();
    expect(pings(e, r1)[0]).toMatchObject({ status: 'reply', ttl: 128 });
    expect(pings(e, pc0)[0]).toMatchObject({ status: 'reply', ttl: 255 });
    expect(e.ping(r1, '10.9.9.9').ok).toBe(true);
    e.runAll();
    expect(pings(e, r1)[1]).toMatchObject({ status: 'unreachable', note: 'ping.noRoute' });
  });
});

describe('Fragmentierung, DF und PMTUD', () => {
  it('großes Paket wird fragmentiert und am Ziel reassembliert', () => {
    const { e, pc0, pc1 } = routerLab();
    e.ping(pc0, '10.0.2.10', { dataSize: 4000 });
    e.runAll();
    expect(pings(e, pc0)[0]).toMatchObject({ status: 'reply', bytes: 4000 });
    expect(keys(e.log)).toContain('ip.fragment');
    expect(keys(e.log)).toContain('ip.fragmentHeld');
    expect(keys(e.log)).toContain('ip.reassembled');
    expect(e.getDevice(pc1)).toBeDefined();
  });

  it('DF + kleinere MTU am Router: Fragmentation Needed mit Next-Hop-MTU', () => {
    const { e, pc0, r1 } = routerLab();
    expect(e.setPortMtu(r1, 'p1', 1400).ok).toBe(true);
    e.ping(pc0, '10.0.2.10', { dataSize: 1472, df: true });
    e.runAll();
    expect(pings(e, pc0)[0]).toMatchObject({
      status: 'unreachable',
      note: 'ping.fragNeeded',
      from: '10.0.1.1',
    });
    expect(keys(e.log)).toContain('router.needFrag');
    const err = e.log.find(
      (l) =>
        l.frame?.payload.kind === 'ipv4' &&
        (l.frame.payload.payload as { nextHopMtu?: number }).nextHopMtu,
    );
    expect(err).toBeDefined();
    // Ohne DF fragmentiert der Router
    e.ping(pc0, '10.0.2.10', { dataSize: 1472 });
    e.runAll();
    expect(pings(e, pc0)[1]).toMatchObject({ status: 'reply' });
  });

  it('DF am Quellgerät selbst: lokale Meldung', () => {
    const { e, pc0 } = routerLab();
    e.ping(pc0, '10.0.2.10', { dataSize: 2000, df: true });
    e.runAll();
    expect(pings(e, pc0)[0]).toMatchObject({ status: 'unreachable', note: 'ping.fragNeeded' });
  });

  it('MTU-Validierung', () => {
    const { e, r1 } = routerLab();
    expect(e.setPortMtu(r1, 'p0', 10)).toMatchObject({ ok: false });
    expect(e.setPortMtu(r1, 'zz', 1500)).toMatchObject({ ok: false });
  });
});

describe('Routing-Tabelle', () => {
  it('Longest-Prefix-Match, Default-Route, Floating Static (AD)', () => {
    const { e, pc0, pc1, r1 } = chainLab();
    // Default-Route + spezifischere /24 bleibt vorrangig
    e.addStaticRoute(r1, { prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.12.2' });
    e.addStaticRoute(r1, {
      prefix: '10.0.2.0',
      mask: '255.255.255.0',
      nextHop: '10.0.12.99',
      ad: 200,
    });
    const rib = e.routingTable(r1).filter((x) => x.type === 'S');
    // Floating Static (AD 200) steht nicht in der Routing-Tabelle, solange die bessere Route existiert
    expect(rib.map((x) => `${x.prefix}/${x.plen}`)).toEqual(['10.0.2.0/24', '0.0.0.0/0']);
    e.ping(pc0, '10.0.2.10');
    e.runAll();
    expect(pings(e, pc0)[0]?.status).toBe('reply');
    // Route mit nicht erreichbarem Next-Hop wird nicht installiert
    e.addStaticRoute(r1, { prefix: '192.168.0.0', mask: '255.255.0.0', nextHop: '172.31.0.1' });
    expect(e.routingTable(r1).some((x) => x.prefix === '192.168.0.0')).toBe(false);
    // Exit-Interface-Route
    e.addStaticRoute(r1, { prefix: '10.9.0.0', mask: '255.255.0.0', outIfaceId: 'p1' });
    expect(e.routingTable(r1).some((x) => x.prefix === '10.9.0.0' && x.ifaceId === 'p1')).toBe(
      true,
    );
    e.removeStaticRoute(r1, { prefix: '10.9.0.0', mask: '255.255.0.0', outIfaceId: 'p1' });
    expect(e.routingTable(r1).some((x) => x.prefix === '10.9.0.0')).toBe(false);
    void pc1;
  });

  it('Validierung: Überlappung, Netzadresse, Maske, Routen', () => {
    const { e, r1 } = routerLab();
    expect(e.setInterfaceIp(r1, 'p2', '10.0.1.200', '255.255.255.0')).toMatchObject({
      ok: false,
      error: 'ip.overlap',
      params: { net: '10.0.1.0', port: 'GigabitEthernet0/0' },
    });
    expect(e.setInterfaceIp(r1, 'p2', '10.0.5.0', '255.255.255.0')).toMatchObject({
      error: 'ip.networkAddress',
    });
    expect(e.setInterfaceIp(r1, 'p2', 'x', '255.255.255.0')).toMatchObject({
      error: 'ip.invalidIp',
    });
    expect(e.setInterfaceIp(r1, 'p2', '10.0.5.1', '255.0.255.0')).toMatchObject({
      error: 'ip.invalidMask',
    });
    expect(e.setInterfaceIp(r1, 'p2', '10.0.5.1', '255.255.255.0').ok).toBe(true);
    expect(e.setInterfaceIp(r1, 'p2', '', '').ok).toBe(true);
    expect(e.setInterfaceIp('nope', 'p2', '', '')).toMatchObject({ error: 'ip.notARouter' });
    expect(e.addStaticRoute(r1, { prefix: 'x', mask: '255.0.0.0', nextHop: '1.1.1.1' }).ok).toBe(
      false,
    );
    expect(
      e.addStaticRoute(r1, { prefix: '1.0.0.0', mask: '255.0.255.0', nextHop: '1.1.1.1' }).ok,
    ).toBe(false);
    expect(e.addStaticRoute(r1, { prefix: '1.0.0.0', mask: '255.0.0.0', nextHop: 'q' }).ok).toBe(
      false,
    );
    expect(e.addStaticRoute(r1, { prefix: '1.0.0.0', mask: '255.0.0.0' }).ok).toBe(false);
    expect(
      e.addStaticRoute('nope', { prefix: '1.0.0.0', mask: '255.0.0.0', nextHop: '1.1.1.1' }).ok,
    ).toBe(false);
    expect(e.removeStaticRoute('nope', { prefix: '1.0.0.0', mask: '255.0.0.0' }).ok).toBe(false);
    expect(e.removeStaticRoute(r1, { prefix: '1.0.0.0', mask: 'zz' }).ok).toBe(false);
  });

  it('Factory-Reset behält die Startup-Config und setzt Ports zurück', () => {
    const { e, r1 } = routerLab();
    const d = e.getDevice(r1);
    if (d?.config.kind !== 'router') throw new Error('router');
    d.config.sys.startupConfig = 'hostname X';
    e.factoryReset(r1);
    const after = e.getDevice(r1);
    expect(after?.config).toMatchObject({ sys: { startupConfig: 'hostname X' }, ifaces: {} });
    expect(after?.ports[0]?.adminUp).toBe(false);
    e.factoryReset('nope');
    e.factoryReset(chainLab().pc0);
  });
});

describe('Determinismus (Router-Golden-File)', () => {
  const golden = fileURLToPath(new URL('./golden/router-trace.json', import.meta.url));
  const scenario = (): string[] => {
    const { e, pc0 } = chainLab(9);
    e.log.length = 0;
    e.ping(pc0, '10.0.2.10', { dataSize: 2000 });
    e.runAll();
    e.trace(pc0, '10.0.2.10');
    e.runAll();
    return serializeLog(e.log);
  };
  it('reproduzierbar und gleich dem Golden-File', () => {
    const a = scenario();
    expect(a).toEqual(scenario());
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(a, null, 2) + '\n');
    }
    expect(a).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
  });
});
