import type { DeviceCtx } from '../ctx';
import type { IotCfg, IotRule } from '../p5types';
import type { Device, HostConfig } from '../types';
import { ipNodeOf } from './node';
import type { SvcRx } from './services';
import { udpReply, udpRequest } from './udputil';

const hostOf = (d: Device): HostConfig | undefined =>
  d.config.kind === 'host' ? d.config : undefined;

/** Aktueller Messwert eines Sensors (manuell oder deterministisch über die virtuelle Zeit). */
export function iotValue(cfg: IotCfg, nowUs: number): number {
  const round = (v: number): number => Math.round(v * 10) / 10;
  const period = Math.max(1, cfg.periodSec) * 1_000_000;
  const phase = (nowUs % period) / period;
  if (cfg.pattern === 'wave') {
    const mid = (cfg.min + cfg.max) / 2;
    return round(mid + ((cfg.max - cfg.min) / 2) * Math.sin(2 * Math.PI * phase));
  }
  if (cfg.pattern === 'ramp') return round(cfg.min + (cfg.max - cfg.min) * phase);
  return cfg.value;
}

export function ruleHolds(op: IotRule['op'], value: number, threshold: number): boolean {
  switch (op) {
    case '>':
      return value > threshold;
    case '<':
      return value < threshold;
    case '>=':
      return value >= threshold;
    case '<=':
      return value <= threshold;
    case '==':
      return value === threshold;
  }
}

/** Zyklischer Timer eines IoT-Geräts: Registrierung bzw. Bericht an den IoT-Server. */
export function iotTick(ctx: DeviceCtx, dev: Device): void {
  const h = hostOf(dev);
  const iot = h?.iot;
  if (!h || !iot?.server) return;
  const node = ipNodeOf(ctx, dev);
  if (!node || node.ifaces.length === 0) return;
  const name = dev.name;
  if (!iot.registered) {
    udpRequest(ctx, node, {
      dst: iot.server,
      proto: 'iot',
      op: 'register',
      args: { name, role: iot.role, sensor: iot.sensor, unit: iot.unit },
    });
    return;
  }
  udpRequest(ctx, node, {
    dst: iot.server,
    proto: 'iot',
    op: 'report',
    args: { name, value: iotValue(iot, ctx.now), state: iot.state },
  });
}

/** IoT-Nachrichten: Server (`register`, `report`) und Geräte (`set`). */
export function iotHandler(r: SvcRx): boolean {
  const dev = r.ctx.device;
  const h = hostOf(dev);
  if (!h) return false;
  const svc = h.services.iot;
  const { msg } = r;
  if (msg.op === 'set' && h.iot) {
    const state = msg.args.state === 'on' ? 'on' : 'off';
    h.iot.state = state;
    r.ctx.log({
      ...r.base,
      kind: 'rx',
      proto: 'IOT',
      status: 'ok',
      msg: { key: 'svc.iot.set', params: { state, src: r.ip.src } },
    });
    udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, msg, 'ack', { state });
    return true;
  }
  if (!svc?.enabled) return false;
  const name = String(msg.args.name ?? '');
  if (msg.op === 'register') {
    svc.devices[name] = {
      name,
      ip: r.ip.src,
      role: msg.args.role === 'actuator' ? 'actuator' : msg.args.role === 'sbc' ? 'sbc' : 'sensor',
      unit: String(msg.args.unit ?? ''),
      lastSeen: r.ctx.now,
    };
    r.ctx.log({
      ...r.base,
      kind: 'rx',
      proto: 'IOT',
      status: 'ok',
      msg: { key: 'svc.iot.registered', params: { name, src: r.ip.src } },
    });
    udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, msg, 'registered');
    return true;
  }
  if (msg.op === 'report') {
    const d = svc.devices[name];
    if (!d) {
      udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, msg, 'unknown');
      return true;
    }
    d.ip = r.ip.src;
    d.lastSeen = r.ctx.now;
    if (d.role !== 'actuator') d.value = Number(msg.args.value);
    if (d.role !== 'sensor') d.state = msg.args.state === 'on' ? 'on' : 'off';
    udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, msg, 'ack');
    if (d.role !== 'actuator') applyRules(r, name, Number(msg.args.value));
    return true;
  }
  return false;
}

function applyRules(r: SvcRx, sensor: string, value: number): void {
  const svc = hostOf(r.ctx.device)?.services.iot;
  if (!svc) return;
  for (const rule of svc.rules.filter((x) => x.sensor === sensor)) {
    const want = ruleHolds(rule.op, value, rule.threshold) ? rule.action : rule.elseAction;
    if (want === 'none') continue;
    const act = svc.devices[rule.actuator];
    if (!act || act.state === want) continue;
    r.ctx.log({
      kind: 'info',
      proto: 'IOT',
      status: 'ok',
      msg: {
        key: 'svc.iot.rule',
        params: { sensor, value, actuator: rule.actuator, state: want },
      },
    });
    act.state = want; // optimistisch; der nächste Bericht des Aktors bestätigt
    udpRequest(r.ctx, r.node, {
      dst: act.ip,
      proto: 'iot',
      op: 'set',
      args: { state: want },
    });
  }
}
