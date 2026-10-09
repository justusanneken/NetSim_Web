import type { DeviceCtx } from '../ctx';
import type { IpNode } from '../l3';
import { mgmtOf } from '../p5defaults';
import type { AppConn, TacacsHost } from '../p5types';
import type { Device, HostConfig } from '../types';
import {
  connClose,
  connKey,
  connOpen,
  type ClientHook,
  type SvcReply,
  type TcpServer,
} from './conn';
import { appcOf } from './node';
import { aaaDecision } from './remote';

/**
 * TACACS+ (vereinfacht, TCP 49): Authentifizierung als eine Anfrage/Antwort (`authen` →
 * `authen-pass` | `authen-fail` | `authen-error`). Kein Header-Austausch, keine Authorization/Accounting,
 * kein Verschlüsseln des Rumpfes – der gemeinsame Schlüssel wird verglichen (Fehler ⇒ `authen-error`,
 * wie ein nicht lesbares Paket bei IOS: nächste Methode der Liste).
 */

const hostOf = (d: Device): HostConfig | undefined =>
  d.config.kind === 'host' ? d.config : undefined;

// ---------------------------------------------------------------- Server

export const tacacsServer: TcpServer = {
  accept(_ctx, dev, _node, conn) {
    const svc = hostOf(dev)?.services.tacacs;
    if (!svc?.enabled || !svc.clients.some((c) => c.ip === conn.raddr)) return 'refuse';
    return { op: 'banner', args: { text: 'TACACS+ ready' } };
  },
  handle(ctx, dev, _node, conn, msg): SvcReply {
    const svc = hostOf(dev)?.services.tacacs;
    if (!svc || msg.op !== 'authen') return undefined;
    const client = svc.clients.find((c) => c.ip === conn.raddr);
    const user = String(msg.args.user ?? '');
    const log = (key: string, status: 'ok' | 'drop'): void =>
      ctx.log({
        kind: 'info',
        proto: 'TACACS',
        status,
        msg: { key, params: { user, src: conn.raddr } },
      });
    if (!client || client.secret !== msg.args.secret) {
      log('svc.tacacs.badKey', 'drop');
      return { op: 'authen-error', args: { status: 'error' }, close: true };
    }
    const ok = svc.users.some((u) => u.user === user && u.pass === msg.args.pass);
    log(ok ? 'svc.tacacs.pass' : 'svc.tacacs.fail', ok ? 'ok' : 'drop');
    return {
      op: ok ? 'authen-pass' : 'authen-fail',
      args: { status: ok ? 'pass' : 'fail' },
      close: true,
    };
  },
};

// ---------------------------------------------------------------- Client (Router/Switch)

/**
 * Öffnet die TCP-Verbindung zum TACACS+-Server und stellt die Anmeldung als erste Anfrage ein.
 * Liefert die Warte-ID (`aaaWait`) oder `false`, wenn der Server nicht erreichbar ist.
 */
export function tacacsAuth(
  ctx: DeviceCtx,
  node: IpNode,
  host: TacacsHost,
  user: string,
  pass: string,
): number | false {
  const r = connOpen(ctx, node, { dst: host.host, proto: 'tacacs' });
  if (!r.ok) return false;
  const core = appcOf(node.cfg);
  const c = core.conns[r.key];
  if (!c) return false;
  const wait = core.nextReq++;
  c.first = { op: 'authen', args: { user, pass, secret: host.key, service: 'login' } };
  c.purpose = 'tacacs-auth';
  c.data = { wait };
  host.opens = (host.opens ?? 0) + 1;
  return wait;
}

/** Antwort bzw. Fehler einer TACACS+-Client-Verbindung → Entscheidung für den wartenden Login. */
export const tacacsClientHook: ClientHook = (ctx: DeviceCtx, node: IpNode, c: AppConn, event) => {
  if (c.purpose !== 'tacacs-auth' || event === 'open') return;
  const cfg = ctx.device.config;
  if (cfg.kind !== 'router' && cfg.kind !== 'switch') return;
  const host = (mgmtOf(cfg.sys).aaa.tacacs ?? []).find((h) => h.host === c.raddr);
  const wait = Number(c.data?.wait);
  const op = event === 'reply' ? c.reply?.op : undefined;
  if (host) {
    if (op === 'authen-pass') host.pass = (host.pass ?? 0) + 1;
    else if (op === 'authen-fail') host.fail = (host.fail ?? 0) + 1;
    else host.errors = (host.errors ?? 0) + 1;
  }
  const key = connKey(c);
  const accepted = op === 'authen-pass' ? true : op === 'authen-fail' ? false : undefined;
  connClose(ctx, node, key);
  aaaDecision(ctx, node, ctx.device, wait, accepted);
};
