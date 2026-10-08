import type { DeviceCtx } from '../ctx';
import type { IpNode } from '../l3';
import { mgmtOf } from '../p5defaults';
import type { AppConn, MgmtCfg } from '../p5types';
import type { Device, RouterConfig, SwitchConfig } from '../types';
import { connKey, serverPush, type SvcReply, type TcpServer } from './conn';
import { appcOf } from './node';
import { syslogEmit } from './syslog';
import { udpRequest } from './udputil';

type CliCfg = RouterConfig | SwitchConfig;

/** Wie sich Anwender an den vty-Leitungen anmelden müssen. */
export type VtyAuth = 'none' | 'password' | 'local' | 'aaa';

export function vtyAuthMode(cfg: CliCfg): VtyAuth {
  const m = mgmtOf(cfg.sys);
  if (m.aaa.newModel && m.aaa.methods.length > 0) return 'aaa';
  if (m.vty.loginLocal) return 'local';
  if (cfg.sys.lineVty.login && cfg.sys.lineVty.password !== undefined) return 'password';
  return 'none';
}

/** Kann dieses Gerät SSH anbieten (Domain-Name + RSA-Schlüssel)? */
export const sshReady = (cfg: CliCfg): boolean =>
  !!cfg.sys.domainName && mgmtOf(cfg.sys).ssh.keyBits !== undefined;

function freeVty(m: MgmtCfg, conns: AppConn[]): number {
  const used = new Set<number>(m.sessions.map((s) => s.line));
  for (const c of conns) if (c.role === 's' && c.vty !== undefined) used.add(c.vty);
  for (let i = 0; i < m.vty.lines; i++) if (!used.has(i)) return i;
  return -1;
}

const cliCfg = (d: Device): CliCfg | undefined =>
  d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;

function loginOk(
  ctx: DeviceCtx,
  node: IpNode,
  dev: Device,
  cfg: CliCfg,
  conn: AppConn,
  user: string,
): NonNullable<SvcReply> {
  const m = mgmtOf(cfg.sys);
  conn.authed = true;
  conn.user = user;
  m.sessions.push({
    line: conn.vty ?? 0,
    user,
    from: conn.raddr,
    since: ctx.now,
    protocol: conn.proto === 'ssh' ? 'ssh' : 'telnet',
  });
  syslogEmit(
    ctx,
    dev,
    5,
    'SEC_LOGIN-5-LOGIN_SUCCESS',
    `Login Success [user: ${user || 'unknown'}] [Source: ${conn.raddr}] [localport: ${conn.lport}]`,
  );
  void node;
  return {
    op: 'login-ok',
    args: { vty: conn.vty ?? 0, hostname: cfg.sys.hostname, user },
  };
}

function loginFail(
  ctx: DeviceCtx,
  dev: Device,
  cfg: CliCfg,
  conn: AppConn,
  user: string,
): NonNullable<SvcReply> {
  conn.fails = (conn.fails ?? 0) + 1;
  syslogEmit(
    ctx,
    dev,
    5,
    'SEC_LOGIN-4-LOGIN_FAILED',
    `Login failed [user: ${user || 'unknown'}] [Source: ${conn.raddr}] [localport: ${conn.lport}]`,
  );
  void cfg;
  return { op: 'login-fail', args: { left: Math.max(0, 3 - conn.fails) }, close: conn.fails >= 3 };
}

function checkLocal(cfg: CliCfg, user: string, pass: string): boolean {
  return mgmtOf(cfg.sys).users[user]?.secret === pass;
}

/** Telnet-/SSH-Server (vty). Die Sitzung selbst läuft als CLI-Sitzung des Zielgeräts (Shell-Schicht). */
export function remoteServer(proto: 'telnet' | 'ssh'): TcpServer {
  return {
    accept(ctx, dev, node, conn) {
      const cfg = cliCfg(dev);
      if (!cfg) return 'refuse';
      const m = mgmtOf(cfg.sys);
      if (!m.vty.transport.includes(proto)) return 'refuse';
      if (proto === 'ssh' && !sshReady(cfg)) return 'refuse';
      const idx = freeVty(m, Object.values(appcOf(node.cfg).conns));
      if (idx < 0) return 'refuse';
      conn.vty = idx;
      return {
        op: 'banner',
        args: { auth: vtyAuthMode(cfg), hostname: cfg.sys.hostname },
        body: proto === 'telnet' ? cfg.sys.bannerMotd : undefined,
      };
    },
    handle(ctx, dev, node, conn, msg): SvcReply {
      const cfg = cliCfg(dev);
      if (!cfg || msg.op !== 'login') return undefined;
      const user = String(msg.args.user ?? '');
      const pass = String(msg.args.pass ?? '');
      const mode = vtyAuthMode(cfg);
      if (mode === 'none')
        return { op: 'login-fail', args: { left: 0, reason: 'noPassword' }, close: true };
      if (mode === 'password')
        return cfg.sys.lineVty.password === pass
          ? loginOk(ctx, node, dev, cfg, conn, user)
          : loginFail(ctx, dev, cfg, conn, user);
      if (mode === 'local')
        return checkLocal(cfg, user, pass)
          ? loginOk(ctx, node, dev, cfg, conn, user)
          : loginFail(ctx, dev, cfg, conn, user);
      // AAA: Methodenliste der Reihe nach
      return aaaStep(ctx, node, dev, cfg, conn, user, pass, 0);
    },
    closed(ctx, dev, conn) {
      const cfg = cliCfg(dev);
      if (!cfg || conn.vty === undefined) return;
      const m = mgmtOf(cfg.sys);
      m.sessions = m.sessions.filter((s) => s.line !== conn.vty);
    },
  };
}

// ---------------------------------------------------------------- AAA

function aaaStep(
  ctx: DeviceCtx,
  node: IpNode,
  dev: Device,
  cfg: CliCfg,
  conn: AppConn,
  user: string,
  pass: string,
  from: number,
): SvcReply {
  const m = mgmtOf(cfg.sys);
  for (let i = from; i < m.aaa.methods.length; i++) {
    const method = m.aaa.methods[i];
    if (method === 'local') {
      return checkLocal(cfg, user, pass)
        ? loginOk(ctx, node, dev, cfg, conn, user)
        : loginFail(ctx, dev, cfg, conn, user);
    }
    const host = m.aaa.radius[0];
    if (!host) continue;
    const r = udpRequest(ctx, node, {
      dst: host.host,
      proto: 'radius',
      op: 'access-request',
      args: { user, pass, secret: host.key },
    });
    if (!r.ok) continue;
    appcOf(node.cfg).aaaWait[r.id] = { key: connKey(conn), user, next: i + 1, pass };
    return undefined; // Antwort folgt nach der RADIUS-Entscheidung
  }
  return loginFail(ctx, dev, cfg, conn, user);
}

/** RADIUS-Antwort bzw. Timeout (`accepted` undefined) für einen wartenden Login. */
export function aaaDecision(
  ctx: DeviceCtx,
  node: IpNode,
  dev: Device,
  reqId: number,
  accepted: boolean | undefined,
): void {
  const core = appcOf(node.cfg);
  const w = core.aaaWait[reqId];
  const cfg = cliCfg(dev);
  if (!w || !cfg) return;
  delete core.aaaWait[reqId];
  const conn = core.conns[w.key];
  if (!conn) return;
  let reply: SvcReply;
  if (accepted === true) reply = loginOk(ctx, node, dev, cfg, conn, w.user);
  else if (accepted === false) reply = loginFail(ctx, dev, cfg, conn, w.user);
  else reply = aaaStep(ctx, node, dev, cfg, conn, w.user, w.pass, w.next); // Timeout → nächste Methode
  if (reply) {
    serverPush(ctx, node, conn, reply);
    if (reply.close) delete core.conns[w.key];
  }
}
