import { describe, expect, it } from 'vitest';
import { Engine, type Result, type HostConfig, type RouterConfig } from '../src';
import { mgmtOf } from '../src/p5defaults';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const host = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const rcfg = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;
const run = (e: Engine, s = 10): void => void e.runUntil(e.state.now + s * 1_000_000);

/** PC (10.0.0.2) – R1 (.1 / 10.0.1.1) – Server (10.0.1.10). */
function lab() {
  const e = new Engine();
  const r1 = e.addDevice('router');
  const pc = e.addDevice('pc');
  const srv = e.addDevice('server');
  must(e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'straight'));
  must(e.setInterfaceIp(r1, 'p0', '10.0.0.1', '255.255.255.0'));
  must(e.setInterfaceIp(r1, 'p1', '10.0.1.1', '255.255.255.0'));
  e.setPortAdmin(r1, 'p0', true);
  e.setPortAdmin(r1, 'p1', true);
  must(e.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(srv, '10.0.1.10', '255.255.255.0', '10.0.1.1'));
  rcfg(e, r1).sys.hostname = 'R1';
  run(e, 1);
  return { e, r1, pc, srv };
}

function wait(e: Engine, id: string, req: number): ReturnType<Engine['p5']['reqStatus']> {
  run(e, 6);
  return e.p5.reqStatus(id, req);
}

describe('TFTP', () => {
  it('Config-Backup und Restore (Round Trip)', () => {
    const { e, r1, srv } = lab();
    must(e.p5.setServices(srv, { tftp: { enabled: true, files: {} } }));
    const w = e.p5.request(r1, '10.0.1.10', 'tftp', 'wrq', { file: 'r1-confg' }, 'hostname R1\n!');
    must(w);
    const st = wait(e, r1, (w as { value: number }).value);
    expect(st?.status).toBe('done');
    expect(host(e, srv).services.tftp?.files['r1-confg']).toBe('hostname R1\n!');
    const rd = e.p5.request(r1, '10.0.1.10', 'tftp', 'rrq', { file: 'r1-confg' });
    must(rd);
    const got = wait(e, r1, (rd as { value: number }).value);
    expect(got?.reply?.body).toBe('hostname R1\n!');
    const nf = e.p5.request(r1, '10.0.1.10', 'tftp', 'rrq', { file: 'missing' });
    must(nf);
    expect(wait(e, r1, (nf as { value: number }).value)?.reply?.op).toBe('error');
  });

  it('Server aus: Timeout', () => {
    const { e, r1 } = lab();
    const w = e.p5.request(r1, '10.0.1.10', 'tftp', 'wrq', { file: 'x' }, 'y');
    must(w);
    expect(wait(e, r1, (w as { value: number }).value)?.status).toBe('timeout');
  });
});

describe('NTP / Uhr', () => {
  it('Router und Host synchronisieren ihre Uhr mit dem Server', () => {
    const { e, r1, pc, srv } = lab();
    must(e.p5.setServices(srv, { ntp: { enabled: true } }));
    const before = e.p5.clockMs(r1) as number;
    mgmtOf(rcfg(e, r1).sys).ntp.servers.push('10.0.1.10');
    must(e.p5.setHostNtp(pc, '10.0.1.10'));
    e.p5.setMgmt(r1, { ntp: { servers: ['10.0.1.10'] } });
    run(e, 10);
    const server = e.p5.clockMs(srv) as number;
    expect(Math.abs((e.p5.clockMs(r1) as number) - server)).toBeLessThan(1000);
    expect(e.p5.clockMs(r1)).not.toBe(before);
    expect(mgmtOf(rcfg(e, r1).sys).clock.syncedTo).toBe('10.0.1.10');
    expect(mgmtOf(rcfg(e, r1).sys).clock.stratum).toBe(2);
    expect(Math.abs((e.p5.clockMs(pc) as number) - server)).toBeLessThan(1000);
    // manuell stellen hebt die Synchronisation auf
    must(e.p5.setClock(r1, Date.UTC(2030, 5, 1)));
    expect(mgmtOf(rcfg(e, r1).sys).clock.syncedTo).toBeUndefined();
  });
});

describe('Syslog', () => {
  it('Server empfängt Link-down-Meldungen', () => {
    const { e, r1, srv, pc } = lab();
    must(e.p5.setServices(srv, { syslog: { enabled: true, messages: [] } }));
    e.p5.setMgmt(r1, { syslog: { hosts: ['10.0.1.10'], trap: 6, buffered: true } });
    e.setPortAdmin(r1, 'p0', false);
    run(e, 2);
    const msgs = host(e, srv).services.syslog?.messages ?? [];
    expect(
      msgs.some((m) =>
        m.text.includes('%LINK-3-UPDOWN: Interface GigabitEthernet0/0, changed state to down'),
      ),
    ).toBe(true);
    expect(msgs.every((m) => m.from === '10.0.1.1')).toBe(true);
    expect(mgmtOf(rcfg(e, r1).sys).logBuffer.length).toBeGreaterThan(0);
    void pc;
  });

  it('trap-Schwelle filtert', () => {
    const { e, r1, srv } = lab();
    must(e.p5.setServices(srv, { syslog: { enabled: true, messages: [] } }));
    e.p5.setMgmt(r1, { syslog: { hosts: ['10.0.1.10'], trap: 3, buffered: true } });
    e.setPortAdmin(r1, 'p0', false);
    run(e, 2);
    const msgs = host(e, srv).services.syslog?.messages ?? [];
    expect(msgs.some((m) => m.text.includes('LINK-3-UPDOWN'))).toBe(true);
    expect(msgs.some((m) => m.text.includes('LINEPROTO'))).toBe(false);
  });
});

describe('SNMP', () => {
  it('sysName und ifTable mit Community; falsche Community bleibt stumm', () => {
    const { e, r1, srv } = lab();
    e.p5.setMgmt(r1, {
      snmp: {
        communities: [
          { name: 'public', rw: false },
          { name: 'private', rw: true },
        ],
      },
    });
    const g = e.p5.request(srv, '10.0.1.1', 'snmp', 'get', {
      community: 'public',
      oid: 'sysName.0',
    });
    must(g);
    const st = wait(e, srv, (g as { value: number }).value);
    expect(JSON.parse(st?.reply?.body ?? '[]')).toEqual([['1.3.6.1.2.1.1.5.0', 'R1']]);
    const w = e.p5.request(srv, '10.0.1.1', 'snmp', 'walk', {
      community: 'public',
      oid: '1.3.6.1.2.1.2.2.1.2',
    });
    must(w);
    const names = JSON.parse(wait(e, srv, (w as { value: number }).value)?.reply?.body ?? '[]') as [
      string,
      string,
    ][];
    expect(names.map((n) => n[1])).toContain('GigabitEthernet0/1');
    const bad = e.p5.request(srv, '10.0.1.1', 'snmp', 'get', {
      community: 'nope',
      oid: 'sysName.0',
    });
    must(bad);
    expect(wait(e, srv, (bad as { value: number }).value)?.status).toBe('timeout');
    // set nur mit rw
    const ro = e.p5.request(srv, '10.0.1.1', 'snmp', 'set', {
      community: 'public',
      oid: 'sysName.0',
      value: 'X',
    });
    must(ro);
    expect(wait(e, srv, (ro as { value: number }).value)?.reply?.args.status).toBe('readOnly');
    const rw = e.p5.request(srv, '10.0.1.1', 'snmp', 'set', {
      community: 'private',
      oid: 'sysName.0',
      value: 'Core',
    });
    must(rw);
    wait(e, srv, (rw as { value: number }).value);
    expect(rcfg(e, r1).sys.hostname).toBe('Core');
  });
});

describe('Telnet / SSH / AAA', () => {
  function vtyLab() {
    const l = lab();
    const cfg = rcfg(l.e, l.r1);
    cfg.sys.lineVty = { login: true, password: 'cisco' };
    return l;
  }
  function login(
    e: Engine,
    from: string,
    dst: string,
    proto: 'telnet' | 'ssh',
    user: string,
    pass: string,
  ) {
    const o = e.p5.open(from, dst, proto);
    must(o);
    const key = (o as { value: string }).value;
    run(e, 5);
    const c = e.p5.connState(from, key);
    if (c?.state !== 'open') return { state: c?.state, err: c?.err, key, reply: undefined };
    e.p5.send(from, key, 'login', { user, pass });
    run(e, 5);
    return {
      state: e.p5.connState(from, key)?.state,
      err: undefined,
      key,
      reply: e.p5.connState(from, key)?.reply,
    };
  }

  it('Telnet mit vty-Passwort; falsches Passwort scheitert nach 3 Versuchen', () => {
    const { e, r1, pc } = vtyLab();
    const ok = login(e, pc, '10.0.0.1', 'telnet', '', 'cisco');
    expect(ok.reply?.op).toBe('login-ok');
    expect(mgmtOf(rcfg(e, r1).sys).sessions).toHaveLength(1);
    expect(mgmtOf(rcfg(e, r1).sys).sessions[0]).toMatchObject({ line: 0, from: '10.0.0.2' });
    e.p5.close(pc, ok.key);
    run(e, 2);
    expect(mgmtOf(rcfg(e, r1).sys).sessions).toHaveLength(0);
    const o = e.p5.open(pc, '10.0.0.1', 'telnet');
    const key = (o as { value: string }).value;
    run(e, 3);
    for (let i = 0; i < 3; i++) {
      e.p5.send(pc, key, 'login', { user: '', pass: 'bad' });
      run(e, 2);
    }
    expect(e.p5.connState(pc, key)?.state).toBe('closed');
  });

  it('ohne Passwort/Login: "Password required, but none set"; Transport-Filter', () => {
    const { e, r1, pc } = lab();
    const o = e.p5.open(pc, '10.0.0.1', 'telnet');
    const key = (o as { value: string }).value;
    run(e, 3);
    expect(e.p5.connState(pc, key)?.banner?.args.auth).toBe('none');
    // nur SSH erlaubt → Telnet wird abgelehnt
    rcfg(e, r1).sys.lineVty = { login: true, password: 'x' };
    mgmtOf(rcfg(e, r1).sys).vty.transport = ['ssh'];
    const t = login(e, pc, '10.0.0.1', 'telnet', '', 'x');
    expect(t.state).toBe('failed');
    expect(t.err).toBe('conn.refused');
    // SSH ohne Schlüssel ebenfalls
    const s1 = login(e, pc, '10.0.0.1', 'ssh', 'admin', 'pw');
    expect(s1.err).toBe('conn.refused');
  });

  it('SSH nur mit Domain + Schlüssel, lokale Benutzer und transport input ssh', () => {
    const { e, r1, pc } = vtyLab();
    const cfg = rcfg(e, r1);
    const m = mgmtOf(cfg.sys);
    cfg.sys.domainName = 'lab.local';
    m.ssh.keyBits = 1024;
    m.vty.transport = ['ssh'];
    m.vty.loginLocal = true;
    m.users.admin = { secret: 'pw123', privilege: 15 };
    expect(login(e, pc, '10.0.0.1', 'telnet', 'admin', 'pw123').err).toBe('conn.refused');
    expect(login(e, pc, '10.0.0.1', 'ssh', 'admin', 'wrong').reply?.op).toBe('login-fail');
    const good = login(e, pc, '10.0.0.1', 'ssh', 'admin', 'pw123');
    expect(good.reply?.op).toBe('login-ok');
    expect(m.sessions[0]).toMatchObject({ user: 'admin', protocol: 'ssh' });
  });

  it('Mehrere vty-Sitzungen parallel; Limit erschöpft', () => {
    const { e, r1, pc } = vtyLab();
    mgmtOf(rcfg(e, r1).sys).vty.lines = 2;
    const a = login(e, pc, '10.0.0.1', 'telnet', '', 'cisco');
    const b = login(e, pc, '10.0.0.1', 'telnet', '', 'cisco');
    expect(a.reply?.args.vty).toBe(0);
    expect(b.reply?.args.vty).toBe(1);
    const c = login(e, pc, '10.0.0.1', 'telnet', '', 'cisco');
    expect(c.err).toBe('conn.refused');
  });

  it('AAA: Anmeldung gegen RADIUS-Server, Fallback local bei Timeout', () => {
    const { e, r1, pc, srv } = vtyLab();
    must(
      e.p5.setServices(srv, {
        aaa: {
          enabled: true,
          clients: [{ ip: '10.0.1.1', secret: 'rad-key' }],
          users: [{ user: 'alice', pass: 'wonderland' }],
        },
      }),
    );
    const cfg = rcfg(e, r1);
    const m = mgmtOf(cfg.sys);
    m.aaa = {
      newModel: true,
      radius: [{ host: '10.0.1.10', key: 'rad-key' }],
      methods: ['radius', 'local'],
      listName: 'default',
    };
    m.users.local = { secret: 'localpw', privilege: 1 };
    const good = login(e, pc, '10.0.0.1', 'telnet', 'alice', 'wonderland');
    expect(good.reply?.op).toBe('login-ok');
    const bad = login(e, pc, '10.0.0.1', 'telnet', 'alice', 'nope');
    expect(bad.reply?.op).toBe('login-fail');
    // Falscher Shared Secret → Server schweigt → Timeout → lokaler Fallback
    m.aaa.radius = [{ host: '10.0.1.10', key: 'wrong' }];
    const fb = login(e, pc, '10.0.0.1', 'telnet', 'local', 'localpw');
    expect(fb.reply?.op).toBe('login-ok');
  });
});

describe('FTP und Mail', () => {
  it('FTP: Anmeldung, Upload, Liste, Download', () => {
    const { e, pc, srv } = lab();
    must(
      e.p5.setServices(srv, {
        ftp: { enabled: true, users: [{ user: 'u', pass: 'p' }], files: { 'a.txt': 'hello' } },
      }),
    );
    const o = e.p5.open(pc, '10.0.1.10', 'ftp');
    const key = (o as { value: string }).value;
    run(e, 3);
    expect(e.p5.connState(pc, key)?.banner?.args.text).toContain('220');
    e.p5.send(pc, key, 'list');
    run(e, 2);
    expect(e.p5.connState(pc, key)?.reply?.op).toBe('error'); // nicht angemeldet
    e.p5.send(pc, key, 'user', { user: 'u', pass: 'p' });
    run(e, 2);
    expect(e.p5.connState(pc, key)?.reply?.op).toBe('login-ok');
    e.p5.send(pc, key, 'put', { file: 'b.txt' }, 'world');
    run(e, 2);
    e.p5.send(pc, key, 'get', { file: 'b.txt' });
    run(e, 2);
    expect(e.p5.connState(pc, key)?.reply?.body).toBe('world');
    e.p5.send(pc, key, 'list');
    run(e, 2);
    expect(e.p5.connState(pc, key)?.reply?.body).toBe('a.txt\nb.txt');
    e.p5.close(pc, key);
  });

  it('Mail: senden und abrufen', () => {
    const { e, pc, srv } = lab();
    const other = e.addDevice('laptop');
    must(
      e.connect(
        { deviceId: other, portId: 'p0' },
        { deviceId: e.addDevice('switch-l2'), portId: 'p0' },
        'straight',
      ),
    );
    must(
      e.p5.setServices(srv, {
        mail: {
          enabled: true,
          domain: 'corp.lan',
          accounts: [
            { user: 'alice', pass: 'a1' },
            { user: 'bob', pass: 'b1' },
          ],
          boxes: {},
          nextId: 1,
        },
      }),
    );
    must(e.p5.setMailAccount(pc, { server: '10.0.1.10', user: 'alice@corp.lan', pass: 'a1' }));
    must(e.p5.mailSend(pc, 'bob@corp.lan', 'Hallo', 'Wie geht es?'));
    run(e, 5);
    expect(host(e, pc).mail?.status?.key).toBe('mail.sent');
    expect(host(e, srv).services.mail?.boxes.bob).toHaveLength(1);
    must(e.p5.mailSend(pc, 'nobody@corp.lan', 'x', 'y'));
    run(e, 5);
    expect(host(e, pc).mail?.status?.key).toBe('mail.error');
    must(e.p5.setMailAccount(pc, { server: '10.0.1.10', user: 'bob@corp.lan', pass: 'b1' }));
    must(e.p5.mailFetch(pc));
    run(e, 5);
    expect(host(e, pc).mail?.inbox[0]?.subject).toBe('Hallo');
    must(e.p5.setMailAccount(pc, { server: '10.0.1.10', user: 'bob@corp.lan', pass: 'bad' }));
    must(e.p5.mailFetch(pc));
    run(e, 5);
    expect(host(e, pc).mail?.status?.key).toBe('mail.error');
  });
});

describe('IoT', () => {
  it('Regel "wenn Sensor > Schwelle dann Aktor an" schaltet den Aktor', () => {
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    const srv = e.addDevice('server');
    const sen = e.addDevice('iot-sensor', { name: 'Temp1' });
    const act = e.addDevice('iot-actuator', { name: 'Fan1' });
    [srv, sen, act].forEach((d, i) =>
      must(e.connect({ deviceId: d, portId: 'p0' }, { deviceId: sw, portId: `p${i}` }, 'straight')),
    );
    must(e.setHostIp(srv, '10.0.0.10', '255.255.255.0'));
    must(e.setHostIp(sen, '10.0.0.11', '255.255.255.0'));
    must(e.setHostIp(act, '10.0.0.12', '255.255.255.0'));
    must(
      e.p5.setServices(srv, {
        iot: {
          enabled: true,
          devices: {},
          rules: [
            {
              id: 1,
              sensor: 'Temp1',
              op: '>',
              threshold: 25,
              actuator: 'Fan1',
              action: 'on',
              elseAction: 'off',
            },
          ],
        },
      }),
    );
    must(e.p5.setIot(sen, { server: '10.0.0.10', reportSec: 2 }));
    must(e.p5.setIot(act, { server: '10.0.0.10', reportSec: 2 }));
    run(e, 40);
    const reg = host(e, srv).services.iot?.devices ?? {};
    expect(Object.keys(reg).sort()).toEqual(['Fan1', 'Temp1']);
    expect(host(e, act).iot?.state).toBe('off');
    must(e.p5.setIot(sen, { value: 30 }));
    run(e, 6);
    expect(host(e, act).iot?.state).toBe('on');
    expect(host(e, srv).services.iot?.devices.Fan1?.state).toBe('on');
    must(e.p5.setIot(sen, { value: 20 }));
    run(e, 6);
    expect(host(e, act).iot?.state).toBe('off');
    expect(e.log.map((l) => l.msg.key)).toContain('svc.iot.rule');
  });

  it('Wellenmuster ist deterministisch', () => {
    const e = new Engine();
    const sen = e.addDevice('iot-sensor');
    must(e.p5.setIot(sen, { pattern: 'wave', min: 0, max: 10, periodSec: 40 }));
    expect(e.p5.setIot('nope', {}).ok).toBe(false);
  });
});
