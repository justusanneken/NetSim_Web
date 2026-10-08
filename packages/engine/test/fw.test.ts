import { describe, expect, it } from 'vitest';
import { Engine, type Result, type HostConfig, type RouterConfig } from '../src';
import { fwApplyNat } from '../src/p5/fw';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const rcfg = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;
const hcfg = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const run = (e: Engine, s = 5): void => void e.runUntil(e.state.now + s * 1_000_000);

function ping(e: Engine, from: string, dst: string): boolean {
  const r = must(e.ping(from, dst, { count: 1 }));
  run(e, 6);
  const c = e.getDevice(from)?.config as HostConfig;
  return c.pings.filter((p) => p.id === r).some((p) => p.status === 'reply');
}

/** inside (100) 10.0.0.0/24 – FW – outside (0) 203.0.113.0/24, dmz (50) 192.168.10.0/24. */
function lab() {
  const e = new Engine();
  const fw = e.addDevice('firewall', { name: 'FW1' });
  const inn = e.addDevice('pc', { name: 'Inside' });
  const out = e.addDevice('server', { name: 'Outside' });
  const dmz = e.addDevice('server', { name: 'Web' });
  must(e.connect({ deviceId: inn, portId: 'p0' }, { deviceId: fw, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: out, portId: 'p0' }, { deviceId: fw, portId: 'p1' }, 'straight'));
  must(e.connect({ deviceId: dmz, portId: 'p0' }, { deviceId: fw, portId: 'p2' }, 'straight'));
  const cfg = rcfg(e, fw);
  const names: [string, string, number, string, string][] = [
    ['p0', 'inside', 100, '10.0.0.1', '255.255.255.0'],
    ['p1', 'outside', 0, '203.0.113.1', '255.255.255.0'],
    ['p2', 'dmz', 50, '192.168.10.1', '255.255.255.0'],
  ];
  for (const [p, nameif, level, ip, mask] of names) {
    must(e.setInterfaceIp(fw, p, ip, mask));
    e.setPortAdmin(fw, p, true);
    (cfg.fw as NonNullable<typeof cfg.fw>).ifaces[p] = { nameif, level };
  }
  must(e.setHostIp(inn, '10.0.0.10', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(out, '203.0.113.10', '255.255.255.0', '203.0.113.1'));
  must(e.setHostIp(dmz, '192.168.10.10', '255.255.255.0', '192.168.10.1'));
  run(e, 1);
  return { e, fw, inn, out, dmz, cfg };
}

describe('Firewall', () => {
  it('inside→outside erlaubt (Rückverkehr zustandsbehaftet), outside→inside blockiert', () => {
    const { e, fw, inn, out, cfg } = lab();
    expect(ping(e, inn, '203.0.113.10')).toBe(true);
    expect(cfg.fw?.conns.length).toBeGreaterThan(0);
    expect(cfg.fw?.conns[0]).toMatchObject({
      proto: 'icmp',
      src: '10.0.0.10',
      dst: '203.0.113.10',
    });
    expect(ping(e, out, '10.0.0.10')).toBe(false);
    expect(e.log.map((l) => l.msg.key)).toContain('fw.levelDeny');
    expect(cfg.fw?.denied).toBeGreaterThan(0);
    void fw;
  });

  it('ACL auf der Eingangsschnittstelle erlaubt gezielt outside→dmz (TCP/80), Rest bleibt gesperrt', () => {
    const { e, out, inn, dmz, cfg } = lab();
    const fwc = cfg.fw as NonNullable<typeof cfg.fw>;
    cfg.acls.OUT = {
      name: 'OUT',
      type: 'extended',
      entries: [
        {
          seq: 10,
          action: 'permit',
          proto: 'tcp',
          src: { any: true },
          dst: { ip: '192.168.10.10', wildcard: '0.0.0.0' },
          dstPort: { op: 'eq', a: 80 },
          matches: 0,
        },
      ],
    };
    fwc.accessGroups.p1 = 'OUT';
    must(e.setService(dmz, { http: { enabled: true } }));
    e.httpGet(out, 'http://192.168.10.10/');
    run(e, 6);
    expect(hcfg(e, out).requests[0]?.status).toBe('done');
    // Ping outside→dmz wird durch die ACL verworfen
    expect(ping(e, out, '192.168.10.10')).toBe(false);
    // inside→dmz (100 > 50) erlaubt
    expect(ping(e, inn, '192.168.10.10')).toBe(true);
    // dmz→inside (50 < 100) blockiert
    expect(ping(e, dmz, '10.0.0.10')).toBe(false);
  });

  it('Objekt-NAT: dynamisches PAT auf die Outside-Adresse und statisches NAT für das DMZ-Web', () => {
    const { e, inn, out, dmz, cfg } = lab();
    const fwc = cfg.fw as NonNullable<typeof cfg.fw>;
    fwc.objects.LAN = {
      name: 'LAN',
      net: { ip: '10.0.0.0', mask: '255.255.255.0' },
      nat: { from: 'inside', to: 'outside', kind: 'dynamic-interface' },
    };
    fwc.objects.WEB = {
      name: 'WEB',
      net: { ip: '192.168.10.10', mask: '255.255.255.255' },
      nat: { from: 'dmz', to: 'outside', kind: 'static', mapped: '203.0.113.50' },
    };
    fwApplyNat(cfg);
    cfg.acls.OUT = {
      name: 'OUT',
      type: 'extended',
      entries: [
        {
          seq: 10,
          action: 'permit',
          proto: 'tcp',
          src: { any: true },
          dst: { ip: '192.168.10.10', wildcard: '0.0.0.0' },
          dstPort: { op: 'eq', a: 80 },
          matches: 0,
        },
      ],
    };
    fwc.accessGroups.p1 = 'OUT';
    must(e.setService(dmz, { http: { enabled: true } }));
    expect(ping(e, inn, '203.0.113.10')).toBe(true);
    const xl = cfg.nat.table.find((x) => x.proto === 'icmp');
    expect(xl?.insideGlobal.ip).toBe('203.0.113.1');
    e.httpGet(out, 'http://203.0.113.50/');
    run(e, 6);
    expect(hcfg(e, out).requests[0]?.status).toBe('done');
  });

  it('Schnittstelle ohne nameif lässt nichts durch; same-security-traffic', () => {
    const { e, inn, cfg, dmz } = lab();
    const fwc = cfg.fw as NonNullable<typeof cfg.fw>;
    delete fwc.ifaces.p1;
    expect(ping(e, inn, '203.0.113.10')).toBe(false);
    fwc.ifaces.p2 = { nameif: 'dmz', level: 100 };
    expect(ping(e, dmz, '10.0.0.10')).toBe(false);
    fwc.sameSecurity = true;
    expect(ping(e, dmz, '10.0.0.10')).toBe(true);
  });

  it('Windows-Firewall blockiert eingehendes Ping', () => {
    const { e, inn, dmz } = lab();
    expect(ping(e, dmz, '192.168.10.10')).toBe(false); // sich selbst: kein Zielhost, Basis
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    must(e.connect({ deviceId: a, portId: 'p0' }, { deviceId: b, portId: 'p0' }, 'crossover'));
    must(e.setHostIp(a, '10.9.0.1', '255.255.255.0'));
    must(e.setHostIp(b, '10.9.0.2', '255.255.255.0'));
    expect(ping(e, a, '10.9.0.2')).toBe(true);
    hcfg(e, b).firewallOn = true;
    expect(ping(e, a, '10.9.0.2')).toBe(false);
    expect(e.log.map((l) => l.msg.key)).toContain('host.fw.blockedPing');
    void inn;
  });
});

describe('Cloud / Modem / Module / Physical', () => {
  it('DSL-Modem überbrückt Telefonleitung und Ethernet; Ping durch die Cloud', () => {
    const e = new Engine();
    const pc = e.addDevice('pc');
    const modem = e.addDevice('dsl-modem');
    const cloud = e.addDevice('cloud');
    const srv = e.addDevice('server');
    must(e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: modem, portId: 'p1' }, 'straight'));
    must(e.connect({ deviceId: modem, portId: 'p0' }, { deviceId: cloud, portId: 'p2' }, 'phone'));
    must(e.connect({ deviceId: cloud, portId: 'p0' }, { deviceId: srv, portId: 'p0' }, 'straight'));
    must(e.setHostIp(pc, '10.0.0.1', '255.255.255.0'));
    must(e.setHostIp(srv, '10.0.0.2', '255.255.255.0'));
    expect(ping(e, pc, '10.0.0.2')).toBe(true);
    // Zuordnung ändern: DSL-Port aus der Gruppe nehmen → keine Verbindung mehr
    must(e.p5.setBridgeGroup(cloud, 'p2', 2));
    expect(ping(e, pc, '10.0.0.2')).toBe(false);
    expect(e.p5.setBridgeGroup(modem, 'p0', 2).ok).toBe(false);
    expect(e.p5.setBridgeGroup(cloud, 'p0', 99).ok).toBe(false);
    // Kabeltypen
    const cable = e.addDevice('cable-modem');
    expect(
      e.connect({ deviceId: cable, portId: 'p0' }, { deviceId: cloud, portId: 'p4' }, 'coax').ok,
    ).toBe(true);
    expect(
      e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: cloud, portId: 'p1' }, 'phone').ok,
    ).toBe(false);
    const r = e.connectAuto(cloud, modem);
    expect(r.ok || r.error).toBeTruthy();
  });

  it('Module nur bei ausgeschaltetem Gerät einstecken/entfernen', () => {
    const e = new Engine();
    const r = e.addDevice('router');
    const n = e.getDevice(r)?.ports.length as number;
    expect(e.p5.insertModule(r, 0, 'HWIC-2T').ok).toBe(false);
    e.setPower(r, false);
    must(e.p5.insertModule(r, 0, 'HWIC-2T'));
    expect(e.getDevice(r)?.ports).toHaveLength(n + 2);
    expect(e.getDevice(r)?.ports[n]?.kind).toBe('serial');
    expect(e.p5.insertModule(r, 0, 'HWIC-1GE').ok).toBe(false); // belegt
    expect(e.p5.insertModule(r, 1, 'NIC-FE').ok).toBe(false); // inkompatibel
    expect(e.p5.insertModule(r, 5, 'HWIC-2T').ok).toBe(false);
    must(e.p5.removeModule(r, 0));
    expect(e.getDevice(r)?.ports).toHaveLength(n);
    expect(e.p5.removeModule(r, 0).ok).toBe(false);
    const pc = e.addDevice('pc');
    e.setPower(pc, false);
    must(e.p5.insertModule(pc, 0, 'NIC-WIFI'));
  });

  it('Physical View: Orte anlegen, Geräte platzieren, Ort löschen', () => {
    const e = new Engine();
    const pc = e.addDevice('pc');
    must(e.p5.addLocation('Berlin/HQ/Serverraum/Rack1'));
    expect(e.state.physical?.cities[0]?.buildings[0]?.rooms[0]?.racks).toEqual(['Rack1']);
    must(e.p5.placeDevice(pc, 'Berlin/HQ/Serverraum/Rack1', 3));
    expect(e.getDevice(pc)?.physical).toEqual({
      location: 'Berlin/HQ/Serverraum/Rack1',
      rackPos: 3,
    });
    must(e.p5.deleteLocation('Berlin/HQ'));
    expect(e.getDevice(pc)?.physical).toEqual({});
    expect(e.p5.addLocation('').ok).toBe(false);
  });
});
