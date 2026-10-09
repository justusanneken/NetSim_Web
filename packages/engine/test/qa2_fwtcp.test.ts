import { describe, expect, it } from 'vitest';
import { Engine, type Result, type RouterConfig } from '../src';
import { fwApplyNat } from '../src/p5/fw';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const rcfg = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;
const run = (e: Engine, s = 5): void => void e.runUntil(e.state.now + s * 1_000_000);

/** inside (100) 10.0.0.0/24 – FW – outside (0) 203.0.113.0/24, dmz (50) 192.168.10.0/24; FTP-Server außen und in der DMZ. */
function lab() {
  const e = new Engine({ seed: 5 });
  const fw = e.addDevice('firewall', { name: 'FW1' });
  const inn = e.addDevice('pc', { name: 'Inside' });
  const out = e.addDevice('server', { name: 'Outside' });
  const dmz = e.addDevice('server', { name: 'Ftp' });
  must(e.connect({ deviceId: inn, portId: 'p0' }, { deviceId: fw, portId: 'p0' }, 'straight'));
  const outLink = must(
    e.connect({ deviceId: out, portId: 'p0' }, { deviceId: fw, portId: 'p1' }, 'straight'),
  );
  must(e.connect({ deviceId: dmz, portId: 'p0' }, { deviceId: fw, portId: 'p2' }, 'straight'));
  const cfg = rcfg(e, fw);
  const fwc = cfg.fw as NonNullable<typeof cfg.fw>;
  const names: [string, string, number, string][] = [
    ['p0', 'inside', 100, '10.0.0.1'],
    ['p1', 'outside', 0, '203.0.113.1'],
    ['p2', 'dmz', 50, '192.168.10.1'],
  ];
  for (const [p, nameif, level, ip] of names) {
    must(e.setInterfaceIp(fw, p, ip, '255.255.255.0'));
    e.setPortAdmin(fw, p, true);
    fwc.ifaces[p] = { nameif, level };
  }
  must(e.setHostIp(inn, '10.0.0.10', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(out, '203.0.113.10', '255.255.255.0', '203.0.113.1'));
  must(e.setHostIp(dmz, '192.168.10.10', '255.255.255.0', '192.168.10.1'));
  fwc.objects.LAN = {
    name: 'LAN',
    net: { ip: '10.0.0.0', mask: '255.255.255.0' },
    nat: { from: 'inside', to: 'outside', kind: 'dynamic-interface' },
  };
  fwc.objects.FTP = {
    name: 'FTP',
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
        dstPort: { op: 'eq', a: 21 },
        matches: 0,
      },
    ],
  };
  fwc.accessGroups.p1 = 'OUT';
  const ftp = { enabled: true, users: [{ user: 'u', pass: 'p' }], files: { 'a.txt': 'hello' } };
  must(e.p5.setServices(out, { ftp }));
  must(e.p5.setServices(dmz, { ftp }));
  run(e, 1);
  return { e, fw, inn, out, dmz, cfg, outLink: outLink.id };
}

function ftpLogin(e: Engine, from: string, dst: string): { key: string; op?: string } {
  const key = must(e.p5.open(from, dst, 'ftp'));
  run(e, 3);
  e.p5.send(from, key, 'user', { user: 'u', pass: 'p' });
  run(e, 3);
  return { key, op: e.p5.connState(from, key)?.reply?.op };
}

describe('QA2: zuverlässiges TCP durch Firewall mit Objekt-NAT', () => {
  it('inside → outside per PAT: Handshake, Anmeldung und Abbau laufen durch', () => {
    const { e, inn, cfg } = lab();
    const { key, op } = ftpLogin(e, inn, '203.0.113.10');
    expect(op).toBe('login-ok');
    const xl = cfg.nat.table.find((x) => x.proto === 'tcp');
    expect(xl?.insideGlobal.ip).toBe('203.0.113.1');
    expect(cfg.fw?.conns.some((c) => c.proto === 'tcp' && c.dport === 21)).toBe(true);
    e.p5.send(inn, key, 'get', { file: 'a.txt' });
    run(e, 3);
    expect(e.p5.connState(inn, key)?.reply?.body).toBe('hello');
    // keine Firewall-Verwerfungen auf dem Weg
    expect(e.log.some((l) => l.proto === 'FW' && l.status === 'drop')).toBe(false);
  });

  it('outside → DMZ über statisches NAT und ACL; ohne ACL-Eintrag abgewiesen', () => {
    const { e, out, cfg } = lab();
    expect(ftpLogin(e, out, '203.0.113.50').op).toBe('login-ok');
    cfg.acls.OUT = { name: 'OUT', type: 'extended', entries: [] };
    const c2 = must(e.p5.open(out, '203.0.113.50', 'ftp'));
    run(e, 10);
    expect(e.p5.connState(out, c2)?.state).not.toBe('open');
  });

  it('kurzer Linkausfall: Retransmission über Firewall und NAT, Sitzung bleibt bestehen', () => {
    const { e, fw, inn, out, outLink } = lab();
    const { key, op } = ftpLogin(e, inn, '203.0.113.10');
    expect(op).toBe('login-ok');
    e.disconnect(outLink);
    e.p5.send(inn, key, 'get', { file: 'a.txt' });
    run(e, 2);
    must(e.connect({ deviceId: out, portId: 'p0' }, { deviceId: fw, portId: 'p1' }, 'straight'));
    run(e, 10);
    const c = e.p5.connState(inn, key);
    expect(c?.state).toBe('open');
    expect(c?.reply?.body).toBe('hello');
    expect(e.log.some((l) => l.msg.key === 'tcp.retransmit')).toBe(true);
  });
});
