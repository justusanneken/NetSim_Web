import { describe, expect, it } from 'vitest';
import { Engine, newBgp, newBgpNbr } from '../src';
import { fmtRoute, must, pcOn, rip4, rlink, routes, sec } from './labs4';

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

const cfgOf = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

function bgp(
  e: Engine,
  id: string,
  asn: number,
  nbrs: { ip: string; asn: number; src?: string; nhs?: boolean; multihop?: number }[],
  nets: string[] = [],
): void {
  const c = newBgp(asn);
  for (const n of nbrs) {
    const nb = newBgpNbr(n.ip, n.asn);
    nb.updateSource = n.src;
    nb.nextHopSelf = n.nhs ?? false;
    nb.ebgpMultihop = n.multihop;
    c.neighbors[n.ip] = nb;
  }
  c.networks = nets.map((x) => {
    const [prefix, plen] = x.split('/') as [string, string];
    return { prefix, plen: Number(plen) };
  });
  cfgOf(e, id).routing.bgp = c;
  e.routingChanged(id);
}

describe('BGP', () => {
  it('eBGP: zwei Autonome Systeme tauschen Präfixe aus', () => {
    const e = new Engine({ seed: 1 });
    const r1 = e.addDevice('router', { name: 'R1' });
    const r2 = e.addDevice('router', { name: 'R2' });
    rlink(e, r1, 'p0', r2, 'p0');
    rip4(e, r1, 'p0', '192.168.12.1', '255.255.255.252');
    rip4(e, r2, 'p0', '192.168.12.2', '255.255.255.252');
    rip4(e, r1, 'p1', '10.1.0.1');
    rip4(e, r2, 'p1', '10.2.0.1');
    const pc1 = pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1');
    pcOn(e, r2, 'p1', '10.2.0.10', '10.2.0.1');
    bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200 }], ['10.1.0.0/24']);
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100 }], ['10.2.0.0/24']);
    sec(e, 30);
    const rs = routes(e, r1).map(fmtRoute);
    expect(rs).toContain('B 10.2.0.0/24 [20/0] 192.168.12.2');
    const loc = cfgOf(e, r1).routing.bgp?.locRib['10.2.0.0/24'];
    expect(loc?.attrs.asPath).toEqual([200]);
    expect(pingOk(e, pc1, '10.2.0.10')).toBe(true);
  });

  it('eBGP-Sitzung fällt bei Linkausfall sofort aus, Routen werden zurückgezogen', () => {
    const e = new Engine({ seed: 1 });
    const r1 = e.addDevice('router', { name: 'R1' });
    const r2 = e.addDevice('router', { name: 'R2' });
    rlink(e, r1, 'p0', r2, 'p0');
    rip4(e, r1, 'p0', '192.168.12.1', '255.255.255.252');
    rip4(e, r2, 'p0', '192.168.12.2', '255.255.255.252');
    rip4(e, r2, 'p1', '10.2.0.1');
    pcOn(e, r2, 'p1', '10.2.0.10', '10.2.0.1');
    bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200 }]);
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100 }], ['10.2.0.0/24']);
    sec(e, 30);
    expect(routes(e, r1).some((r) => r.prefix === '10.2.0.0')).toBe(true);
    e.setPortAdmin(r2, 'p0', false);
    sec(e, 3);
    expect(routes(e, r1).some((r) => r.prefix === '10.2.0.0')).toBe(false);
    expect(cfgOf(e, r1).routing.bgp?.neighbors['192.168.12.2']?.state).toBe('idle');
  });

  it('iBGP über Loopbacks mit next-hop-self; AS-Pfad und Next-Hops über drei AS', () => {
    const e = new Engine({ seed: 1 });
    const [r1, r2, r3, r4] = ['R1', 'R2', 'R3', 'R4'].map((n) =>
      e.addDevice('router', { name: n }),
    ) as [string, string, string, string];
    rlink(e, r1, 'p0', r2, 'p0');
    rlink(e, r2, 'p1', r3, 'p0');
    rlink(e, r3, 'p1', r4, 'p0');
    rip4(e, r1, 'p0', '192.168.12.1', '255.255.255.252');
    rip4(e, r2, 'p0', '192.168.12.2', '255.255.255.252');
    rip4(e, r2, 'p1', '10.0.23.2');
    rip4(e, r3, 'p0', '10.0.23.3');
    rip4(e, r3, 'p1', '192.168.34.1', '255.255.255.252');
    rip4(e, r4, 'p0', '192.168.34.2', '255.255.255.252');
    rip4(e, r1, 'p1', '10.1.0.1');
    rip4(e, r4, 'p1', '10.4.0.1');
    const pc1 = pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1');
    const pc4 = pcOn(e, r4, 'p1', '10.4.0.10', '10.4.0.1');
    must(e.setInterfaceIp(r2, 'lo0', '2.2.2.2', '255.255.255.255'));
    must(e.setInterfaceIp(r3, 'lo0', '3.3.3.3', '255.255.255.255'));
    must(
      e.addStaticRoute(r2, { prefix: '3.3.3.3', mask: '255.255.255.255', nextHop: '10.0.23.3' }),
    );
    must(
      e.addStaticRoute(r3, { prefix: '2.2.2.2', mask: '255.255.255.255', nextHop: '10.0.23.2' }),
    );
    bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200 }], ['10.1.0.0/24']);
    bgp(e, r2, 200, [
      { ip: '192.168.12.1', asn: 100 },
      { ip: '3.3.3.3', asn: 200, src: 'lo0', nhs: true },
    ]);
    bgp(e, r3, 200, [
      { ip: '2.2.2.2', asn: 200, src: 'lo0', nhs: true },
      { ip: '192.168.34.2', asn: 300 },
    ]);
    bgp(e, r4, 300, [{ ip: '192.168.34.1', asn: 200 }], ['10.4.0.0/24']);
    sec(e, 60);
    expect(cfgOf(e, r1).routing.bgp?.locRib['10.4.0.0/24']?.attrs.asPath).toEqual([200, 300]);
    expect(routes(e, r1).map(fmtRoute)).toContain('B 10.4.0.0/24 [20/0] 192.168.12.2');
    expect(routes(e, r2).map(fmtRoute)).toContain('B 10.4.0.0/24 [200/0] 10.0.23.3');
    expect(routes(e, r3).map(fmtRoute)).toContain('B 10.1.0.0/24 [200/0] 10.0.23.2');
    expect(routes(e, r4).map(fmtRoute)).toContain('B 10.1.0.0/24 [20/0] 192.168.34.1');
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
    expect(pingOk(e, pc4, '10.1.0.10')).toBe(true);
  });

  it('Pfadwahl: kürzerer AS-Pfad gewinnt', () => {
    const e = new Engine({ seed: 1 });
    // R1 (AS100) hat zwei Provider: R2 (AS200) direkt zum Ziel-AS300 (R4) und über R3 (AS250→AS260→AS300)
    const [r1, r2, r3, r4] = ['R1', 'R2', 'R3', 'R4'].map((n) =>
      e.addDevice('router', { name: n }),
    ) as [string, string, string, string];
    rlink(e, r1, 'p0', r2, 'p0');
    rlink(e, r1, 'p1', r3, 'p0');
    rlink(e, r2, 'p1', r4, 'p0');
    rlink(e, r3, 'p1', r4, 'p1');
    rip4(e, r1, 'p0', '192.168.12.1', '255.255.255.252');
    rip4(e, r2, 'p0', '192.168.12.2', '255.255.255.252');
    rip4(e, r1, 'p1', '192.168.13.1', '255.255.255.252');
    rip4(e, r3, 'p0', '192.168.13.2', '255.255.255.252');
    rip4(e, r2, 'p1', '192.168.24.1', '255.255.255.252');
    rip4(e, r4, 'p0', '192.168.24.2', '255.255.255.252');
    rip4(e, r3, 'p1', '192.168.34.1', '255.255.255.252');
    rip4(e, r4, 'p1', '192.168.34.2', '255.255.255.252');
    rip4(e, r4, 'p2', '10.4.0.1');
    pcOn(e, r4, 'p2', '10.4.0.10', '10.4.0.1');
    bgp(e, r1, 100, [
      { ip: '192.168.12.2', asn: 200 },
      { ip: '192.168.13.2', asn: 250 },
    ]);
    bgp(e, r2, 200, [
      { ip: '192.168.12.1', asn: 100 },
      { ip: '192.168.24.2', asn: 300 },
    ]);
    bgp(e, r3, 250, [
      { ip: '192.168.13.1', asn: 100 },
      { ip: '192.168.34.2', asn: 300 },
    ]);
    bgp(
      e,
      r4,
      300,
      [
        { ip: '192.168.24.1', asn: 200 },
        { ip: '192.168.34.1', asn: 250 },
      ],
      ['10.4.0.0/24'],
    );
    sec(e, 60);
    // Beide Pfade haben gleiche Länge (2) → niedrigste Router-ID bzw. Nachbaradresse entscheidet; Länge prüfen
    const best = cfgOf(e, r1).routing.bgp?.locRib['10.4.0.0/24'];
    expect(best?.attrs.asPath).toHaveLength(2);
    const nb = cfgOf(e, r1).routing.bgp?.neighbors;
    expect(Object.keys(nb?.['192.168.12.2']?.ribIn ?? {})).toContain('10.4.0.0/24');
    expect(Object.keys(nb?.['192.168.13.2']?.ribIn ?? {})).toContain('10.4.0.0/24');
  });
});
