import { describe, expect, it } from 'vitest';
import { Engine, mgmtOf, type RouterConfig } from '../src';
import { must, pcOn, rlink, sec } from './labs4';

const cfgOf = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;

/**
 * PC1 – CPE (Dialer1) ═ DSL ═ BRAS (Virtual-Template1) – Server (198.51.100.10).
 * `cloud`: zwischen CPE und BRAS liegt eine transparente Cloud/DSL-Bridge.
 */
function lab(opts: { cloud?: boolean; pass?: string; user?: string } = {}) {
  const e = new Engine({ seed: 1 });
  const cpe = e.addDevice('router', { name: 'CPE' });
  const bras = e.addDevice('router', { name: 'BRAS' });
  if (opts.cloud) {
    const cloud = e.addDevice('cloud', { name: 'DSL' });
    const ports = e.getDevice(cloud)?.ports.map((p) => p.id) ?? [];
    must(
      e.connect(
        { deviceId: cpe, portId: 'p0' },
        { deviceId: cloud, portId: ports[0] as string },
        'straight',
      ),
    );
    must(
      e.connect(
        { deviceId: bras, portId: 'p0' },
        { deviceId: cloud, portId: ports[1] as string },
        'straight',
      ),
    );
    e.setPortAdmin(cpe, 'p0', true);
    e.setPortAdmin(bras, 'p0', true);
  } else rlink(e, cpe, 'p0', bras, 'p0');

  // --- BRAS
  const b = cfgOf(e, bras);
  must(e.ensureIface(bras, 'lo0'));
  Object.assign(b.ifaces['lo0'] ?? {}, { ip: '203.0.113.1', mask: '255.255.255.255' });
  must(e.ensureIface(bras, 'vt1'));
  b.ifaces['vt1'] = {
    kind: 'vtemplate',
    vtemplate: { unnumbered: 'lo0', pool: 'POOL', chap: true },
  };
  b.bba = { GRP: { name: 'GRP', template: 1 } };
  b.ipPools = { POOL: { name: 'POOL', start: '203.0.113.100', end: '203.0.113.101' } };
  must(e.ensureIface(bras, 'p0'));
  (b.ifaces['p0'] ??= { kind: 'phys', portId: 'p0' }).pppoeGroup = 'GRP';
  mgmtOf(b.sys).users['cust'] = { secret: 'secret', privilege: 1 };
  must(e.setInterfaceIp(bras, 'p1', '198.51.100.1', '255.255.255.0'));
  e.setPortAdmin(bras, 'p1', true);
  const srv = e.addDevice('server', { name: 'WWW' });
  must(e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: bras, portId: 'p1' }, 'straight'));
  must(e.setHostIp(srv, '198.51.100.10', '255.255.255.0', '198.51.100.1'));
  // Rückroute zum Kundennetz über die zugewiesene Adresse
  must(
    e.addStaticRoute(bras, { prefix: '10.1.0.0', mask: '255.255.255.0', nextHop: '203.0.113.100' }),
  );

  // --- CPE
  const c = cfgOf(e, cpe);
  must(e.ensureIface(cpe, 'p0'));
  (c.ifaces['p0'] ??= { kind: 'phys', portId: 'p0' }).pppoeClientPool = 1;
  must(e.ensureIface(cpe, 'di1'));
  c.ifaces['di1'] = {
    kind: 'dialer',
    dialer: {
      pool: 1,
      chapUser: opts.user ?? 'cust',
      chapPass: opts.pass ?? 'secret',
      negotiated: true,
    },
  };
  c.staticRoutes.push({ prefix: '0.0.0.0', mask: '0.0.0.0', outIfaceId: 'di1', ad: 1 });
  must(e.setInterfaceIp(cpe, 'p1', '10.1.0.1', '255.255.255.0'));
  e.setPortAdmin(cpe, 'p1', true);
  const pc = pcOn(e, cpe, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
  e.routingChanged(cpe);
  e.routingChanged(bras);
  return { e, cpe, bras, srv, pc };
}

const ping = (e: Engine, from: string, dst: string): string | undefined => {
  e.ping(from, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(from)?.config;
  return cfg && (cfg.kind === 'host' || cfg.kind === 'router')
    ? cfg.pings.at(-1)?.status
    : undefined;
};

describe('PPPoE', () => {
  it('Discovery + LCP + CHAP + IPCP: Client erhält Adresse und Default-Route, Ping End-to-End', () => {
    const { e, cpe, bras, pc } = lab();
    sec(e, 10);
    const s = Object.values(cfgOf(e, cpe).ppp?.sessions ?? {})[0];
    expect(s).toMatchObject({
      role: 'client',
      state: 'up',
      localIp: '203.0.113.100',
      peerIp: '203.0.113.1',
      user: 'cust',
    });
    const sv = Object.values(cfgOf(e, bras).ppp?.sessions ?? {})[0];
    expect(sv).toMatchObject({ role: 'server', state: 'up', sessionId: s?.sessionId });
    // Default-Route über den Dialer
    const dflt = e.routingTable(cpe).find((r) => r.prefix === '0.0.0.0');
    expect(dflt?.ifaceId).toBe('di1');
    expect(ping(e, cpe, '198.51.100.10')).toBe('reply');
    expect(ping(e, pc, '198.51.100.10')).toBe('reply');
    // Frames auf der Leitung
    const sum = e.log.map((l) => l.summary ?? '').join('\n');
    for (const code of ['PADI', 'PADO', 'PADR', 'PADS']) expect(sum).toContain(code);
    expect(sum).toContain('LCP conf-req');
    expect(sum).toContain('CHAP challenge');
    expect(sum).toContain('IPCP conf-nak');
    expect(Object.values(cfgOf(e, cpe).ppp?.sessions ?? {})[0]?.outPkts).toBeGreaterThan(0);
    expect(Object.values(cfgOf(e, bras).ppp?.sessions ?? {})[0]?.inPkts).toBeGreaterThan(0);
  });

  it('funktioniert über eine transparente Cloud/DSL-Bridge', () => {
    const { e, cpe } = lab({ cloud: true });
    sec(e, 10);
    expect(Object.values(cfgOf(e, cpe).ppp?.sessions ?? {})[0]?.state).toBe('up');
    expect(ping(e, cpe, '198.51.100.10')).toBe('reply');
  });

  it('falsches CHAP-Passwort: keine Sitzung, keine Adresse, Fehlerprotokoll', () => {
    const { e, cpe, bras } = lab({ pass: 'wrong' });
    sec(e, 15);
    expect(
      Object.values(cfgOf(e, cpe).ppp?.sessions ?? {}).filter((s) => s.state === 'up'),
    ).toHaveLength(0);
    expect(
      Object.values(cfgOf(e, bras).ppp?.sessions ?? {}).filter((s) => s.state === 'up'),
    ).toHaveLength(0);
    expect(e.routingTable(cpe).some((r) => r.prefix === '0.0.0.0')).toBe(false);
    expect(e.log.map((l) => l.msg.key)).toContain('ppp.authFailed');
    expect(cfgOf(e, cpe).ppp?.errors?.['di1']).toBe('authentication failed');
  });

  it('Linkausfall beendet die Sitzung, Rückkehr wählt sich neu ein', () => {
    const { e, cpe } = lab();
    sec(e, 10);
    e.setPortAdmin(cpe, 'p0', false);
    sec(e, 2);
    expect(
      Object.values(cfgOf(e, cpe).ppp?.sessions ?? {}).filter((s) => s.state === 'up'),
    ).toHaveLength(0);
    expect(ping(e, cpe, '198.51.100.10')).not.toBe('reply');
    e.setPortAdmin(cpe, 'p0', true);
    sec(e, 15);
    expect(Object.values(cfgOf(e, cpe).ppp?.sessions ?? {})[0]?.state).toBe('up');
    expect(ping(e, cpe, '198.51.100.10')).toBe('reply');
  });

  it('Adresse stammt aus dem lokalen Pool des BRAS', () => {
    const { e, bras } = lab();
    sec(e, 10);
    // zweiter Client am selben BRAS-Port über einen Hub
    const b = cfgOf(e, bras);
    expect(Object.values(b.ppp?.sessions ?? {}).map((s) => s.peerIp)).toEqual(['203.0.113.100']);
  });

  it('Verlauf ist deterministisch', () => {
    const go = () => {
      const { e } = lab();
      sec(e, 10);
      return JSON.stringify(e.log.map((l) => [l.t, l.msg.key, l.summary]));
    };
    expect(go()).toBe(go());
  });
});
