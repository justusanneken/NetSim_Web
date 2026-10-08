import type { Ipv4Pdu, SvcPdu, UdpPdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Iface } from '../ifaces';
import type { Base, IpNode } from '../l3';
import { mgmtOf } from '../p5defaults';
import type { Device } from '../types';
import { deviceTimeMs, setDeviceTime, clockOf } from './clock';
import { ipNodeOf } from './node';
import { buildMib, mibNext, mibWalk, oidFromName, type Varbind } from './snmp';
import { udpReply, udpRequest } from './udputil';
import { appcOf } from './node';

/** Kontext einer eingehenden Dienstnachricht. */
export interface SvcRx {
  ctx: DeviceCtx;
  node: IpNode;
  iface: Iface;
  base: Base;
  ip: Ipv4Pdu;
  udp: UdpPdu;
  msg: SvcPdu;
}

const logRx = (
  r: SvcRx,
  key: string,
  params: Record<string, string | number> = {},
  status: 'ok' | 'drop' | 'info' = 'ok',
): void =>
  r.ctx.log({
    ...r.base,
    kind: status === 'drop' ? 'drop' : 'rx',
    status,
    msg: { key, params },
  });

const hostCfg = (d: Device) => (d.config.kind === 'host' ? d.config : undefined);

// ---------------------------------------------------------------- TFTP

export function tftpServer(r: SvcRx): boolean {
  const svc = hostCfg(r.ctx.device)?.services.tftp;
  if (!svc?.enabled) return false;
  const file = String(r.msg.args.file ?? '');
  if (r.msg.op === 'wrq') {
    svc.files[file] = r.msg.body ?? '';
    logRx(r, 'svc.tftp.write', { file, bytes: (r.msg.body ?? '').length, src: r.ip.src });
    udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, r.msg, 'ack');
    return true;
  }
  if (r.msg.op === 'rrq') {
    const data = svc.files[file];
    logRx(
      r,
      data === undefined ? 'svc.tftp.notFound' : 'svc.tftp.read',
      {
        file,
        src: r.ip.src,
      },
      data === undefined ? 'drop' : 'ok',
    );
    if (data === undefined)
      udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, r.msg, 'error', {
        code: 1,
        text: 'File not found',
      });
    else udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, r.msg, 'data', { file }, data);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- NTP

/** Stratum, mit dem dieses Gerät als NTP-Server auftritt (`undefined` = kein Server). */
export function ntpServerStratum(dev: Device): number | undefined {
  const c = dev.config;
  if (c.kind === 'host') return c.services.ntp?.enabled ? 1 : undefined;
  if (c.kind === 'router' || c.kind === 'switch') return mgmtOf(c.sys).ntp.master;
  return undefined;
}

export function ntpServer(r: SvcRx): boolean {
  const dev = r.ctx.device;
  const st = ntpServerStratum(dev);
  if (st === undefined || r.msg.op !== 'request') return false;
  logRx(r, 'svc.ntp.request', { src: r.ip.src });
  udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, r.msg, 'response', {
    epoch: deviceTimeMs(dev, r.ctx.now),
    stratum: st,
  });
  return true;
}

/** Konfigurierte NTP-Server des Geräts. */
export function ntpServersOf(dev: Device): string[] {
  const c = dev.config;
  if (c.kind === 'host') return c.ntpServer ? [c.ntpServer] : [];
  if (c.kind === 'router' || c.kind === 'switch') return mgmtOf(c.sys).ntp.servers;
  return [];
}

/** Ein NTP-Abfragezyklus (Timer `ntp`). */
export function ntpPoll(ctx: DeviceCtx, dev: Device): void {
  const node = ipNodeOf(ctx, dev);
  if (!node) return;
  for (const s of ntpServersOf(dev)) udpRequest(ctx, node, { dst: s, proto: 'ntp', op: 'request' });
}

function ntpReply(ctx: DeviceCtx, dev: Device, server: string, msg: SvcPdu): void {
  const epoch = Number(msg.args.epoch);
  const stratum = Number(msg.args.stratum);
  const clock = clockOf(dev);
  if (!clock || !Number.isFinite(epoch)) return;
  // Mit dem bereits gewählten Server bleiben (nur wechseln, wenn noch keiner gewählt ist)
  if (clock.syncedTo !== undefined && clock.syncedTo !== server && clock.stratum <= stratum + 1)
    return;
  setDeviceTime(dev, ctx.now, epoch);
  clock.syncedTo = server;
  clock.stratum = stratum + 1;
  clock.lastSyncUs = ctx.now;
  ctx.log({
    kind: 'info',
    proto: 'NTP',
    status: 'ok',
    msg: { key: 'svc.ntp.synced', params: { server, stratum: clock.stratum } },
  });
}

// ---------------------------------------------------------------- Syslog

export function syslogServer(r: SvcRx): boolean {
  const svc = hostCfg(r.ctx.device)?.services.syslog;
  if (!svc?.enabled || r.msg.op !== 'msg') return false;
  svc.messages.push({
    t: r.ctx.now,
    from: r.ip.src,
    host: String(r.msg.args.host ?? ''),
    severity: Number(r.msg.args.sev ?? 6),
    text: r.msg.body ?? '',
  });
  if (svc.messages.length > 500) svc.messages.shift();
  logRx(r, 'svc.syslog.rx', { src: r.ip.src, text: r.msg.body ?? '' });
  return true;
}

// ---------------------------------------------------------------- SNMP

type Agent = {
  name: string;
  communities: { name: string; rw: boolean }[];
  location?: string;
  contact?: string;
};

function agentOf(dev: Device): Agent | undefined {
  const c = dev.config;
  if (c.kind === 'host') {
    const s = c.services.snmp;
    return s?.enabled
      ? { name: dev.name, communities: s.communities, location: s.location, contact: s.contact }
      : undefined;
  }
  if (c.kind === 'router' || c.kind === 'switch') {
    const m = mgmtOf(c.sys);
    return m.snmp.communities.length
      ? {
          name: c.sys.hostname,
          communities: m.snmp.communities,
          location: m.snmp.location,
          contact: m.snmp.contact,
        }
      : undefined;
  }
  return undefined;
}

export function snmpAgent(r: SvcRx): boolean {
  const dev = r.ctx.device;
  const agent = agentOf(dev);
  if (!agent) return false;
  const reply = (status: string, vbs: Varbind[] = []): void =>
    udpReply(
      r.ctx,
      r.node,
      r.iface,
      r.ip,
      r.udp,
      r.msg,
      'response',
      { status },
      JSON.stringify(vbs),
    );
  const comm = agent.communities.find((c) => c.name === r.msg.args.community);
  if (!comm) {
    logRx(r, 'svc.snmp.badCommunity', { src: r.ip.src }, 'drop');
    return true; // SNMP antwortet bei falscher Community nicht
  }
  const mib = buildMib(dev, agent, r.ctx.now);
  const oid = oidFromName(String(r.msg.args.oid ?? ''));
  logRx(r, 'svc.snmp.request', { op: r.msg.op, oid, src: r.ip.src });
  switch (r.msg.op) {
    case 'get': {
      const vbs = oid
        .split(',')
        .map((o): Varbind | undefined => mib.find(([x]) => x === oidFromName(o)));
      if (vbs.some((v) => !v)) reply('noSuchName');
      else reply('ok', vbs as Varbind[]);
      break;
    }
    case 'getnext': {
      const n = mibNext(mib, oid);
      if (n) reply('ok', [n]);
      else reply('endOfMib');
      break;
    }
    case 'walk': {
      const w = mibWalk(mib, oid);
      if (w.length) reply('ok', w);
      else reply('noSuchName');
      break;
    }
    case 'set': {
      if (!comm.rw) {
        reply('readOnly');
        break;
      }
      const value = String(r.msg.args.value ?? '');
      const c = dev.config;
      if (oid === '1.3.6.1.2.1.1.5.0') {
        if (c.kind === 'router' || c.kind === 'switch') c.sys.hostname = value;
        dev.name = value;
        reply('ok', [[oid, value]]);
      } else {
        const m = /^1\.3\.6\.1\.2\.1\.2\.2\.1\.7\.(\d+)$/.exec(oid);
        const port = m ? dev.ports[Number(m[1]) - 1] : undefined;
        if (port) {
          port.adminUp = value === '1' || value === 'up';
          r.ctx.requestRefresh();
          reply('ok', [[oid, port.adminUp ? 1 : 2]]);
        } else reply('notWritable');
      }
      break;
    }
    default:
      return false;
  }
  return true;
}

// ---------------------------------------------------------------- RADIUS (Server)

export function radiusServer(r: SvcRx): boolean {
  const svc = hostCfg(r.ctx.device)?.services.aaa;
  if (!svc?.enabled || r.msg.op !== 'access-request') return false;
  const client = svc.clients.find((c) => c.ip === r.ip.src);
  if (!client || client.secret !== r.msg.args.secret) {
    logRx(r, 'svc.aaa.badClient', { src: r.ip.src }, 'drop');
    return true; // unbekannte Clients werden stillschweigend ignoriert
  }
  const user = String(r.msg.args.user ?? '');
  const ok = svc.users.some((u) => u.user === user && u.pass === r.msg.args.pass);
  logRx(r, ok ? 'svc.aaa.accept' : 'svc.aaa.reject', { user, src: r.ip.src }, ok ? 'ok' : 'drop');
  udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, r.msg, ok ? 'access-accept' : 'access-reject');
  return true;
}

// ---------------------------------------------------------------- Client-Antworten

/** Wird von `dispatch` aufgerufen, wenn eine Antwort (`args.reply`) eintrifft. */
export function onUdpReply(
  r: SvcRx,
  after: (r: SvcRx, req: { op: string; dst: string }) => void,
): boolean {
  const core = appcOf(r.node.cfg);
  const id = Number(r.msg.args.rid);
  const req = core.reqs[id];
  if (!req || req.status !== 'pending') return false;
  req.status = 'done';
  req.reply = r.msg;
  r.ctx.cancelTimer(`svc:ureq:${id}`);
  logRx(r, 'svc.reply', { proto: r.msg.proto.toUpperCase(), op: r.msg.op });
  if (r.msg.proto === 'ntp' && r.msg.op === 'response')
    ntpReply(r.ctx, r.ctx.device, req.dst, r.msg);
  after(r, req);
  return true;
}
