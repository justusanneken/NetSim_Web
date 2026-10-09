import type { Ipv4Addr, Ipv4Pdu, SvcPdu, SvcProto, UdpPdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { sendUdp, type IpNode } from '../l3';
import type { Iface } from '../ifaces';
import { appcOf } from './node';
import { nextEphemeral } from '../ports';

export const UDP_TIMEOUT_US = 5_000_000;

/** Reservierte UDP-Ports der Dienste. */
export const SVC_UDP_PORT: Partial<Record<SvcProto, number>> = {
  tftp: 69,
  ntp: 123,
  snmp: 161,
  syslog: 514,
  radius: 1812,
  iot: 5683,
  capwap: 5246,
};

export interface UdpRequestOpts {
  dst: Ipv4Addr;
  proto: SvcProto;
  op: string;
  args?: SvcPdu['args'];
  body?: string;
  /** Standard: reservierter Port des Protokolls. */
  dport?: number;
  /** Ohne Antwort erwartet (Syslog). */
  oneWay?: boolean;
  /** Abweichendes Timeout (µs). */
  timeoutUs?: number;
}

/** Sendet eine Dienstanfrage per UDP und registriert sie (Antwort/Timeout füllen `appc.reqs[id]`). */
export function udpRequest(
  ctx: DeviceCtx,
  node: IpNode,
  o: UdpRequestOpts,
): { ok: true; id: number } | { ok: false; error: string } {
  const core = appcOf(node.cfg);
  // alte Anfragen aufräumen (auch fehlgeschlagene, z. B. Syslog an einen unerreichbaren Host)
  const ids = Object.keys(core.reqs).map(Number);
  if (ids.length >= 60) for (const old of ids.slice(0, ids.length - 59)) delete core.reqs[old];
  const id = core.nextReq++;
  const msg: SvcPdu = {
    kind: 'svc',
    proto: o.proto,
    op: o.op,
    args: { ...o.args, rid: id },
    body: o.body,
  };
  const dport = o.dport ?? SVC_UDP_PORT[o.proto] ?? 0;
  const sport = nextEphemeral(core);
  const r = sendUdp(ctx, node, { dst: o.dst, sport, dport, app: msg });
  if (!r.ok) {
    core.reqs[id] = { id, proto: o.proto, op: o.op, dst: o.dst, status: 'failed', sentAt: ctx.now };
    return { ok: false, error: 'conn.unreachable' };
  }
  if (o.oneWay) return { ok: true, id };
  core.reqs[id] = { id, proto: o.proto, op: o.op, dst: o.dst, status: 'pending', sentAt: ctx.now };
  ctx.setTimer(`svc:ureq:${id}`, o.timeoutUs ?? UDP_TIMEOUT_US);
  return { ok: true, id };
}

/** Antwort an den Absender einer UDP-Dienstanfrage. */
export function udpReply(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  ip: Ipv4Pdu,
  udp: UdpPdu,
  req: SvcPdu,
  op: string,
  args: SvcPdu['args'] = {},
  body?: string,
): void {
  const msg: SvcPdu = {
    kind: 'svc',
    proto: req.proto,
    op,
    args: { ...args, rid: req.args.rid ?? 0, reply: true },
    body,
  };
  sendUdp(ctx, node, {
    src: iface.ip,
    dst: ip.src,
    sport: udp.dstPort,
    dport: udp.srcPort,
    app: msg,
  });
}
