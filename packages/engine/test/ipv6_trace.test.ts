import { describe, expect, it } from 'vitest';
import { Engine } from '../src';
import { must, rlink, sec } from './labs4';

/** PC1 – R1 – R2 – PC2 mit statischen IPv6-Routen. */
function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  const pc2 = e.addDevice('pc', { name: 'PC2' });
  rlink(e, r1, 'p0', r2, 'p0');
  must(e.connect({ deviceId: pc1, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'crossover'));
  must(e.connect({ deviceId: pc2, portId: 'p0' }, { deviceId: r2, portId: 'p1' }, 'crossover'));
  e.setPortAdmin(r1, 'p1', true);
  e.setPortAdmin(r2, 'p1', true);
  for (const id of [r1, r2]) must(e.setIpv6Routing(id, true));
  must(e.setInterfaceIp6(r1, 'p0', '2001:db8:12::1', 64));
  must(e.setInterfaceIp6(r2, 'p0', '2001:db8:12::2', 64));
  must(e.setInterfaceIp6(r1, 'p1', '2001:db8:1::1', 64));
  must(e.setInterfaceIp6(r2, 'p1', '2001:db8:2::1', 64));
  must(e.addStaticRoute6(r1, { prefix: '2001:db8:2::', plen: 64, nextHop: '2001:db8:12::2' }));
  must(e.addStaticRoute6(r2, { prefix: '2001:db8:1::', plen: 64, nextHop: '2001:db8:12::1' }));
  must(e.setHostIpv6(pc1, { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' }));
  must(e.setHostIpv6(pc2, { addr: '2001:db8:2::10', plen: 64, gateway: '2001:db8:2::1' }));
  sec(e, 3);
  return { e, r1, r2, pc1, pc2 };
}

const hops = (e: Engine, id: string): (string | undefined)[] => {
  const cfg = e.getDevice(id)?.config;
  if (!cfg || (cfg.kind !== 'host' && cfg.kind !== 'router')) return [];
  return (cfg.traces.at(-1)?.hops ?? []).map((h) => h.probes[0]?.from);
};

describe('IPv6 Traceroute', () => {
  it('Host: jeder Router meldet sich per Time Exceeded, das Ziel antwortet', () => {
    const { e, pc1 } = lab();
    must(e.trace(pc1, '2001:db8:2::10'));
    sec(e, 30);
    expect(hops(e, pc1)).toEqual(['2001:db8:1::1', '2001:db8:12::2', '2001:db8:2::10']);
    const cfg = e.getDevice(pc1)?.config;
    expect(cfg?.kind === 'host' && cfg.traces.at(-1)?.done).toBe(true);
  });

  it('Router: traceroute ipv6 von R1 zum PC hinter R2', () => {
    const { e, r1 } = lab();
    must(e.trace(r1, '2001:db8:2::10'));
    sec(e, 30);
    expect(hops(e, r1)).toEqual(['2001:db8:12::2', '2001:db8:2::10']);
  });

  it('keine Route: Probe scheitert, Trace endet', () => {
    const { e, pc1 } = lab();
    must(e.trace(pc1, '2001:db8:99::1'));
    sec(e, 30);
    const cfg = e.getDevice(pc1)?.config;
    expect(cfg?.kind === 'host' && cfg.traces.at(-1)?.done).toBe(true);
    expect(hops(e, pc1)[0]).toBe('2001:db8:1::1'); // R1 meldet: Destination Unreachable
  });
});
