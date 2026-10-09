import type { Ipv4Pdu, SvcPdu, SvcProto, TcpPdu, UdpPdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Iface } from '../ifaces';
import type { Base, IpNode } from '../l3';
import { capwapHandler, capwapReply } from './capwap';
import { connTimer, tcpRxSvc, type TcpServer } from './conn';
import { ftpServer } from './ftp';
import { iotHandler } from './iot';
import { mailClientHook, pop3Server, smtpServer } from './mail';
import { aaaDecision, remoteServer } from './remote';
import {
  onUdpReply,
  radiusServer,
  snmpAgent,
  syslogServer,
  tftpServer,
  ntpServer,
  type SvcRx,
} from './services';
import { appcOf } from './node';
import { eapDecision } from './wifi';

const SERVERS: Partial<Record<SvcProto, TcpServer>> = {
  ftp: ftpServer,
  smtp: smtpServer,
  pop3: pop3Server,
  telnet: remoteServer('telnet'),
  ssh: remoteServer('ssh'),
};

/** UDP-Dienstnachricht (`app.kind === 'svc'`) verarbeiten; `true` = verbraucht. */
export function svcUdpRx(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  udp: UdpPdu,
  msg: SvcPdu,
): boolean {
  const r: SvcRx = { ctx, node, iface, base, ip, udp, msg };
  if (msg.args.reply === true) {
    return onUdpReply(r, (rx, req) => {
      const dev = rx.ctx.device;
      if (msg.proto === 'capwap' && msg.op === 'join-ok')
        capwapReply(rx.ctx, dev, req.dst, msg.body ?? '[]');
      else if (msg.proto === 'radius') {
        const rid = Number(msg.args.rid);
        if (!eapDecision(rx.ctx, rx.node, rid, msg.op === 'access-accept'))
          aaaDecision(rx.ctx, rx.node, dev, rid, msg.op === 'access-accept');
      } else if (msg.proto === 'iot' && msg.op === 'registered' && dev.config.kind === 'host') {
        if (dev.config.iot) dev.config.iot.registered = true;
      } else if (msg.proto === 'iot' && msg.op === 'unknown' && dev.config.kind === 'host') {
        if (dev.config.iot) dev.config.iot.registered = false;
      }
    });
  }
  switch (msg.proto) {
    case 'tftp':
      return tftpServer(r);
    case 'ntp':
      return ntpServer(r);
    case 'syslog':
      return syslogServer(r);
    case 'snmp':
      return snmpAgent(r);
    case 'radius':
      return radiusServer(r);
    case 'iot':
      return iotHandler(r);
    case 'capwap':
      return capwapHandler(r);
    default:
      return false;
  }
}

/** TCP-Segment an die Dienstschicht (FTP, SMTP, POP3, Telnet, SSH). */
export function svcTcpRx(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  tcp: TcpPdu,
): boolean {
  return tcpRxSvc(ctx, node, iface, base, ip, tcp, SERVERS, mailClientHook);
}

/** Timer der Dienstschicht (Name ohne `svc:`). */
export function svcTimer(ctx: DeviceCtx, node: IpNode, name: string): void {
  if (name.startsWith('ureq:')) {
    const id = Number(name.slice(5));
    const req = appcOf(node.cfg).reqs[id];
    if (req?.status !== 'pending') return;
    req.status = 'timeout';
    ctx.log({
      kind: 'error',
      proto: 'SYS',
      status: 'error',
      msg: { key: 'svc.timeout', params: { proto: req.proto.toUpperCase(), dst: req.dst } },
    });
    if (req.proto === 'radius' && !eapDecision(ctx, node, id, undefined))
      aaaDecision(ctx, node, ctx.device, id, undefined);
    return;
  }
  connTimer(ctx, node, name, mailClientHook);
}
