import { describe, expect, it } from 'vitest';
import { Engine, daiOf, liveBindings, snoopOf, type HostConfig } from '../src';
import { converge } from './helpers';
import { dev, host, ifaceUp, l3Cfg, link, ok, ping, router, swCfg } from './labs3';

const hc = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const logOf = (e: Engine, id: string): string[] => swCfg(e, id).sys.mgmt?.logBuffer ?? [];

/** R1 (DHCP-Server, Gi0/0) - S1 p23 (Uplink); PC0 an p0, PC1 an p1. */
function lab(opts: { trustUplink: boolean } = { trustUplink: true }) {
  const e = new Engine({ seed: 1 });
  const r = router(e);
  const sw = e.addDevice('switch-l2', { name: 'S1' });
  link(e, r, 'p0', sw, 'p23');
  ifaceUp(e, r, 'p0', '10.0.1.1');
  l3Cfg(e, r).dhcp.pools.push({
    name: 'LAN',
    network: '10.0.1.0',
    mask: '255.255.255.0',
    router: '10.0.1.1',
    dns: [],
    leaseSec: 3600,
  });
  l3Cfg(e, r).dhcp.excluded.push({ from: '10.0.1.1', to: '10.0.1.9' });
  const pc = host(e, 'PC0', '');
  link(e, pc, 'p0', sw, 'p0');
  const pc2 = host(e, 'PC1', '');
  link(e, pc2, 'p0', sw, 'p1');
  for (const p of ['p0', 'p1']) ok(e.setSwitchport(sw, p, { portfast: true }));
  const sn = snoopOf(swCfg(e, sw));
  sn.enabled = true;
  sn.vlans = [1];
  ok(e.setSwitchport(sw, 'p23', { snoopTrust: opts.trustUplink, portfast: true }));
  converge(e, 35);
  return { e, r, sw, pc, pc2 };
}

describe('DHCP snooping', () => {
  it('trusted uplink: option 82 is rejected by IOS server without trust-all, then binding appears', () => {
    const { e, r, sw, pc } = lab();
    ok(e.setHostDhcp(pc, true));
    e.runUntil(e.state.now + 8_000_000);
    expect(hc(e, pc).dhcpClient.state).not.toBe('bound');
    l3Cfg(e, r).dhcp.trustAll = true;
    e.runUntil(e.state.now + 30_000_000);
    expect(hc(e, pc).dhcpClient.state).toBe('bound');
    const b = liveBindings(swCfg(e, sw), e.state.now);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ vlan: 1, portId: 'p0', ip: hc(e, pc).ip, type: 'dhcp-snooping' });
  });

  it('no information option: works with a plain server', () => {
    const { e, sw, pc } = lab();
    snoopOf(swCfg(e, sw)).option82 = false;
    ok(e.setHostDhcp(pc, true));
    e.runUntil(e.state.now + 10_000_000);
    expect(hc(e, pc).dhcpClient.state).toBe('bound');
  });

  it('untrusted uplink: server replies are dropped and logged', () => {
    const { e, sw, pc } = lab({ trustUplink: false });
    snoopOf(swCfg(e, sw)).option82 = false;
    ok(e.setHostDhcp(pc, true));
    e.runUntil(e.state.now + 10_000_000);
    expect(hc(e, pc).dhcpClient.state).not.toBe('bound');
    expect(
      logOf(e, sw).some((l) =>
        l.includes(
          '%DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT: DHCP_SNOOPING drop message on untrusted port, message type: DHCPOFFER, MAC sa: ',
        ),
      ),
    ).toBe(true);
    expect(snoopOf(swCfg(e, sw)).stats.untrustedDrop).toBeGreaterThan(0);
  });

  it('rate limit errdisables the port', () => {
    const { e, sw, pc } = lab();
    snoopOf(swCfg(e, sw)).option82 = false;
    ok(e.setSwitchport(sw, 'p0', { snoopRate: 1 }));
    ok(e.setHostDhcp(pc, true));
    e.runUntil(e.state.now + 10_000_000);
    expect(dev(e, sw).ports[0]?.errdisabled).toBe('dhcp-rate-limit');
    expect(
      logOf(e, sw).some((l) =>
        l.includes('%PM-4-ERR_DISABLE: dhcp-rate-limit error detected on FastEthernet0/1'),
      ),
    ).toBe(true);
  });
});

describe('Dynamic ARP Inspection', () => {
  function daiLab() {
    const l = lab();
    snoopOf(swCfg(l.e, l.sw)).option82 = false;
    ok(l.e.setHostDhcp(l.pc, true));
    l.e.runUntil(l.e.state.now + 10_000_000);
    daiOf(swCfg(l.e, l.sw)).vlans = [1];
    ok(l.e.setSwitchport(l.sw, 'p23', { daiTrust: true }));
    return l;
  }

  it('hosts with a DHCP binding keep working', () => {
    const { e, pc } = daiLab();
    expect(ping(e, pc, '10.0.1.1')).toBe('reply');
  });

  it('a statically configured host is dropped (no binding) and logged', () => {
    const { e, sw, pc2 } = daiLab();
    ok(e.setHostIp(pc2, '10.0.1.50', '255.255.255.0', '10.0.1.1'));
    expect(ping(e, pc2, '10.0.1.1')).not.toBe('reply');
    expect(
      logOf(e, sw).some((l) =>
        l.includes(
          '%SW_DAI-4-DHCP_SNOOPING_DENY: 1 Invalid ARPs (Req) on FastEthernet0/2, vlan 1.',
        ),
      ),
    ).toBe(true);
    expect(daiOf(swCfg(e, sw)).stats[1]?.dhcpDrops).toBeGreaterThan(0);
  });

  it('an ARP ACL entry permits the static host', () => {
    const { e, sw, pc2 } = daiLab();
    ok(e.setHostIp(pc2, '10.0.1.50', '255.255.255.0', '10.0.1.1'));
    const mac = dev(e, pc2).ports[0]?.mac as string;
    const d = daiOf(swCfg(e, sw));
    d.acls['STATIC'] = [{ ip: '10.0.1.50', mac }];
    d.filters.push({ acl: 'STATIC', vlan: 1, static: false });
    expect(ping(e, pc2, '10.0.1.1')).toBe('reply');
  });

  it('rate limit errdisables a flooding port', () => {
    const { e, sw, pc2 } = daiLab();
    ok(e.setHostIp(pc2, '10.0.1.50', '255.255.255.0', '10.0.1.1'));
    ok(e.setSwitchport(sw, 'p1', { daiRate: 2 }));
    for (let i = 2; i < 8; i++) e.ping(pc2, `10.0.1.${100 + i}`);
    e.runAll();
    expect(dev(e, sw).ports[1]?.errdisabled).toBe('arp-inspection');
  });
});

describe('Storm control', () => {
  function stormLab(action: 'filter' | 'shutdown') {
    const e = new Engine({ seed: 1 });
    const sw = e.addDevice('switch-l2', { name: 'S1' });
    const a = host(e, 'A', '10.0.0.1');
    const b = host(e, 'B', '10.0.0.2');
    link(e, a, 'p0', sw, 'p0');
    link(e, b, 'p0', sw, 'p1');
    ok(
      e.setSwitchport(sw, 'p0', {
        portfast: true,
        storm: { broadcast: { unit: 'pps', rising: 2 }, action },
      }),
    );
    converge(e, 35);
    for (let i = 20; i < 30; i++) e.ping(a, `10.0.0.${i}`);
    e.runAll();
    return { e, sw };
  }

  it('filters a broadcast storm above the pps threshold and logs once', () => {
    const { e, sw } = stormLab('filter');
    const hits = logOf(e, sw).filter((l) =>
      l.includes(
        '%STORM_CONTROL-3-FILTERED: A Broadcast storm detected on FastEthernet0/1. A packet filter action has been applied on the interface.',
      ),
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(dev(e, sw).ports[0]?.errdisabled).toBeUndefined();
  });

  it('action shutdown err-disables the port', () => {
    const { e, sw } = stormLab('shutdown');
    expect(dev(e, sw).ports[0]?.errdisabled).toBe('storm-control');
  });
});

describe('DTP nonegotiate, portfast default', () => {
  it('peer in dynamic auto stays access when the trunk side has nonegotiate', () => {
    const e = new Engine({ seed: 1 });
    const s1 = e.addDevice('switch-l2', { name: 'S1' });
    const s2 = e.addDevice('switch-l2', { name: 'S2' });
    link(e, s1, 'p23', s2, 'p23', 'crossover');
    ok(e.setSwitchport(s1, 'p23', { mode: 'trunk' }));
    converge(e, 5);
    expect(swCfg(e, s2).operTrunk['p23']).toBe(true);
    ok(e.setSwitchport(s1, 'p23', { nonegotiate: true }));
    expect(swCfg(e, s2).operTrunk['p23']).toBeFalsy();
  });

  it('portfast default makes access ports edge ports', () => {
    const e = new Engine({ seed: 1 });
    const sw = e.addDevice('switch-l2', { name: 'S1' });
    const a = host(e, 'A', '10.0.0.1');
    link(e, a, 'p0', sw, 'p0');
    swCfg(e, sw).portfastDefault = true;
    ok(e.setSwitchport(sw, 'p0', { mode: 'access' }));
    e.runUntil(e.state.now + 2_000_000);
    expect(swCfg(e, sw).stp.instances[1]?.ports['p0']?.state).toBe('forwarding');
  });
});
