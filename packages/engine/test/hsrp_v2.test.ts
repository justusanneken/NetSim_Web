import { describe, expect, it } from 'vitest';
import { Engine, newHsrp, type HsrpCfg } from '../src';
import { must, rip4, rlink, sec } from './labs4';

/** R1/R2 (HSRP-Gruppe am Switch) – PC; R3 hinter beiden Routern als Ziel. */
function lab(opts: { v6?: boolean } = {}) {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  const sw = e.addDevice('switch-l2', { name: 'SW' });
  const pc = e.addDevice('pc', { name: 'PC' });
  must(e.connect({ deviceId: r1, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: r2, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight'));
  must(e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: sw, portId: 'p2' }, 'straight'));
  rlink(e, r1, 'p1', r2, 'p1');
  rip4(e, r1, 'p0', '10.0.0.2');
  rip4(e, r2, 'p0', '10.0.0.3');
  rip4(e, r1, 'p1', '10.9.1.1');
  rip4(e, r2, 'p1', '10.9.1.2');
  must(e.setHostIp(pc, '10.0.0.10', '255.255.255.0', '10.0.0.1'));
  if (opts.v6) {
    for (const id of [r1, r2]) must(e.setIpv6Routing(id, true));
    must(e.setInterfaceIp6(r1, 'p0', '2001:db8:1::2', 64));
    must(e.setInterfaceIp6(r2, 'p0', '2001:db8:1::3', 64));
    must(e.setHostIpv6(pc, { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' }));
  }
  return { e, r1, r2, pc };
}

const ic = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  const c = d.config.ifaces['p0'];
  if (!c) throw new Error('iface');
  return c;
};

const setGroup = (
  e: Engine,
  id: string,
  g: Partial<HsrpCfg> & { group: number },
  version?: 1 | 2,
): HsrpCfg => {
  const c = ic(e, id);
  const full: HsrpCfg = { ...newHsrp(g.group), ...g };
  if (version) c.hsrpVersion = version;
  if (full.v6) (c.hsrp6 ??= {})[g.group] = full;
  else (c.hsrp ??= {})[g.group] = full;
  e.routingChanged(id);
  return full;
};

describe('HSRP Version 2', () => {
  it('Gruppen > 255, virtuelle MAC 0000.0c9f.fXXX, Multicast 224.0.0.102', () => {
    const { e, r1, r2, pc } = lab();
    const g1 = setGroup(e, r1, { group: 300, vip: '10.0.0.1', priority: 110, preempt: true }, 2);
    const g2 = setGroup(e, r2, { group: 300, vip: '10.0.0.1' }, 2);
    sec(e, 60);
    expect(g1.state).toBe('active');
    expect(g2.state).toBe('standby');
    e.ping(pc, '10.9.1.1', { count: 1 });
    e.runAll();
    const cfg = e.getDevice(pc)?.config;
    expect(cfg?.kind === 'host' && cfg.arpCache['10.0.0.1']?.mac).toBe('00:00:0c:9f:f1:2c');
    expect(cfg?.kind === 'host' && cfg.pings.at(-1)?.status).toBe('reply');
    const hello = e.log.find((l) => l.proto === 'HSRP' && l.frame?.payload.kind === 'ipv4');
    const ip = hello?.frame?.payload;
    expect(ip?.kind === 'ipv4' && ip.dst).toBe('224.0.0.102');
  });

  it('Version 1 und 2 verstehen sich nicht: beide werden Active', () => {
    const { e, r1, r2 } = lab();
    const g1 = setGroup(e, r1, { group: 1, vip: '10.0.0.1' }, 2);
    const g2 = setGroup(e, r2, { group: 1, vip: '10.0.0.1' }, 1);
    sec(e, 60);
    expect(g1.state).toBe('active');
    expect(g2.state).toBe('active');
  });
});

describe('HSRP Authentifizierung', () => {
  it('falscher Schlüssel: Hellos werden verworfen, beide Active', () => {
    const { e, r1, r2 } = lab();
    const g1 = setGroup(e, r1, { group: 1, vip: '10.0.0.1', authKey: 'geheim' });
    const g2 = setGroup(e, r2, { group: 1, vip: '10.0.0.1', authKey: 'anders' });
    sec(e, 60);
    expect(g1.state).toBe('active');
    expect(g2.state).toBe('active');
    expect(e.log.some((l) => l.msg.key === 'hsrp.authFail')).toBe(true);
  });

  it('gleicher Schlüssel (auch Default `cisco`): normale Wahl', () => {
    const { e, r1, r2 } = lab();
    const g1 = setGroup(e, r1, { group: 1, vip: '10.0.0.1', priority: 120, authKey: 'geheim' });
    const g2 = setGroup(e, r2, { group: 1, vip: '10.0.0.1', authKey: 'geheim' });
    sec(e, 60);
    expect(g1.state).toBe('active');
    expect(g2.state).toBe('standby');
    expect(e.log.some((l) => l.msg.key === 'hsrp.authFail')).toBe(false);
  });
});

describe('HSRP für IPv6', () => {
  it('autoconfig: virtuelle Link-Local, vMAC 0005.73a0.0xxx, ND wird beantwortet, Failover', () => {
    const { e, r1, r2, pc } = lab({ v6: true });
    const g1 = setGroup(
      e,
      r1,
      { group: 1, v6: true, autoconfig: true, priority: 110, preempt: true },
      2,
    );
    const g2 = setGroup(e, r2, { group: 1, v6: true, autoconfig: true }, 2);
    sec(e, 60);
    expect(g1.state).toBe('active');
    expect(g2.state).toBe('standby');
    // Host-Gateway = virtuelle Link-Local
    const d = e.getDevice(pc);
    if (d?.config.kind !== 'host') throw new Error('host');
    d.config.v6.gateway = 'fe80::5:73ff:fea0:1';
    e.ping(pc, 'fe80::5:73ff:fea0:1', { count: 1 });
    e.runAll();
    expect(e.ndTable(pc).find((n) => n.ip === 'fe80::5:73ff:fea0:1')?.mac).toBe(
      '00:05:73:a0:00:01',
    );
    // Failover: R1 fällt aus → R2 wird Active und antwortet für dieselbe virtuelle Adresse
    e.setPower(r1, false);
    sec(e, 20);
    expect(g2.state).toBe('active');
  });

  it('explizite Adresse: Ping der virtuellen Adresse, Failover auf den Standby-Router', () => {
    const { e, r1, r2, pc } = lab({ v6: true });
    const g1 = setGroup(
      e,
      r1,
      { group: 2, v6: true, vip: '2001:db8:1::1', priority: 110, preempt: true },
      2,
    );
    const g2 = setGroup(e, r2, { group: 2, v6: true, vip: '2001:db8:1::1' }, 2);
    sec(e, 60);
    expect(g1.state).toBe('active');
    expect(g2.state).toBe('standby');
    const ping = (): string | undefined => {
      e.ping(pc, '2001:db8:1::1', { count: 1 });
      e.runAll();
      const cfg = e.getDevice(pc)?.config;
      return cfg?.kind === 'host' ? cfg.pings.at(-1)?.status : undefined;
    };
    expect(ping()).toBe('reply');
    expect(e.ndTable(pc).find((n) => n.ip === '2001:db8:1::1')?.mac).toBe('00:05:73:a0:00:02');
    e.setPortAdmin(r1, 'p0', false);
    sec(e, 20);
    expect(g2.state).toBe('active');
    // ND-Cache des PCs leeren, damit die virtuelle MAC neu erfragt wird
    const cfg = e.getDevice(pc)?.config;
    if (cfg?.kind === 'host') cfg.nd = {};
    expect(ping()).toBe('reply');
  });
});
