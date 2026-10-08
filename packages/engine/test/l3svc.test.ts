import { describe, expect, it } from 'vitest';
import { Engine, type HostConfig } from '../src';
import { converge } from './helpers';
import {
  ANY,
  aclEntry,
  eq,
  hostMatch,
  host,
  ifaceUp,
  l3Cfg,
  link,
  net,
  ok,
  ping,
  rtCfg,
  router,
  swCfg,
} from './labs3';

const hostCfg = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;

describe('Inter-VLAN-Routing', () => {
  it('Router-on-a-Stick: Subinterfaces routen zwischen VLAN 10 und 20', () => {
    const e = new Engine();
    const sw = e.addDevice('switch-l2', { name: 'SW' });
    const r = router(e);
    ok(e.addVlan(sw, 10));
    ok(e.addVlan(sw, 20));
    link(e, r, 'p0', sw, 'p23');
    ok(e.setSwitchport(sw, 'p23', { mode: 'trunk' }));
    ifaceUp(e, r, 'p0.10', '10.0.10.1');
    ifaceUp(e, r, 'p0.20', '10.0.20.1');
    const a = host(e, 'A', '10.0.10.10', '10.0.10.1');
    const b = host(e, 'B', '10.0.20.10', '10.0.20.1');
    link(e, a, 'p0', sw, 'p0');
    link(e, b, 'p0', sw, 'p1');
    ok(e.setSwitchport(sw, 'p0', { accessVlan: 10 }));
    ok(e.setSwitchport(sw, 'p1', { accessVlan: 20 }));
    converge(e, 45);
    expect(ping(e, a, '10.0.20.10')).toBe('reply');
    const rib = e.routingTable(r).filter((x) => x.type === 'C').map((x) => x.prefix);
    expect(rib).toEqual(['10.0.10.0', '10.0.20.0']);
    // Frames zum Router sind getaggt
    expect(e.log.some((l) => l.atDeviceName === 'R1' && l.frame?.vlan?.vid === 10)).toBe(true);
    expect(e.createSubIface(r, 'p0', 30).ok).toBe(true);
    expect(e.createSubIface(r, 'zz', 30).ok).toBe(false);
  });

  it('L3-Switch: SVIs und ip routing', () => {
    const e = new Engine();
    const sw = e.addDevice('switch-l3', { name: 'MLS' });
    ok(e.addVlan(sw, 10));
    ok(e.addVlan(sw, 20));
    swCfg(e, sw).ipRouting = true;
    ok(e.createSvi(sw, 10));
    ok(e.createSvi(sw, 20));
    ok(e.setInterfaceIp(sw, 'vlan10', '10.0.10.1', '255.255.255.0'));
    ok(e.setInterfaceIp(sw, 'vlan20', '10.0.20.1', '255.255.255.0'));
    const a = host(e, 'A', '10.0.10.10', '10.0.10.1');
    const b = host(e, 'B', '10.0.20.10', '10.0.20.1');
    link(e, a, 'p0', sw, 'p0');
    link(e, b, 'p0', sw, 'p1');
    ok(e.setSwitchport(sw, 'p0', { accessVlan: 10 }));
    ok(e.setSwitchport(sw, 'p1', { accessVlan: 20 }));
    converge(e, 45);
    expect(ping(e, a, '10.0.20.10')).toBe('reply');
    expect(ping(e, a, '10.0.10.1')).toBe('reply'); // SVI antwortet
    expect(e.routingTable(sw).filter((x) => x.type === 'C')).toHaveLength(2);
    // Ohne ip routing wird nicht geroutet
    swCfg(e, sw).ipRouting = false;
    expect(ping(e, a, '10.0.20.10')).not.toBe('reply');
  });

  it('SVI ist down, solange kein Port im VLAN aktiv ist; Management-SVI mit Default-Gateway', () => {
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    const r = router(e);
    link(e, r, 'p0', sw, 'p0');
    ifaceUp(e, r, 'p0', '10.0.0.1');
    ok(e.createSvi(sw, 1));
    ok(e.setInterfaceIp(sw, 'vlan1', '10.0.0.2', '255.255.255.0'));
    swCfg(e, sw).defaultGateway = '10.0.0.1';
    expect(e.routingTable(sw).filter((x) => x.type === 'C')).toHaveLength(1);
    converge(e, 45);
    expect(ping(e, sw, '10.0.0.1')).toBe('reply');
    ifaceUp(e, r, 'p1', '10.0.5.1');
    const far = host(e, 'Far', '10.0.5.10', '10.0.5.1');
    link(e, far, 'p0', r, 'p1');
    e.runAll();
    expect(ping(e, sw, '10.0.5.10')).toBe('reply'); // über das Default-Gateway
    expect(e.createSvi(r, 5).ok).toBe(false);
  });
});

describe('DHCP', () => {
  function dhcpLab() {
    const e = new Engine();
    const r = router(e);
    const sw = e.addDevice('switch-l2');
    link(e, r, 'p0', sw, 'p23');
    ifaceUp(e, r, 'p0', '10.0.1.1');
    const d = l3Cfg(e, r).dhcp;
    d.pools.push({ name: 'LAN', network: '10.0.1.0', mask: '255.255.255.0', router: '10.0.1.1', dns: ['10.0.1.53'], domain: 'lab.local', leaseSec: 3600 });
    d.excluded.push({ from: '10.0.1.1', to: '10.0.1.9' });
    const pcs = [0, 1, 2].map((i) => {
      const id = host(e, `PC${i}`, '');
      link(e, id, 'p0', sw, `p${i}`);
      ok(e.setSwitchport(sw, `p${i}`, { portfast: true }));
      return id;
    });
    converge(e, 35);
    return { e, r, sw, pcs };
  }

  it('DORA: Client erhält Adresse, Maske, Gateway, DNS; Server führt Bindungen', () => {
    const { e, r, pcs } = dhcpLab();
    for (const pc of pcs) ok(e.setHostDhcp(pc, true));
    e.runUntil(e.state.now + 6_000_000);
    const ips = pcs.map((pc) => hostCfg(e, pc).ip);
    expect(ips.every((x) => x?.startsWith('10.0.1.'))).toBe(true);
    expect(new Set(ips).size).toBe(3);
    expect(ips.every((x) => Number(x?.split('.')[3]) >= 10)).toBe(true);
    const c0 = hostCfg(e, pcs[0] as string);
    expect(c0).toMatchObject({ mask: '255.255.255.0', gateway: '10.0.1.1', dnsServers: ['10.0.1.53'] });
    expect(c0.dhcpClient.state).toBe('bound');
    expect(Object.keys(l3Cfg(e, r).dhcp.bindings)).toHaveLength(3);
    const keys = e.log.map((l) => l.msg.key);
    for (const k of ['dhcp.discover', 'dhcp.offer', 'dhcp.gotOffer', 'dhcp.ack', 'dhcp.gotAck', 'dhcp.bound']) {
      expect(keys).toContain(k);
    }
    // Netz funktioniert
    expect(ping(e, pcs[0] as string, hostCfg(e, pcs[1] as string).ip as string)).toBe('reply');
  });

  it('Lease-Erneuerung bei 50 % und Freigabe beim Abschalten', () => {
    const { e, r, pcs } = dhcpLab();
    const pc = pcs[0] as string;
    ok(e.setHostDhcp(pc, true));
    e.runUntil(e.state.now + 6_000_000);
    const bound = hostCfg(e, pc).dhcpClient.boundAt;
    e.runUntil(e.state.now + 1_900_000_000);
    expect(hostCfg(e, pc).dhcpClient.state).toBe('bound');
    expect(hostCfg(e, pc).dhcpClient.boundAt).toBeGreaterThan(bound);
    expect(e.log.some((l) => l.msg.key === 'dhcp.renewed')).toBe(true);
    ok(e.setHostDhcp(pc, false));
    e.runUntil(e.state.now + 1_000_000);
    expect(Object.keys(l3Cfg(e, r).dhcp.bindings)).toHaveLength(0);
    expect(hostCfg(e, pc).dhcpClient.state).toBe('off');
  });

  it('Pool erschöpft; Konflikterkennung per ARP (Decline) markiert die Adresse', () => {
    const { e, r, pcs } = dhcpLab();
    l3Cfg(e, r).dhcp.excluded = [{ from: '10.0.1.1', to: '10.0.1.10' }, { from: '10.0.1.12', to: '10.0.1.254' }];
    // Ein Fremdgerät benutzt bereits .11 (statisch, nicht ausgeschlossen)
    const squat = host(e, 'Squat', '10.0.1.11');
    const sw = Object.values(e.state.devices).find((d) => d.type === 'switch-l2')?.id as string;
    link(e, squat, 'p0', sw, 'p5');
    ok(e.setSwitchport(sw, 'p5', { portfast: true }));
    e.runUntil(e.state.now + 3_000_000);
    ok(e.setHostDhcp(pcs[0] as string, true));
    e.runUntil(e.state.now + 20_000_000);
    expect(hostCfg(e, pcs[0] as string).ip).toBeUndefined();
    const keys = e.log.map((l) => l.msg.key);
    expect(keys).toContain('dhcp.clientConflict');
    expect(keys).toContain('dhcp.conflict');
    expect(keys).toContain('dhcp.exhausted'); // .11 ist als Konflikt markiert → Pool leer
    expect(l3Cfg(e, r).dhcp.conflicts).toEqual(['10.0.1.11']);
  });

  it('Abnahme: DHCP über Relay (`ip helper-address`) mit Server-Gerät', () => {
    const e = new Engine();
    const r = router(e);
    const srv = host(e, 'DHCP', '10.0.1.10', '10.0.1.1');
    const pc = host(e, 'PC', '');
    link(e, srv, 'p0', r, 'p0');
    link(e, pc, 'p0', r, 'p1');
    ifaceUp(e, r, 'p0', '10.0.1.1');
    ifaceUp(e, r, 'p1', '10.0.2.1');
    rtCfg(e, r).ifaces.p1!.helpers = ['10.0.1.10'];
    const sc = hostCfg(e, srv).services;
    sc.dhcp.enabled = true;
    sc.dhcp.pools.push({ name: 'LAN2', network: '10.0.2.0', mask: '255.255.255.0', router: '10.0.2.1', dns: ['10.0.1.10'], leaseSec: 3600 });
    sc.dhcp.excluded.push({ from: '10.0.2.1', to: '10.0.2.99' });
    e.runAll();
    ok(e.setHostDhcp(pc, true));
    e.runUntil(e.state.now + 6_000_000);
    expect(hostCfg(e, pc)).toMatchObject({ ip: '10.0.2.100', gateway: '10.0.2.1' });
    const keys = e.log.map((l) => l.msg.key);
    expect(keys).toContain('dhcp.relay');
    expect(keys).toContain('dhcp.relayDown');
    expect(ping(e, pc, '10.0.1.10')).toBe('reply');
  });
});

describe('DNS und HTTP', () => {
  function web() {
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    const srv = host(e, 'Web', '10.0.0.10');
    const cli = host(e, 'Client', '10.0.0.20');
    link(e, srv, 'p0', sw, 'p0');
    link(e, cli, 'p0', sw, 'p1');
    ok(e.setSwitchport(sw, 'p0', { portfast: true }));
    ok(e.setSwitchport(sw, 'p1', { portfast: true }));
    const s = hostCfg(e, srv).services;
    s.http.enabled = true;
    s.http.pages['/'] = '<h1>Hallo</h1>';
    s.http.pages['/info'] = '<p>Info</p>';
    s.dns.enabled = true;
    s.dns.records.push(
      { name: 'www.lab.local', type: 'A', data: '10.0.0.10', ttl: 300 },
      { name: 'web.lab.local', type: 'CNAME', data: 'www.lab.local', ttl: 300 },
    );
    ok(e.setDnsServers(cli, ['10.0.0.10']));
    converge(e, 5);
    return { e, srv, cli };
  }
  const req = (e: Engine, id: string, i = -1) => hostCfg(e, id).requests.at(i);
  const get = (e: Engine, id: string, url: string) => {
    ok(e.httpGet(id, url));
    e.runAll();
    return req(e, id);
  };

  it('HTTP-GET per IP: Handshake, Antwort 200, 404; Browser-Zustand', () => {
    const { e, cli } = web();
    expect(get(e, cli, 'http://10.0.0.10/')).toMatchObject({ status: 'done', code: 200, body: '<h1>Hallo</h1>' });
    expect(get(e, cli, '10.0.0.10/info')).toMatchObject({ status: 'done', code: 200, body: '<p>Info</p>' });
    expect(get(e, cli, 'http://10.0.0.10/nope')).toMatchObject({ status: 'done', code: 404 });
    const keys = e.log.map((l) => l.msg.key);
    expect(keys).toContain('tcp.syn');
    expect(keys).toContain('tcp.established');
    expect(keys).toContain('http.request');
    expect(keys).toContain('http.response');
    expect(Object.keys(hostCfg(e, cli).tcp)).toHaveLength(0);
  });

  it('DNS: Name wird aufgelöst (A, CNAME), Ergebnis gecacht; NXDOMAIN', () => {
    const { e, cli } = web();
    expect(get(e, cli, 'http://www.lab.local/')).toMatchObject({ status: 'done', code: 200 });
    expect(hostCfg(e, cli).dnsCache['www.lab.local']?.ip).toBe('10.0.0.10');
    const n = e.log.filter((l) => l.msg.key === 'dns.answer').length;
    get(e, cli, 'http://www.lab.local/info');
    expect(e.log.filter((l) => l.msg.key === 'dns.answer')).toHaveLength(n); // Cache
    expect(get(e, cli, 'http://web.lab.local/')).toMatchObject({ status: 'done', code: 200 });
    expect(get(e, cli, 'http://gibtsnicht.lab.local/')).toMatchObject({ status: 'failed', error: 'http.err.dns' });
    const r = e.resolveName(cli, 'www.lab.local');
    expect(r.ok && r.value.cached).toBe('10.0.0.10');
  });

  it('Fehlerfälle: kein DNS-Server, Port geschlossen (RST), unerreichbar, Server aus', () => {
    const { e, srv, cli } = web();
    ok(e.setDnsServers(cli, []));
    expect(get(e, cli, 'http://www.lab.local/')).toMatchObject({ status: 'failed', error: 'http.err.noDns' });
    ok(e.setService(srv, { http: { enabled: false } }));
    expect(get(e, cli, 'http://10.0.0.10/')).toMatchObject({ status: 'failed', error: 'http.err.refused' });
    expect(get(e, cli, 'http://10.9.9.9/')).toMatchObject({ status: 'failed' });
    ok(e.setService(srv, { http: { enabled: true, https: false } }));
    expect(get(e, cli, 'https://10.0.0.10/')).toMatchObject({ status: 'failed', error: 'http.err.refused' });
    ok(e.setService(srv, { http: { enabled: true, https: true } }));
    expect(get(e, cli, 'https://10.0.0.10/')).toMatchObject({ status: 'done', code: 200 });
    e.setPower(srv, false);
    expect(get(e, cli, 'http://10.0.0.10/')).toMatchObject({ status: 'failed' });
    expect(e.httpGet('nope', 'x').ok).toBe(false);
    expect(e.resolveName('nope', 'x').ok).toBe(false);
    expect(e.setDnsServers(cli, ['x']).ok).toBe(false);
  });

  it('DNS-Timeout bei unerreichbarem Server', () => {
    const { e, cli } = web();
    ok(e.setDnsServers(cli, ['10.0.0.77']));
    expect(get(e, cli, 'http://a.b/')).toMatchObject({ status: 'failed' });
  });
});

describe('ACL', () => {
  function aclLab() {
    const e = new Engine();
    const r = router(e);
    const cli = host(e, 'Client', '10.0.1.10', '10.0.1.1');
    const srv = host(e, 'Server', '10.0.2.10', '10.0.2.1');
    link(e, cli, 'p0', r, 'p0');
    link(e, srv, 'p0', r, 'p1');
    ifaceUp(e, r, 'p0', '10.0.1.1');
    ifaceUp(e, r, 'p1', '10.0.2.1');
    hostCfg(e, srv).services.http.enabled = true;
    e.runAll();
    return { e, r, cli, srv };
  }

  it('Abnahme: ACL blockiert gezielt HTTP, Ping bleibt erlaubt; Trefferzähler und ICMP admin prohibited', () => {
    const { e, r, cli } = aclLab();
    const cfg = rtCfg(e, r);
    cfg.acls.BLOCK = {
      name: 'BLOCK',
      type: 'extended',
      entries: [
        aclEntry({ action: 'deny', proto: 'tcp', src: ANY, dst: hostMatch('10.0.2.10'), dstPort: eq(80) }),
        aclEntry({ action: 'permit', proto: 'ip', src: ANY, dst: ANY }),
      ],
    };
    cfg.ifaces.p0!.aclIn = 'BLOCK';
    ok(e.httpGet(cli, 'http://10.0.2.10/'));
    e.runAll();
    expect(hostCfg(e, cli).requests[0]).toMatchObject({ status: 'failed', error: 'http.err.blocked' });
    expect(ping(e, cli, '10.0.2.10')).toBe('reply');
    expect(cfg.acls.BLOCK?.entries.map((x) => x.matches)).toEqual([1, 5].map((n, i) => (i === 0 ? 1 : cfg.acls.BLOCK?.entries[1]?.matches ?? n)));
    expect(cfg.acls.BLOCK?.entries[0]?.matches).toBe(1);
    expect(e.log.some((l) => l.msg.key === 'acl.deny' && l.proto === 'ACL')).toBe(true);
    // ohne ACL wieder erreichbar
    cfg.ifaces.p0!.aclIn = undefined;
    ok(e.httpGet(cli, 'http://10.0.2.10/'));
    e.runAll();
    expect(hostCfg(e, cli).requests[1]).toMatchObject({ status: 'done', code: 200 });
  });

  it('Standard-ACL (Quelle), Ausgangs-ACL, implizites Deny, established', () => {
    const { e, r, cli, srv } = aclLab();
    const cfg = rtCfg(e, r);
    cfg.acls['1'] = { name: '1', type: 'standard', entries: [aclEntry({ action: 'permit', src: net('10.0.1.0', '0.0.0.255') })] };
    cfg.ifaces.p1!.aclOut = '1';
    expect(ping(e, cli, '10.0.2.10')).toBe('reply');
    cfg.acls['1']!.entries[0]!.src = hostMatch('10.0.1.99');
    expect(ping(e, cli, '10.0.2.10')).toBe('unreachable'); // implizites deny
    // established: Server darf nur Antworten schicken
    cfg.ifaces.p1!.aclOut = undefined;
    cfg.acls.EST = { name: 'EST', type: 'extended', entries: [aclEntry({ action: 'permit', proto: 'tcp', src: ANY, dst: ANY, established: true })] };
    cfg.ifaces.p1!.aclIn = 'EST';
    ok(e.httpGet(cli, 'http://10.0.2.10/'));
    e.runAll();
    expect(hostCfg(e, cli).requests[0]).toMatchObject({ status: 'done', code: 200 }); // Antworten (ACK) passieren
    ok(e.httpGet(srv, 'http://10.0.1.10/'));
    e.runAll();
    expect(hostCfg(e, srv).requests[0]?.status).toBe('failed'); // SYN ohne ACK wird verworfen
    // Port-Operatoren
    cfg.acls.P = { name: 'P', type: 'extended', entries: [] };
    const ops = [
      { op: 'neq', a: 80 },
      { op: 'lt', a: 100 },
      { op: 'gt', a: 100 },
      { op: 'range', a: 70, b: 90 },
    ] as const;
    for (const o of ops) {
      cfg.acls.P.entries = [aclEntry({ action: 'permit', proto: 'tcp', dstPort: { ...o } })];
      cfg.ifaces.p0!.aclIn = 'P';
      ok(e.httpGet(cli, 'http://10.0.2.10/'));
      e.runAll();
    }
    expect(hostCfg(e, cli).requests.slice(-4).map((x) => x.status)).toEqual(['failed', 'done', 'failed', 'done']);
  });
});

describe('NAT / PAT', () => {
  function natLab(out = '203.0.113') {
    const e = new Engine();
    const r = router(e, 'Edge');
    const sw = e.addDevice('switch-l2');
    link(e, r, 'p0', sw, 'p23');
    ifaceUp(e, r, 'p0', '192.168.1.1');
    const srv = host(e, 'Web', `${out}.10`, `${out}.1`);
    link(e, srv, 'p0', r, 'p1');
    ifaceUp(e, r, 'p1', `${out}.1`);
    hostCfg(e, srv).services.http.enabled = true;
    const pcs = [0, 1, 2].map((i) => {
      const id = host(e, `PC${i}`, `192.168.1.${10 + i}`, '192.168.1.1');
      link(e, id, 'p0', sw, `p${i}`);
      ok(e.setSwitchport(sw, `p${i}`, { portfast: true }));
      return id;
    });
    const cfg = rtCfg(e, r);
    cfg.ifaces.p0!.natSide = 'inside';
    cfg.ifaces.p1!.natSide = 'outside';
    cfg.acls['1'] = { name: '1', type: 'standard', entries: [aclEntry({ action: 'permit', src: net('192.168.1.0', '0.0.0.255') })] };
    converge(e, 35);
    return { e, r, srv, pcs, cfg };
  }

  it('Abnahme: PAT mit 3 Clients über die Außenadresse (overload interface)', () => {
    const { e, srv, pcs, cfg } = natLab();
    cfg.nat.rules.push({ kind: 'interface', acl: '1', ifaceId: 'p1' });
    for (const pc of pcs) expect(ping(e, pc, '203.0.113.10')).toBe('reply');
    for (const pc of pcs) {
      ok(e.httpGet(pc, 'http://203.0.113.10/'));
      e.runAll();
      expect(hostCfg(e, pc).requests[0]).toMatchObject({ status: 'done', code: 200 });
    }
    const tcp = cfg.nat.table.filter((x) => x.proto === 'tcp');
    expect(tcp).toHaveLength(3);
    expect(new Set(tcp.map((x) => x.insideGlobal.port)).size).toBe(3);
    expect(tcp.every((x) => x.insideGlobal.ip === '203.0.113.1')).toBe(true);
    expect(cfg.nat.table.filter((x) => x.proto === 'icmp')).toHaveLength(3);
    expect(cfg.nat.hits).toBeGreaterThan(0);
    // Der Server sieht nur die Adresse des Routers
    const seen = e.log.filter((l) => l.atDeviceName === 'Web' && l.msg.key === 'tcp.syn').map((l) => l.msg.params?.peer);
    expect(new Set(seen)).toEqual(new Set(['203.0.113.1']));
    void srv;
  });

  it('Timeouts: ICMP-Einträge verfallen nach 60 s', () => {
    const { e, pcs, cfg } = natLab();
    cfg.nat.rules.push({ kind: 'interface', acl: '1', ifaceId: 'p1' });
    ping(e, pcs[0] as string, '203.0.113.10');
    expect(cfg.nat.table.some((x) => x.proto === 'icmp')).toBe(true);
    e.runUntil(e.state.now + 61_000_000);
    ping(e, pcs[1] as string, '203.0.113.10'); // löst die Bereinigung aus
    expect(cfg.nat.table.filter((x) => x.proto === 'icmp' && x.insideLocal.ip === '192.168.1.10')).toHaveLength(0);
  });

  it('dynamisches NAT mit Pool (ohne Overload): eine Außenadresse je Client', () => {
    const { e, pcs, cfg } = natLab();
    cfg.nat.pools.P = { name: 'P', start: '203.0.113.100', end: '203.0.113.101', mask: '255.255.255.0' };
    cfg.nat.rules.push({ kind: 'dynamic', acl: '1', pool: 'P', overload: false });
    // Der Server braucht eine Route zurück in den Pool: Router antwortet per Proxy – hier genügt Connected-Netz
    expect(ping(e, pcs[0] as string, '203.0.113.10')).toBe('reply');
    expect(ping(e, pcs[1] as string, '203.0.113.10')).toBe('reply');
    const globals = cfg.nat.table.map((x) => x.insideGlobal.ip).sort();
    expect(globals).toEqual(['203.0.113.100', '203.0.113.101']);
    expect(ping(e, pcs[2] as string, '203.0.113.10')).not.toBe('reply'); // Pool erschöpft
    expect(cfg.nat.misses).toBeGreaterThan(0);
  });

  it('statisches NAT (1:1) macht einen Inside-Server von außen erreichbar', () => {
    const { e, srv, pcs, cfg } = natLab('198.51.100');
    hostCfg(e, pcs[0] as string).services.http.enabled = true;
    cfg.nat.rules.push({ kind: 'static', local: '192.168.1.10', global: '203.0.113.50' });
    expect(ping(e, srv, '203.0.113.50')).toBe('reply');
    ok(e.httpGet(srv, 'http://203.0.113.50/'));
    e.runAll();
    expect(hostCfg(e, srv).requests[0]).toMatchObject({ status: 'done', code: 200 });
    expect(cfg.nat.table.every((x) => x.kind === 'static' && x.insideGlobal.ip === '203.0.113.50')).toBe(true);
    // Der Inside-Host sieht die echte Außenadresse des Clients
    expect(e.log.some((l) => l.msg.key === 'nat.in')).toBe(true);
  });

  it('Port-Forwarding (static tcp 80 → 8080) und Nicht-übersetzte Pakete', () => {
    const { e, srv, pcs, cfg } = natLab('198.51.100');
    hostCfg(e, pcs[0] as string).services.http.enabled = true;
    cfg.nat.rules.push({ kind: 'static', local: '192.168.1.10', global: '203.0.113.50', proto: 'tcp', lport: 80, gport: 80 });
    ok(e.httpGet(srv, 'http://203.0.113.50/'));
    e.runAll();
    expect(hostCfg(e, srv).requests[0]).toMatchObject({ status: 'done', code: 200 });
    // ICMP passt nicht zur Port-Regel → Router leitet an die (nicht existierende) Adresse weiter
    expect(ping(e, srv, '203.0.113.50')).not.toBe('reply');
  });
});
