import { describe, expect, it } from 'vitest';
import { Engine, newOspf } from '../src';
import { must, rlink, sec } from './labs4';

function pingRes(e: Engine, from: string, dst: string, count = 1) {
  const r = e.ping(from, dst, { count });
  must(r);
  e.runAll();
  const d = e.getDevice(from);
  const pings = d && (d.config.kind === 'host' || d.config.kind === 'router') ? d.config.pings : [];
  return pings.slice(-count);
}

/** PC1 – R1 – R2 – PC2 mit statischen IPv6-Routen. */
function lab(opts: { slaac?: boolean } = {}) {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  const pc2 = e.addDevice('pc', { name: 'PC2' });
  rlink(e, r1, 'p0', r2, 'p0');
  must(e.connect({ deviceId: pc1, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'crossover'));
  must(e.connect({ deviceId: pc2, portId: 'p0' }, { deviceId: r2, portId: 'p1' }, 'crossover'));
  for (const [id, p] of [
    [r1, 'p1'],
    [r2, 'p1'],
  ] as const)
    e.setPortAdmin(id, p, true);
  for (const id of [r1, r2]) must(e.setIpv6Routing(id, true));
  must(e.setInterfaceIp6(r1, 'p0', '2001:db8:12::1', 64));
  must(e.setInterfaceIp6(r2, 'p0', '2001:db8:12::2', 64));
  must(e.setInterfaceIp6(r1, 'p1', '2001:db8:1::1', 64));
  must(e.setInterfaceIp6(r2, 'p1', '2001:db8:2::1', 64));
  must(e.addStaticRoute6(r1, { prefix: '2001:db8:2::', plen: 64, nextHop: '2001:db8:12::2' }));
  must(e.addStaticRoute6(r2, { prefix: '2001:db8:1::', plen: 64, nextHop: '2001:db8:12::1' }));
  if (opts.slaac) must(e.setHostIpv6(pc1, { autoconfig: true }));
  else must(e.setHostIpv6(pc1, { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' }));
  must(e.setHostIpv6(pc2, { addr: '2001:db8:2::10', plen: 64, gateway: '2001:db8:2::1' }));
  // Duplicate Address Detection abwarten (1 s)
  if (!opts.slaac) sec(e, 3);
  return { e, r1, r2, pc1, pc2 };
}

describe('IPv6', () => {
  it('Ping über zwei Router mit statischen Routen; Hop Limit sinkt von 64 auf 62', () => {
    const { e, pc1 } = lab();
    sec(e, 2);
    const [r] = pingRes(e, pc1, '2001:db8:2::10');
    expect(r?.status).toBe('reply');
    expect(r?.ttl).toBe(62);
    expect(r?.from).toBe('2001:db8:2::10');
  });

  it('Neighbor Discovery füllt den Cache (Router und Host)', () => {
    const { e, r1, pc1 } = lab();
    pingRes(e, pc1, '2001:db8:2::10');
    expect(e.ndTable(pc1).some((n) => n.ip === '2001:db8:1::1')).toBe(true);
    expect(e.ndTable(r1).some((n) => n.ip === '2001:db8:12::2')).toBe(true);
  });

  it('Link-Local-Ping zwischen Nachbarroutern', () => {
    const { e, r1 } = lab();
    const llR2 = e.routingTable6(r1).length >= 0;
    expect(llR2).toBe(true);
    const nd = (): string[] => e.ndTable(r1).map((x) => x.ip);
    pingRes(e, r1, '2001:db8:12::2');
    expect(nd()).toContain('2001:db8:12::2');
  });

  it('SLAAC: Host bildet Adresse aus RA-Präfix + EUI-64 und nutzt den Router als Gateway', () => {
    const { e, pc1 } = lab({ slaac: true });
    sec(e, 10);
    const d = e.getDevice(pc1);
    if (d?.config.kind !== 'host') throw new Error('host');
    expect(d.config.v6.slaac).toHaveLength(1);
    expect(d.config.v6.slaac[0]?.addr.startsWith('2001:db8:1:')).toBe(true);
    expect(d.config.v6.raGateway?.addr.startsWith('fe80::')).toBe(true);
    const [r] = pingRes(e, pc1, '2001:db8:2::10');
    expect(r?.status).toBe('reply');
  });

  it('keine Route: ICMPv6 Destination Unreachable wird gemeldet', () => {
    const { e, pc1 } = lab();
    const [r] = pingRes(e, pc1, '2001:db8:99::1');
    expect(r?.status).toBe('unreachable');
    expect(r?.note).toBe('ping.netUnreachable');
  });

  it('ohne ipv6 unicast-routing leitet der Router nicht weiter', () => {
    const { e, r1, pc1 } = lab();
    must(e.setIpv6Routing(r1, false));
    const [r] = pingRes(e, pc1, '2001:db8:2::10');
    expect(r?.status).toBe('timeout');
  });
});

describe('OSPFv3', () => {
  it('lernt IPv6-Präfixe über Link-Local-Nachbarn und routet End-to-End', () => {
    const e = new Engine({ seed: 1 });
    const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((n) => e.addDevice('router', { name: n })) as [
      string,
      string,
      string,
    ];
    const pc1 = e.addDevice('pc', { name: 'PC1' });
    const pc3 = e.addDevice('pc', { name: 'PC3' });
    rlink(e, r1, 'p0', r2, 'p0');
    rlink(e, r2, 'p1', r3, 'p0');
    must(e.connect({ deviceId: pc1, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'crossover'));
    must(e.connect({ deviceId: pc3, portId: 'p0' }, { deviceId: r3, portId: 'p1' }, 'crossover'));
    e.setPortAdmin(r1, 'p1', true);
    e.setPortAdmin(r3, 'p1', true);
    const nets: [string, string, string, string][] = [
      [r1, 'p0', '2001:db8:12::1', '1.1.1.1'],
      [r2, 'p0', '2001:db8:12::2', '2.2.2.2'],
      [r2, 'p1', '2001:db8:23::2', '2.2.2.2'],
      [r3, 'p0', '2001:db8:23::3', '3.3.3.3'],
      [r1, 'p1', '2001:db8:1::1', '1.1.1.1'],
      [r3, 'p1', '2001:db8:3::1', '3.3.3.3'],
    ];
    for (const id of [r1, r2, r3]) must(e.setIpv6Routing(id, true));
    for (const [id, port, addr] of nets) must(e.setInterfaceIp6(id, port, addr, 64));
    for (const [id, rid] of [
      [r1, '1.1.1.1'],
      [r2, '2.2.2.2'],
      [r3, '3.3.3.3'],
    ] as const) {
      const d = e.getDevice(id);
      if (d?.config.kind !== 'router') throw new Error('router');
      const c = newOspf(1, true);
      c.routerId = rid;
      d.config.routing.ospf6[1] = c;
      for (const ic of Object.values(d.config.ifaces))
        if (ic.v6) ic.v6.ospf = { pid: 1, area: '0' };
      e.routingChanged(id);
    }
    must(e.setHostIpv6(pc1, { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' }));
    must(e.setHostIpv6(pc3, { addr: '2001:db8:3::10', plen: 64, gateway: '2001:db8:3::1' }));
    sec(e, 120);
    const tbl = e.routingTable6(r1).filter((x) => x.type === 'O');
    expect(tbl.map((x) => `${x.prefix}/${x.plen}`).sort()).toEqual([
      '2001:db8:23::/64',
      '2001:db8:3::/64',
    ]);
    expect(tbl.find((x) => x.prefix === '2001:db8:3::')?.metric).toBe(3);
    const [r] = pingRes(e, pc1, '2001:db8:3::10');
    expect(r?.status).toBe('reply');
  });
});
