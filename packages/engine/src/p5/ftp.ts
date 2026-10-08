import type { Device, HostConfig } from '../types';
import type { SvcReply, TcpServer } from './conn';

const hostOf = (d: Device): HostConfig | undefined =>
  d.config.kind === 'host' ? d.config : undefined;

/**
 * FTP-Server (Steuer- und Datenkanal vereinfacht in einer TCP-Verbindung auf Port 21).
 * Operationen: `user` (Anmeldung), `list`, `get`, `put`, `delete`.
 */
export const ftpServer: TcpServer = {
  accept(_ctx, dev) {
    const svc = hostOf(dev)?.services.ftp;
    if (!svc?.enabled) return 'refuse';
    return { op: 'banner', args: { text: '220 NetSim FTP server ready' } };
  },
  handle(_ctx, dev, _node, conn, msg): SvcReply {
    const svc = hostOf(dev)?.services.ftp;
    if (!svc) return undefined;
    switch (msg.op) {
      case 'user': {
        const user = String(msg.args.user ?? '');
        const pass = String(msg.args.pass ?? '');
        const ok = svc.users.some((u) => u.user === user && u.pass === pass);
        if (!ok) {
          conn.fails = (conn.fails ?? 0) + 1;
          return { op: 'login-fail', args: { text: '530 Login incorrect' } };
        }
        conn.authed = true;
        conn.user = user;
        return { op: 'login-ok', args: { text: '230 User logged in' } };
      }
      case 'list':
        if (!conn.authed)
          return { op: 'error', args: { text: '530 Please login with USER and PASS' } };
        return { op: 'list', args: {}, body: Object.keys(svc.files).sort().join('\n') };
      case 'get': {
        if (!conn.authed)
          return { op: 'error', args: { text: '530 Please login with USER and PASS' } };
        const data = svc.files[String(msg.args.file ?? '')];
        return data === undefined
          ? { op: 'error', args: { text: '550 File not found' } }
          : { op: 'data', args: { text: '226 Transfer complete' }, body: data };
      }
      case 'put':
        if (!conn.authed)
          return { op: 'error', args: { text: '530 Please login with USER and PASS' } };
        svc.files[String(msg.args.file ?? '')] = msg.body ?? '';
        return { op: 'ok', args: { text: '226 Transfer complete' } };
      case 'delete': {
        if (!conn.authed)
          return { op: 'error', args: { text: '530 Please login with USER and PASS' } };
        const file = String(msg.args.file ?? '');
        if (svc.files[file] === undefined)
          return { op: 'error', args: { text: '550 File not found' } };
        delete svc.files[file];
        return { op: 'ok', args: { text: '250 File deleted' } };
      }
      default:
        return { op: 'error', args: { text: '500 Unknown command' } };
    }
  },
};
