import { describe, expect, it } from 'vitest';
import {
  CheckSchema,
  cloneEngine,
  evaluateChecks,
  needsSettle,
  normMask,
  plenOf,
  resolveIface,
  resolvePort,
  type Check,
  type CheckInput,
  type Engine,
  type RouterConfig,
  type SwitchConfig,
} from '../src';
import { chainLab, routerLab, switchLab } from './helpers';
import { aclEntry, ANY, eq, hostMatch, net } from './labs3';

const chk = (c: CheckInput): Check => CheckSchema.parse(c);
const one = (e: Engine, c: CheckInput) => {
  const r = evaluateChecks(e, [chk(c)]);
  return r.results[0] as NonNullable<(typeof r.results)[number]>;
};
const pass = (e: Engine, c: CheckInput) => expect(one(e, c).passed, JSON.stringify(c)).toBe(true);
const fails = (e: Engine, c: CheckInput, key?: string) => {
  const r = one(e, c);
  expect(r.passed, JSON.stringify(c)).toBe(false);
  if (key) expect(r.reason?.key).toBe(`check.fail.${key}`);
};

describe('Namensaufloesung', () => {
  it('Ports und Schnittstellen per Abkuerzung', () => {
    const lab = routerLab();
    const d = lab.e.getDevice(lab.r1);
    if (!d || d.config.kind !== 'router') throw new Error('router');
    const p = d.ports[0];
    expect(resolvePort(d, p?.id as string)).toBe(p);
    expect(resolvePort(d, (p?.name as string).toLowerCase())).toBe(p);
    expect(resolvePort(d, 'gi0/0')?.id).toBe(d.ports.find((x) => /gigabit/i.test(x.name))?.id);
    expect(resolvePort(d, 'x')).toBeUndefined();
    expect(resolveIface(d, d.config, 'p0')?.id).toBe('p0');
    expect(resolveIface(d, d.config, 'nonsense')).toBeUndefined();
    expect(resolveIface(d, d.config, 'Vlan9')).toBeUndefined();
    expect(resolveIface(d, d.config, 'Loopback1')).toBeUndefined();
  });

  it('Masken in Punkt- und Slash-Schreibweise', () => {
    expect(normMask('/24')).toBe('255.255.255.0');
    expect(normMask('24')).toBe('255.255.255.0');
    expect(normMask('255.255.0.0')).toBe('255.255.0.0');
    expect(normMask('255.0.255.0')).toBeUndefined();
    expect(normMask('/33')).toBeUndefined();
    expect(plenOf('255.255.255.128')).toBe(25);
    expect(plenOf(16)).toBe(16);
    expect(plenOf(40)).toBeUndefined();
    expect(plenOf(undefined)).toBeUndefined();
  });
});

describe('statische Pruefungen', () => {
  it('Geraet, Typ, Host-IP', () => {
    const lab = routerLab();
    const n0 = lab.e.getDevice(lab.pc0)?.name as string;
    pass(lab.e, { id: 'a', type: 'deviceExists', device: n0 });
    pass(lab.e, { id: 'a', type: 'deviceExists', device: n0, deviceType: 'pc' });
    fails(lab.e, { id: 'a', type: 'deviceExists', device: n0, deviceType: 'router' }, 'deviceType');
    fails(lab.e, { id: 'a', type: 'deviceExists', device: 'Ghost' }, 'noDevice');
    pass(lab.e, {
      id: 'b',
      type: 'hostIp',
      device: n0,
      ip: '10.0.1.10',
      mask: '/24',
      gateway: '10.0.1.1',
    });
    fails(lab.e, { id: 'b', type: 'hostIp', device: n0, ip: '10.0.1.11' }, 'hostIp');
    fails(
      lab.e,
      { id: 'b', type: 'hostIp', device: n0, ip: '10.0.1.10', mask: '255.255.0.0' },
      'hostMask',
    );
    fails(
      lab.e,
      { id: 'b', type: 'hostIp', device: n0, ip: '10.0.1.10', gateway: '10.0.1.2' },
      'hostGateway',
    );
    fails(lab.e, { id: 'b', type: 'hostIp', device: lab.r1, ip: '10.0.1.10' }, 'notHost');
  });

  it('Router-Schnittstellen: IP und Zustand', () => {
    const lab = routerLab();
    pass(lab.e, {
      id: 'i',
      type: 'ifaceIp',
      device: lab.r1,
      iface: 'p0',
      ip: '10.0.1.1',
      mask: '255.255.255.0',
    });
    pass(lab.e, {
      id: 'i',
      type: 'ifaceIp',
      device: lab.r1,
      iface: 'p1',
      ip: '10.0.2.1',
      mask: '/24',
    });
    fails(
      lab.e,
      { id: 'i', type: 'ifaceIp', device: lab.r1, iface: 'p0', ip: '10.9.9.9' },
      'ifaceIp',
    );
    fails(
      lab.e,
      { id: 'i', type: 'ifaceIp', device: lab.r1, iface: 'p0', ip: '10.0.1.1', mask: '/16' },
      'ifaceMask',
    );
    fails(
      lab.e,
      { id: 'i', type: 'ifaceIp', device: lab.r1, iface: 'zz', ip: '10.0.1.1' },
      'noIface',
    );
    fails(
      lab.e,
      { id: 'i', type: 'ifaceIp', device: lab.pc0, iface: 'p0', ip: '10.0.1.1' },
      'notL3',
    );
    pass(lab.e, { id: 's', type: 'ifaceState', device: lab.r1, iface: 'p0', up: true });
    fails(
      lab.e,
      { id: 's', type: 'ifaceState', device: lab.r1, iface: 'p0', up: false },
      'ifaceUp',
    );
    lab.e.setPortAdmin(lab.r1, 'p0', false);
    fails(
      lab.e,
      { id: 's', type: 'ifaceState', device: lab.r1, iface: 'p0', up: true },
      'ifaceDown',
    );
    pass(lab.e, { id: 's', type: 'ifaceState', device: lab.r1, iface: 'p0', up: false });
    pass(lab.e, { id: 's', type: 'ifaceState', device: lab.pc1, iface: 'p0', up: true });
    fails(
      lab.e,
      { id: 's', type: 'ifaceState', device: lab.pc0, iface: 'qq', up: true },
      'noIface',
    );
  });

  it('VLAN-Zugehoerigkeit und Trunk', () => {
    const { e, sw, ids } = switchLab(2);
    const swId = sw as string;
    const name = e.getDevice(swId)?.name as string;
    expect(e.addVlan(swId, 10, 'Sales').ok).toBe(true);
    expect(e.setSwitchport(swId, 'p0', { mode: 'access', accessVlan: 10 }).ok).toBe(true);
    expect(
      e.setSwitchport(swId, 'p5', { mode: 'trunk', allowed: [10, 20], nativeVlan: 99 }).ok,
    ).toBe(true);
    pass(e, { id: 'v', type: 'vlanExists', device: name, vlan: 10 });
    pass(e, { id: 'v', type: 'vlanExists', device: name, vlan: 10, name: 'sales' });
    fails(e, { id: 'v', type: 'vlanExists', device: name, vlan: 10, name: 'HR' }, 'vlanName');
    fails(e, { id: 'v', type: 'vlanExists', device: name, vlan: 11 }, 'noVlan');
    fails(
      e,
      {
        id: 'v',
        type: 'vlanExists',
        device: e.getDevice(ids[0] as string)?.name as string,
        vlan: 10,
      },
      'notSwitch',
    );
    pass(e, { id: 'm', type: 'vlanMember', device: name, port: 'p0', vlan: 10 });
    fails(e, { id: 'm', type: 'vlanMember', device: name, port: 'p1', vlan: 10 }, 'vlanMember');
    fails(e, { id: 'm', type: 'vlanMember', device: name, port: 'nope', vlan: 10 }, 'noPort');
    pass(e, { id: 't', type: 'trunk', device: name, port: 'p5' });
    pass(e, { id: 't', type: 'trunk', device: name, port: 'p5', allowed: [10], native: 99 });
    fails(e, { id: 't', type: 'trunk', device: name, port: 'p5', native: 1 }, 'trunkNative');
    fails(e, { id: 't', type: 'trunk', device: name, port: 'p5', allowed: [30] }, 'trunkAllowed');
    fails(e, { id: 't', type: 'trunk', device: name, port: 'p0' }, 'trunk');
  });

  it('Routen: statisch, verbunden, Next Hop', () => {
    const lab = chainLab();
    const r1 = lab.e.getDevice(lab.r1)?.name as string;
    pass(lab.e, { id: 'r', type: 'route', device: r1, prefix: '10.0.2.0', plen: 24 });
    pass(lab.e, {
      id: 'r',
      type: 'route',
      device: r1,
      prefix: '10.0.2.0',
      plen: '255.255.255.0',
      source: 'static',
      via: '10.0.12.2',
    });
    pass(lab.e, {
      id: 'r',
      type: 'route',
      device: r1,
      prefix: '10.0.1.0',
      plen: 24,
      source: 'connected',
    });
    fails(
      lab.e,
      { id: 'r', type: 'route', device: r1, prefix: '10.0.2.0', plen: 24, via: '10.0.12.9' },
      'route',
    );
    fails(
      lab.e,
      { id: 'r', type: 'route', device: r1, prefix: '10.0.2.0', plen: 24, source: 'ospf' },
      'route',
    );
    fails(lab.e, { id: 'r', type: 'route', device: r1, prefix: '172.16.0.0', plen: 16 }, 'route');
    fails(
      lab.e,
      { id: 'r', type: 'route', device: lab.pc0, prefix: '10.0.2.0', plen: 24 },
      'notL3',
    );
  });

  it('Konfigurationspunkte (semantisch)', () => {
    const lab = routerLab();
    const e = lab.e;
    const d = e.getDevice(lab.r1);
    if (d?.config.kind !== 'router') throw new Error('router');
    const cfg: RouterConfig = d.config;
    const dn = d.name;
    cfg.sys.hostname = 'Edge';
    cfg.sys.enableSecret = 'x';
    cfg.sys.domainName = 'lab.local';
    cfg.sys.descriptions['p0'] = 'LAN';
    cfg.acls['110'] = {
      name: '110',
      type: 'extended',
      entries: [
        aclEntry({
          seq: 10,
          action: 'deny',
          proto: 'tcp',
          src: net('10.0.1.0', '0.0.0.255'),
          dst: ANY,
          dstPort: eq(80),
        }),
        aclEntry({ seq: 20, action: 'permit', proto: 'ip', src: ANY, dst: ANY }),
      ],
    };
    const p0 = cfg.ifaces['p0'];
    if (p0) {
      p0.aclIn = '110';
      p0.natSide = 'inside';
      p0.helpers = ['10.0.2.10'];
    }
    cfg.nat.rules.push({ kind: 'dynamic', acl: '1', pool: 'P', overload: true });
    cfg.nat.rules.push({ kind: 'static', local: '10.0.1.10', global: '1.1.1.1' });
    cfg.dhcp.pools.push({
      name: 'L',
      network: '10.0.1.0',
      mask: '255.255.255.0',
      router: '10.0.1.1',
      dns: ['8.8.8.8'],
      leaseSec: 86400,
    });
    const mg = (cfg.sys.mgmt ??= {
      users: {},
      ssh: { version: 2 },
      vty: { lines: 5, transport: ['telnet'], loginLocal: false },
      ntp: { servers: [] },
    } as never);
    mg.users['admin'] = { secret: 'x', privilege: 15 };
    mg.ntp.servers.push('10.9.9.9');
    cfg.routing.ospf[1] = {
      pid: 1,
      networks: [{ prefix: '10.0.1.0', wildcard: '0.0.0.255', area: '0' }],
      passive: [],
    } as never;
    const item = (spec: Record<string, unknown>, id = 'c') => ({
      id,
      type: 'config' as const,
      device: dn,
      spec,
    });
    pass(e, item({ item: 'hostname', value: 'edge' }));
    fails(e, item({ item: 'hostname', value: 'core' }), 'hostname');
    pass(e, item({ item: 'domainName', value: 'LAB.local' }));
    fails(e, item({ item: 'domainName', value: 'x' }), 'domainName');
    pass(e, item({ item: 'enableSecret' }));
    pass(e, item({ item: 'username', name: 'admin' }));
    fails(e, item({ item: 'username', name: 'bob' }), 'username');
    fails(e, item({ item: 'ssh' }), 'ssh');
    pass(e, item({ item: 'ntpServer', ip: '10.9.9.9' }));
    fails(e, item({ item: 'ntpServer', ip: '10.9.9.8' }), 'ntpServer');
    pass(e, item({ item: 'description', iface: 'p0', text: 'LAN' }));
    fails(e, item({ item: 'description', iface: 'p1' }), 'description');
    pass(e, item({ item: 'ifaceAcl', iface: 'p0', direction: 'in', acl: '110' }));
    fails(e, item({ item: 'ifaceAcl', iface: 'p0', direction: 'out', acl: '110' }), 'ifaceAcl');
    fails(e, item({ item: 'ifaceAcl', iface: 'p9', direction: 'out', acl: '110' }), 'noIface');
    pass(
      e,
      item({
        item: 'aclEntry',
        acl: '110',
        action: 'deny',
        protocol: 'tcp',
        dstPort: 80,
        src: '10.0.1.0/24',
      }),
    );
    pass(e, item({ item: 'aclEntry', acl: '110', action: 'permit', src: 'any' }));
    fails(
      e,
      item({ item: 'aclEntry', acl: '110', action: 'deny', protocol: 'tcp', dstPort: 443 }),
      'aclEntry',
    );
    fails(
      e,
      item({ item: 'aclEntry', acl: '110', action: 'deny', src: '10.0.1.0/25' }),
      'aclEntry',
    );
    fails(
      e,
      item({ item: 'aclEntry', acl: '110', action: 'deny', dstPort: 80, dst: '1.1.1.1/32' }),
      'aclEntry',
    );
    fails(e, item({ item: 'aclEntry', acl: '999', action: 'deny' }), 'noAcl');
    pass(e, item({ item: 'natRole', iface: 'p0', side: 'inside' }));
    fails(e, item({ item: 'natRole', iface: 'p0', side: 'outside' }), 'natRole');
    pass(e, item({ item: 'natOverload' }));
    pass(e, item({ item: 'natStatic', local: '10.0.1.10', global: '1.1.1.1' }));
    fails(e, item({ item: 'natStatic', local: '10.0.1.11', global: '1.1.1.1' }), 'natStatic');
    pass(e, item({ item: 'dhcpPool', network: '10.0.1.0', router: '10.0.1.1', dns: '8.8.8.8' }));
    fails(e, item({ item: 'dhcpPool', network: '10.0.2.0' }), 'dhcpPool');
    fails(e, item({ item: 'dhcpPool', network: '10.0.1.0', router: '10.0.1.9' }), 'dhcpPoolRouter');
    fails(e, item({ item: 'dhcpPool', network: '10.0.1.0', dns: '1.1.1.1' }), 'dhcpPoolDns');
    pass(e, item({ item: 'helperAddress', iface: 'p0', ip: '10.0.2.10' }));
    fails(e, item({ item: 'helperAddress', iface: 'p0', ip: '10.0.2.11' }), 'helper');
    pass(e, item({ item: 'ospfNetwork', pid: 1, network: '10.0.1.0', area: '0' }));
    fails(e, item({ item: 'ospfNetwork', pid: 1, network: '10.0.2.0' }), 'ospfNetwork');
    fails(e, item({ item: 'ospfNetwork', pid: 2, network: '10.0.1.0' }), 'noOspf');
    fails(e, item({ item: 'portfast', port: 'p0' }), 'notSwitch');
    fails(e, item({ item: 'stpMode', mode: 'pvst' }), 'notSwitch');
    fails(e, item({ item: 'vtp', mode: 'server' }), 'notSwitch');
    fails(
      e,
      { id: 'x', type: 'config', device: lab.pc0, spec: { item: 'hostname', value: 'a' } },
      'notCliDevice',
    );
    fails(e, item({ item: 'defaultGateway', ip: '1.1.1.1' }), 'defaultGateway');
  });

  it('Switch-Konfigurationspunkte', () => {
    const { e, sw } = switchLab(1);
    const d = e.getDevice(sw as string);
    if (d?.config.kind !== 'switch') throw new Error('switch');
    const cfg: SwitchConfig = d.config;
    const item = (spec: Record<string, unknown>) => ({
      id: 'c',
      type: 'config' as const,
      device: d.name,
      spec,
    });
    const pc = cfg.ports['p0'];
    if (pc) {
      pc.portfast = true;
      pc.psec.enabled = true;
    }
    cfg.vtp.mode = 'client';
    cfg.vtp.domain = 'LAB';
    cfg.defaultGateway = '10.0.0.254';
    pass(e, item({ item: 'portfast', port: 'p0' }));
    fails(e, item({ item: 'portfast', port: 'p1' }), 'portfast');
    pass(e, item({ item: 'portSecurity', port: 'p0' }));
    fails(e, item({ item: 'portSecurity', port: 'zz' }), 'noPort');
    pass(e, item({ item: 'stpMode', mode: cfg.stp.mode }));
    pass(e, item({ item: 'vtp', mode: 'client', domain: 'LAB' }));
    fails(e, item({ item: 'vtp', mode: 'server' }), 'vtp');
    pass(e, item({ item: 'defaultGateway', ip: '10.0.0.254' }));
  });
});

describe('dynamische Pruefungen', () => {
  it('Ping: Erfolg erwartet / Fehlschlag erwartet', () => {
    const lab = chainLab();
    const a = lab.e.getDevice(lab.pc0)?.name as string;
    const b = lab.e.getDevice(lab.pc1)?.name as string;
    pass(lab.e, { id: 'p', type: 'ping', from: a, to: b });
    pass(lab.e, { id: 'p', type: 'ping', from: a, to: '10.0.2.10' });
    fails(
      lab.e,
      { id: 'p', type: 'ping', from: a, to: '10.0.2.10', expect: 'fail' },
      'pingShouldFail',
    );
    fails(lab.e, { id: 'p', type: 'ping', from: a, to: '10.0.99.1' }, 'pingFails');
    pass(lab.e, { id: 'p', type: 'ping', from: a, to: '10.0.99.1', expect: 'fail' });
    fails(lab.e, { id: 'p', type: 'ping', from: 'Ghost', to: b }, 'noDevice');
  });

  it('Pruefung veraendert die laufende Engine nicht', () => {
    const lab = chainLab();
    const before = JSON.stringify(lab.e.state);
    const a = lab.e.getDevice(lab.pc0)?.name as string;
    evaluateChecks(lab.e, [chk({ id: 'p', type: 'ping', from: a, to: '10.0.2.10' })]);
    expect(JSON.stringify(lab.e.state)).toBe(before);
  });

  it('Dienst: HTTP erreichbar, ACL sperrt Port 80', () => {
    const lab = chainLab();
    const a = lab.e.getDevice(lab.pc0)?.name as string;
    lab.e.setService(lab.pc1, { http: { enabled: true } });
    pass(lab.e, { id: 's', type: 'service', from: a, to: '10.0.2.10', protocol: 'http' });
    const r2 = lab.e.getDevice(lab.r2 as string);
    if (r2?.config.kind !== 'router') throw new Error('r2');
    r2.config.acls['101'] = {
      name: '101',
      type: 'extended',
      entries: [
        aclEntry({
          seq: 10,
          action: 'deny',
          proto: 'tcp',
          src: ANY,
          dst: hostMatch('10.0.2.10'),
          dstPort: eq(80),
        }),
        aclEntry({ seq: 20, action: 'permit', proto: 'ip', src: ANY, dst: ANY }),
      ],
    };
    const p = r2.config.ifaces['p1'];
    if (p) p.aclIn = '101';
    fails(
      lab.e,
      { id: 's', type: 'service', from: a, to: '10.0.2.10', protocol: 'http' },
      'serviceFails',
    );
    pass(lab.e, {
      id: 's',
      type: 'service',
      from: a,
      to: '10.0.2.10',
      protocol: 'http',
      expect: 'fail',
    });
    // Ping bleibt erlaubt
    pass(lab.e, { id: 'p', type: 'ping', from: a, to: '10.0.2.10' });
  });

  it('DHCP-Lease, NAT-Eintraege, OSPF-Nachbarn (negativ)', () => {
    const lab = routerLab();
    const a = lab.e.getDevice(lab.pc0)?.name as string;
    fails(lab.e, { id: 'd', type: 'dhcpLease', device: a }, 'dhcpLease');
    fails(lab.e, { id: 'd', type: 'dhcpLease', device: lab.r1 }, 'notHost');
    fails(lab.e, { id: 'n', type: 'natTranslations', device: lab.r1 }, 'natTranslations');
    fails(lab.e, { id: 'o', type: 'ospfNeighbors', device: lab.r1 }, 'ospfNeighbors');
    fails(lab.e, { id: 'o', type: 'ospfNeighbors', device: a }, 'notL3');
    fails(lab.e, { id: 'n', type: 'natTranslations', device: a }, 'notL3');
  });

  it('Gewichtung, Prozent und Determinismus', () => {
    const lab = chainLab();
    const a = lab.e.getDevice(lab.pc0)?.name as string;
    const checks = [
      chk({ id: '1', type: 'deviceExists', device: a, weight: 3 }),
      chk({ id: '2', type: 'ping', from: a, to: '10.0.2.10', weight: 1 }),
      chk({ id: '3', type: 'deviceExists', device: 'Ghost', weight: 4 }),
    ];
    const r1 = evaluateChecks(lab.e, checks);
    const r2 = evaluateChecks(cloneEngine(lab.e), checks);
    expect(r1).toEqual(r2);
    expect(r1.total).toBe(8);
    expect(r1.earned).toBe(4);
    expect(r1.percent).toBe(50);
    expect(r1.passedCount).toBe(2);
    expect(evaluateChecks(lab.e, []).percent).toBe(0);
    expect(needsSettle(checks)).toBe(true);
    expect(needsSettle([checks[0] as Check])).toBe(false);
  });

  it('Schema lehnt fehlerhafte Pruefungen ab', () => {
    expect(() =>
      CheckSchema.parse({ id: 'x', type: 'hostIp', device: 'a', ip: 'kaputt' }),
    ).toThrow();
    expect(() => CheckSchema.parse({ id: 'x', type: 'unbekannt' })).toThrow();
    expect(() =>
      CheckSchema.parse({ id: 'x', type: 'config', device: 'a', spec: { item: 'nope' } }),
    ).toThrow();
    expect(CheckSchema.parse({ id: 'x', type: 'ping', from: 'a', to: 'b' })).toMatchObject({
      weight: 1,
      expect: 'success',
    });
  });
});
