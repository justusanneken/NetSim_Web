import type { DeviceCtx } from '../ctx';
import { mgmtOf } from '../p5defaults';
import type { SnmpTrapKind, SnmpTrapRec } from '../p5types';
import type { Device } from '../types';
import { ipNodeOf } from './node';
import type { SvcRx } from './services';
import { udpReply, udpRequest } from './udputil';

/** Standard-Port für Traps. */
export const SNMP_TRAP_PORT = 162;

export const TRAP_KINDS: SnmpTrapKind[] = ['linkdown', 'linkup', 'coldstart'];
const NAMES: Record<SnmpTrapKind, string> = {
  linkdown: 'linkDown',
  linkup: 'linkUp',
  coldstart: 'coldStart',
};

/**
 * Sendet einen Trap (SNMPv2c-Trap, UDP 162) an alle `snmp-server host`-Ziele, wenn der Trap-Typ
 * mit `snmp-server enable traps` freigeschaltet ist.
 */
export function snmpTrap(
  ctx: DeviceCtx,
  dev: Device,
  kind: SnmpTrapKind,
  port?: { index: number; name: string },
): void {
  const c = dev.config;
  if (c.kind !== 'router' && c.kind !== 'switch') return;
  const m = mgmtOf(c.sys).snmp;
  if (!(m.traps ?? []).includes(kind)) return;
  const hosts = m.trapHosts ?? [];
  if (hosts.length === 0) return;
  const node = ipNodeOf(ctx, dev);
  if (!node || node.ifaces.length === 0) return;
  for (const h of hosts) {
    udpRequest(ctx, node, {
      dst: h.host,
      proto: 'snmp',
      op: 'trap',
      dport: SNMP_TRAP_PORT,
      args: {
        community: h.community,
        version: h.version,
        trap: NAMES[kind],
        host: c.sys.hostname,
        uptime: Math.floor(ctx.now / 10_000),
        ...(port ? { ifIndex: port.index, ifDescr: port.name } : {}),
      },
      oneWay: true,
    });
  }
}

/** Trap-Empfänger (Server mit aktivem SNMP-Dienst): speichert gültige Traps. */
export function snmpTrapRx(r: SvcRx): boolean {
  const c = r.ctx.device.config;
  const svc = c.kind === 'host' ? c.services.snmp : undefined;
  if (!svc?.enabled) return false;
  if (!svc.communities.some((x) => x.name === r.msg.args.community)) {
    r.ctx.log({
      ...r.base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'svc.snmp.badCommunity', params: { src: r.ip.src } },
    });
    return true;
  }
  const rec: SnmpTrapRec = {
    t: r.ctx.now,
    from: r.ip.src,
    host: String(r.msg.args.host ?? ''),
    community: String(r.msg.args.community ?? ''),
    version: String(r.msg.args.version ?? '2c'),
    trap: String(r.msg.args.trap ?? ''),
    ifDescr: r.msg.args.ifDescr !== undefined ? String(r.msg.args.ifDescr) : undefined,
    ifIndex: r.msg.args.ifIndex !== undefined ? Number(r.msg.args.ifIndex) : undefined,
  };
  (svc.traps ??= []).push(rec);
  if (svc.traps.length > 200) svc.traps.shift();
  r.ctx.log({
    ...r.base,
    kind: 'rx',
    status: 'ok',
    msg: {
      key: 'svc.snmp.trap',
      params: { src: r.ip.src, trap: rec.trap, iface: rec.ifDescr ?? '' },
    },
  });
  void udpReply;
  return true;
}
