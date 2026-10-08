import { describe, expect, it } from 'vitest';
import { Engine, newDhcp6Pool, type HostConfig } from '../src';
import { must, sec } from './labs4';

function lab(flags: { managed?: boolean; other?: boolean }) {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const pc = e.addDevice('pc', { name: 'PC' });
  must(e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'crossover'));
  e.setPortAdmin(r1, 'p1', true);
  must(e.setIpv6Routing(r1, true));
  must(e.setInterfaceIp6(r1, 'p1', '2001:db8:1::1', 64));
  const d = e.getDevice(r1);
  if (d?.config.kind !== 'router') throw new Error('router');
  const pool = newDhcp6Pool('LAN');
  pool.prefix = { prefix: '2001:db8:1::', plen: 64 };
  pool.dns = ['2001:db8:ffff::53'];
  pool.domain = 'example.test';
  d.config.dhcp6 = { pools: [pool], bindings: {} };
  const v6 = d.config.ifaces['p1']?.v6;
  if (!v6) throw new Error('v6');
  v6.dhcp6Server = 'LAN';
  v6.managed = flags.managed;
  v6.otherConfig = flags.other;
  e.routingChanged(r1);
  must(e.setHostIpv6(pc, { autoconfig: true, dhcp6: true }));
  return { e, r1, pc };
}

const host = (e: Engine, id: string): HostConfig => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'host') throw new Error('host');
  return d.config;
};

describe('DHCPv6', () => {
  it('zustandsbehaftet (M-Flag): Adresse aus dem Pool, DNS und Domain', () => {
    const { e, r1, pc } = lab({ managed: true });
    sec(e, 15);
    const h = host(e, pc);
    expect(h.v6.dhcpAddrs).toHaveLength(1);
    const a = h.v6.dhcpAddrs?.[0]?.addr ?? '';
    expect(a.startsWith('2001:db8:1::')).toBe(true);
    expect(h.v6.dns6).toEqual(['2001:db8:ffff::53']);
    expect(h.v6.domain6).toBe('example.test');
    expect(h.v6.dh6?.state).toBe('bound');
    expect(h.dad?.[a]?.state).toBe('ok');
    // Server führt eine Bindung
    const d = e.getDevice(r1);
    expect(d?.config.kind === 'router' && Object.keys(d.config.dhcp6?.bindings ?? {})).toHaveLength(
      1,
    );
    // Die zugewiesene Adresse ist erreichbar
    e.ping(r1, a, { count: 1 });
    e.runAll();
    const rc = e.getDevice(r1)?.config;
    expect(rc?.kind === 'router' && rc.pings.at(-1)?.status).toBe('reply');
  });

  it('zustandslos (O-Flag): nur DNS/Domain, keine DHCPv6-Adresse (Adresse per SLAAC)', () => {
    const { e, pc } = lab({ other: true });
    sec(e, 15);
    const h = host(e, pc);
    expect(h.v6.dhcpAddrs ?? []).toHaveLength(0);
    expect(h.v6.slaac.length).toBe(1);
    expect(h.v6.dns6).toEqual(['2001:db8:ffff::53']);
    expect(h.v6.dh6?.state).toBe('bound');
  });

  it('ohne M/O-Flags bleibt der DHCPv6-Client untätig', () => {
    const { e, pc } = lab({});
    sec(e, 15);
    const h = host(e, pc);
    expect(h.v6.dh6).toBeUndefined();
    expect(h.v6.dns6).toBeUndefined();
  });

  it('Client ohne Antwort meldet nach mehreren Versuchen einen Fehler', () => {
    const { e, r1, pc } = lab({ managed: true });
    const d = e.getDevice(r1);
    if (d?.config.kind !== 'router') throw new Error('router');
    d.config.dhcp6 = { pools: [], bindings: {} }; // Pool existiert nicht mehr
    sec(e, 30);
    expect(host(e, pc).v6.dh6?.state).toBe('idle');
    expect(e.log.some((l) => l.msg.key === 'dhcp6.noServer')).toBe(true);
  });
});
