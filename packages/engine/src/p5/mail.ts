import type { DeviceCtx } from '../ctx';
import type { IpNode } from '../l3';
import type { AppConn, MailMsg } from '../p5types';
import type { Device, HostConfig } from '../types';
import type { ClientHook, SvcReply, TcpServer } from './conn';

const hostOf = (d: Device): HostConfig | undefined =>
  d.config.kind === 'host' ? d.config : undefined;

const split = (addr: string): { user: string; domain: string } => {
  const i = addr.lastIndexOf('@');
  return i < 0 ? { user: addr, domain: '' } : { user: addr.slice(0, i), domain: addr.slice(i + 1) };
};

/** SMTP-Server (Port 25): Einlieferung in die Postfächer lokaler Konten. */
export const smtpServer: TcpServer = {
  accept(_ctx, dev) {
    const svc = hostOf(dev)?.services.mail;
    if (!svc?.enabled) return 'refuse';
    return { op: 'banner', args: { text: `220 ${svc.domain} ESMTP ready` } };
  },
  handle(ctx, dev, _node, _conn, msg): SvcReply {
    const svc = hostOf(dev)?.services.mail;
    if (!svc || msg.op !== 'send') return undefined;
    const from = String(msg.args.from ?? '');
    const to = String(msg.args.to ?? '');
    const sender = split(from);
    const acct = svc.accounts.find((a) => a.user === sender.user);
    if (!acct || acct.pass !== msg.args.pass || sender.domain !== svc.domain)
      return { op: 'error', args: { text: '535 Authentication failed' } };
    const rcpt = split(to);
    if (rcpt.domain !== svc.domain || !svc.accounts.some((a) => a.user === rcpt.user))
      return { op: 'error', args: { text: '550 Unknown recipient' } };
    const mail: MailMsg = {
      id: svc.nextId++,
      from,
      to,
      subject: String(msg.args.subject ?? ''),
      body: msg.body ?? '',
      t: ctx.now,
    };
    (svc.boxes[rcpt.user] ??= []).push(mail);
    return { op: 'ok', args: { text: '250 Message accepted' } };
  },
};

/** POP3-Server (Port 110): liefert den Posteingang. */
export const pop3Server: TcpServer = {
  accept(_ctx, dev) {
    const svc = hostOf(dev)?.services.mail;
    if (!svc?.enabled) return 'refuse';
    return { op: 'banner', args: { text: '+OK POP3 server ready' } };
  },
  handle(_ctx, dev, _node, _conn, msg): SvcReply {
    const svc = hostOf(dev)?.services.mail;
    if (!svc || msg.op !== 'fetch') return undefined;
    const user = String(msg.args.user ?? '');
    const acct = svc.accounts.find((a) => a.user === user);
    if (!acct || acct.pass !== msg.args.pass)
      return { op: 'error', args: { text: '-ERR authentication failed' } };
    return { op: 'ok', args: { text: '+OK' }, body: JSON.stringify(svc.boxes[user] ?? []) };
  },
};

/** Abschluss einer Mail-Client-Verbindung (Senden/Abrufen) – setzt `HostConfig.mail`. */
export const mailClientHook: ClientHook = (ctx: DeviceCtx, node: IpNode, c: AppConn, event) => {
  const dev = ctx.device;
  const h = hostOf(dev);
  const mail = h?.mail;
  if (!h || !mail || !c.purpose?.startsWith('mail-')) return;
  const fail = (key: string, params?: Record<string, string | number>): void => {
    mail.status = { key, params };
  };
  if (event === 'open') return;
  if (event === 'fail') {
    fail(c.err === 'conn.refused' ? 'mail.refused' : 'mail.timeout');
    return;
  }
  const r = c.reply;
  if (!r) return;
  if (r.op === 'error') return fail('mail.error', { text: String(r.args.text ?? '') });
  if (c.purpose === 'mail-send') {
    mail.sent.push({
      id: mail.sent.length + 1,
      from: `${mail.user}`,
      to: String(c.data?.to ?? ''),
      subject: String(c.data?.subject ?? ''),
      body: String(c.data?.body ?? ''),
      t: ctx.now,
    });
    mail.status = { key: 'mail.sent' };
  } else if (r.body !== undefined) {
    try {
      mail.inbox = JSON.parse(r.body) as MailMsg[];
      mail.status = { key: 'mail.received', params: { count: mail.inbox.length } };
    } catch {
      fail('mail.error', { text: 'parse' });
    }
  }
  void node;
};
