import { describe, expect, it } from 'vitest';
import { Engine, type Result, type RouterConfig } from '../src';
import { mgmtOf } from '../src/p5defaults';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const rcfg = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;
const run = (e: Engine, s = 10): void => void e.runUntil(e.state.now + s * 1_000_000);

/** PC (10.0.0.2) – R1 (.1 / 10.0.1.1) – TACACS+-Server (10.0.1.10). */
function lab() {
  const e = new Engine({ seed: 3 });
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
  rcfg(e, r1).sys.lineVty = { login: true, password: 'cisco' };
  must(
    e.p5.setServices(srv, {
      tacacs: {
        enabled: true,
        clients: [{ ip: '10.0.1.1', secret: 'tackey' }],
        users: [{ user: 'alice', pass: 'wonderland' }],
      },
    }),
  );
  const m = mgmtOf(rcfg(e, r1).sys);
  m.aaa = {
    newModel: true,
    radius: [],
    tacacs: [{ host: '10.0.1.10', key: 'tackey' }],
    methods: ['tacacs', 'local'],
    listName: 'default',
  };
  m.users.local = { secret: 'localpw', privilege: 1 };
  run(e, 1);
  return { e, r1, pc, srv, m };
}

function login(e: Engine, from: string, user: string, pass: string, wait = 40) {
  const o = must(e.p5.open(from, '10.0.0.1', 'telnet'));
  run(e, 5);
  e.p5.send(from, o, 'login', { user, pass });
  run(e, wait);
  return e.p5.connState(from, o)?.reply?.op;
}

/** Eingehende ACL an der Server-Seite des Routers. */
function aclIn(e: Engine, r1: string, entries: RouterConfig['acls'][string]['entries']): void {
  const c = rcfg(e, r1);
  c.acls.T = { name: 'T', type: 'extended', entries };
  c.ifaces.p1 = { ...(c.ifaces.p1 ?? { kind: 'phys', portId: 'p1' }), aclIn: 'T' };
}

describe('QA2: TACACS+ mit ACLs, Ausfall und Wiederherstellung', () => {
  it('eingehende ACL sperrt TCP 49 der Server-Antworten: Fallback auf local', () => {
    const { e, r1, pc } = lab();
    aclIn(e, r1, [
      {
        seq: 10,
        action: 'deny',
        proto: 'tcp',
        src: { any: true },
        srcPort: { op: 'eq', a: 49 },
        dst: { any: true },
        matches: 0,
      },
      {
        seq: 20,
        action: 'permit',
        proto: 'ip',
        src: { any: true },
        dst: { any: true },
        matches: 0,
      },
    ]);
    expect(login(e, pc, 'local', 'localpw')).toBe('login-ok');
    expect(login(e, pc, 'alice', 'wonderland')).toBe('login-fail');
  });

  it('eine ACL, die nur anderen Verkehr sperrt, lässt TACACS+ unberührt', () => {
    const { e, r1, pc } = lab();
    aclIn(e, r1, [
      {
        seq: 10,
        action: 'deny',
        proto: 'tcp',
        src: { any: true },
        dst: { any: true },
        dstPort: { op: 'eq', a: 23 },
        matches: 0,
      },
      {
        seq: 20,
        action: 'permit',
        proto: 'ip',
        src: { any: true },
        dst: { any: true },
        matches: 0,
      },
    ]);
    expect(login(e, pc, 'alice', 'wonderland')).toBe('login-ok');
  });

  it('Server ausgeschaltet: Fallback local; nach dem Einschalten wieder TACACS+', () => {
    const { e, pc, srv } = lab();
    e.setPower(srv, false);
    expect(login(e, pc, 'local', 'localpw')).toBe('login-ok');
    e.setPower(srv, true);
    run(e, 5);
    expect(login(e, pc, 'alice', 'wonderland')).toBe('login-ok');
  });

  it('Snapshot während der Anmeldung: Restore + gleicher Ablauf liefert dasselbe Ergebnis', () => {
    const { e, pc } = lab();
    const o = must(e.p5.open(pc, '10.0.0.1', 'telnet'));
    run(e, 5);
    e.p5.send(pc, o, 'login', { user: 'alice', pass: 'wonderland' });
    e.runUntil(e.state.now + 2_000); // TACACS+-Anfrage unterwegs
    const snap = e.snapshot();
    run(e, 10);
    const a = JSON.stringify(e.state);
    expect(e.p5.connState(pc, o)?.reply?.op).toBe('login-ok');
    e.restore(snap);
    run(e, 10);
    expect(e.p5.connState(pc, o)?.reply?.op).toBe('login-ok');
    expect(JSON.stringify(e.state)).toBe(a);
  });
});
