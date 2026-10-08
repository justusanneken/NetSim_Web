import {
  MAC_PVST,
  MAC_STP,
  MAC_VTP,
  isBroadcastMac,
  isMulticastMac,
  summarizeFrame,
  type Frame,
} from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { ifaceFrameRx } from '../l3';
import {
  stpPortDown,
  stpRx,
  stpTick,
  stpHello,
  stpPortsChanged,
  stpForwarding,
  stpLearning,
} from './stp';
import { vtpRx, vtpTimer } from './vtp';
import { l3Node } from './l3dev';
import type { Device, MacEntry, SwitchConfig, SwitchPortCfg } from '../types';

export type SwitchDev = Device & { config: SwitchConfig };

// ------------------------------------------------------------------ Hilfen

/** Logischer Port: Port-Channel (`po1`) bei gebündelten Mitgliedern, sonst der Port selbst. */
export function lpOf(cfg: SwitchConfig, portId: string): string {
  const n = cfg.ports[portId]?.channel;
  return n !== undefined && cfg.bundles[n]?.includes(portId) ? `po${n}` : portId;
}

export function lpMembers(cfg: SwitchConfig, lp: string): string[] {
  if (lp.startsWith('po')) return cfg.bundles[Number(lp.slice(2))] ?? [];
  return [lp];
}

/** Alle logischen Ports (up, nicht routed, nicht err-disabled). */
export function logicalPorts(dev: SwitchDev): string[] {
  const out = new Set<string>();
  for (const p of dev.ports) {
    const pc = dev.config.ports[p.id];
    if (!pc || pc.routed || !p.operUp) continue;
    out.add(lpOf(dev.config, p.id));
  }
  return [...out];
}

export const isTrunk = (cfg: SwitchConfig, portId: string): boolean =>
  cfg.operTrunk[portId] === true;

/** Trägt der (logische) Port dieses VLAN? Access: Zugangs-VLAN; Trunk: Allowed-Liste. */
export function carriesVlan(cfg: SwitchConfig, lp: string, vlan: number): boolean {
  const first = lpMembers(cfg, lp)[0];
  const pc = first ? cfg.ports[first] : undefined;
  if (!pc || !cfg.vlans[vlan]) return false;
  if (isTrunk(cfg, first as string)) return pc.allowed === 'all' || pc.allowed.includes(vlan);
  return pc.accessVlan === vlan;
}

const macKey = (vlan: number, mac: string): string => `${vlan}|${mac}`;

export function activeMacTable(
  cfg: SwitchConfig,
  now: number,
): { mac: string; vlan: number; portId: string; ageSec: number }[] {
  return Object.entries(cfg.macTable)
    .filter(([, e]) => now - e.updatedAt <= cfg.agingSec * 1_000_000)
    .map(([k, e]) => ({
      mac: k.split('|')[1] as string,
      vlan: e.vlan,
      portId: e.portId,
      ageSec: Math.floor((now - e.updatedAt) / 1e6),
    }))
    .sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
}

export function flushMacs(cfg: SwitchConfig, filter: { vlan?: number; lp?: string } = {}): void {
  for (const [k, e] of Object.entries(cfg.macTable)) {
    if (
      (filter.vlan === undefined || e.vlan === filter.vlan) &&
      (filter.lp === undefined || e.portId === filter.lp)
    ) {
      delete cfg.macTable[k];
    }
  }
}

/** Port ist ausgefallen: dynamische MACs, STP-Zustand und sichere MACs bereinigen. */
export function switchPortDown(ctx: DeviceCtx | undefined, dev: SwitchDev, portId: string): void {
  const cfg = dev.config;
  const lp = lpOf(cfg, portId);
  flushMacs(cfg, { lp });
  const pc = cfg.ports[portId];
  if (pc) pc.psec.dynMacs = [];
  if (ctx) stpPortDown(ctx, dev, lp);
}

// ------------------------------------------------------------------ Ausgabe

/** Frame aus einem logischen Port senden (Tagging, Bundle-Hash). */
function output(
  ctx: DeviceCtx,
  dev: SwitchDev,
  lp: string,
  vlan: number,
  frame: Frame,
  delay = ctx.processingUs,
): void {
  const cfg = dev.config;
  const members = lpMembers(cfg, lp).filter((id) => dev.ports.find((p) => p.id === id)?.operUp);
  if (members.length === 0) return;
  let idx = 0;
  if (members.length > 1) {
    let h = 0;
    for (const ch of frame.src + frame.dst) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    idx = h % members.length;
  }
  const portId = members[idx] as string;
  const pc = cfg.ports[portId] as SwitchPortCfg;
  const tagged = isTrunk(cfg, portId) && vlan !== pc.nativeVlan;
  const out: Frame = tagged
    ? { ...frame, vlan: { vid: vlan, pcp: frame.vlan?.pcp ?? 0 } }
    : { ...frame, vlan: undefined };
  ctx.send(portId, out, delay);
}

export { output as switchOutput };

function floodTargets(dev: SwitchDev, vlan: number, exceptLp?: string): string[] {
  return logicalPorts(dev).filter(
    (lp) =>
      lp !== exceptLp && carriesVlan(dev.config, lp, vlan) && stpForwarding(dev.config, vlan, lp),
  );
}

/** Von der SVI (CPU) erzeugter Frame: wie ein Frame ohne Eingangsport weiterleiten. */
export function switchOriginate(ctx: DeviceCtx, dev: SwitchDev, vlan: number, frame: Frame): void {
  const cfg = dev.config;
  const e = !isMulticastMac(frame.dst) ? cfg.macTable[macKey(vlan, frame.dst)] : undefined;
  if (e && ctx.now - e.updatedAt <= cfg.agingSec * 1_000_000) {
    if (stpForwarding(cfg, vlan, e.portId)) output(ctx, dev, e.portId, vlan, frame);
    return;
  }
  for (const lp of floodTargets(dev, vlan)) output(ctx, dev, lp, vlan, frame);
}

// ------------------------------------------------------------------ Eingang

export function switchRx(
  ctx: DeviceCtx,
  dev: SwitchDev,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  const cfg = dev.config;
  const port = ctx.port(portId);
  const pc = cfg.ports[portId];
  const { proto, info } = summarizeFrame(frame);
  const base = { from: fromId, port, frame, summary: info, proto } as const;
  if (!pc) return;

  // Routed Port (L3-Switch): wie ein Routerport behandeln
  if (pc.routed) {
    const node = l3Node(ctx, dev);
    const iface = node.ifaces.find((i) => i.portId === portId && i.kind === 'phys');
    if (iface) ifaceFrameRx(ctx, node, iface, frame, fromId, port);
    return;
  }

  // 1) VLAN-Zuordnung
  const trunk = isTrunk(cfg, portId);
  let vlan: number;
  if (trunk) {
    vlan = frame.vlan?.vid ?? pc.nativeVlan;
    if (pc.allowed !== 'all' && !pc.allowed.includes(vlan)) {
      ctx.log({
        ...base,
        kind: 'drop',
        status: 'drop',
        msg: { key: 'switch.vlanNotAllowed', params: { vlan, port: port.name } },
      });
      return;
    }
  } else {
    if (frame.vlan && frame.vlan.vid !== pc.accessVlan) {
      ctx.log({
        ...base,
        kind: 'drop',
        status: 'drop',
        msg: { key: 'switch.taggedOnAccess', params: { port: port.name } },
      });
      return;
    }
    vlan = pc.accessVlan;
  }
  const lp = lpOf(cfg, portId);

  // 2) Steuerprotokolle (werden nicht weitergeleitet)
  const p = frame.payload;
  if (p.kind === 'bpdu') {
    stpRx(ctx, dev, portId, lp, vlan, p, base);
    return;
  }
  if (p.kind === 'vtp') {
    if (trunk) vtpRx(ctx, dev, portId, p, base);
    return;
  }
  if (frame.dst === MAC_STP || frame.dst === MAC_PVST || frame.dst === MAC_VTP) return;
  if (!cfg.vlans[vlan]) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'switch.noVlan', params: { vlan } },
    });
    return;
  }

  // 3) STP-Zustand
  const learning = stpLearning(cfg, vlan, lp);
  const forwarding = stpForwarding(cfg, vlan, lp);
  if (!learning && !forwarding) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'switch.stpBlocked', params: { port: port.name, vlan } },
    });
    return;
  }

  // 4) Port-Security (nur Access)
  if (
    !trunk &&
    pc.psec.enabled &&
    !isMulticastMac(frame.src) &&
    !securityAllows(ctx, dev, portId, frame.src, base)
  )
    return;

  // 5) Lernen
  let learned = false;
  if (!isMulticastMac(frame.src)) {
    const k = macKey(vlan, frame.src);
    const prev = cfg.macTable[k];
    learned = !prev || prev.portId !== lp;
    cfg.macTable[k] = { portId: lp, vlan, updatedAt: ctx.now } satisfies MacEntry;
  }
  if (!forwarding) return; // Learning-Zustand: nur lernen

  const suffix = learned ? '.learned' : '';
  const params = { src: frame.src, port: port.name, vlan };

  // 6) L3-Anbindung (SVI)
  const sviCfg = cfg.ifaces[`vlan${vlan}`];
  if (
    sviCfg?.ip &&
    (frame.dst === dev.ports[0]?.mac || isBroadcastMac(frame.dst) || isMulticastMac(frame.dst))
  ) {
    const node = l3Node(ctx, dev);
    const svi = node.ifaces.find((i) => i.kind === 'svi' && i.vlan === vlan);
    if (svi) {
      ifaceFrameRx(ctx, node, svi, { ...frame, vlan: undefined }, fromId, port);
      if (frame.dst === svi.mac) return;
    }
  }

  // 7) Weiterleiten
  let out: string | undefined;
  if (!isMulticastMac(frame.dst)) {
    const k = macKey(vlan, frame.dst);
    const e = cfg.macTable[k];
    if (e) {
      if (ctx.now - e.updatedAt <= cfg.agingSec * 1_000_000) out = e.portId;
      else delete cfg.macTable[k];
    }
  }
  if (out !== undefined) {
    if (out === lp) {
      ctx.log({
        ...base,
        kind: 'drop',
        status: 'drop',
        msg: { key: 'switch.filter' + suffix, params },
      });
      return;
    }
    if (!stpForwarding(cfg, vlan, out)) {
      ctx.log({ ...base, kind: 'drop', status: 'drop', msg: { key: 'switch.outDown', params } });
      return;
    }
    const outPort = lpMembers(cfg, out)[0];
    ctx.log({
      ...base,
      kind: 'rx',
      status: 'ok',
      msg: {
        key: 'switch.unicast' + suffix,
        params: {
          ...params,
          dst: frame.dst,
          out: out.startsWith('po')
            ? `Po${out.slice(2)}`
            : (dev.ports.find((x) => x.id === outPort)?.name ?? out),
        },
      },
    });
    output(ctx, dev, out, vlan, frame);
    return;
  }
  const targets = floodTargets(dev, vlan, lp);
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'switch.flood' + suffix, params: { ...params, count: targets.length } },
  });
  for (const t of targets) output(ctx, dev, t, vlan, frame);
}

// ------------------------------------------------------------------ Port-Security

export function errdisable(ctx: DeviceCtx, dev: SwitchDev, portId: string, reason: string): void {
  const port = ctx.port(portId);
  port.errdisabled = reason;
  port.operUp = false;
  switchPortDown(ctx, dev, portId);
  ctx.log({
    kind: 'error',
    proto: 'LINK',
    status: 'error',
    port,
    msg: { key: 'switch.errdisable', params: { port: port.name, reason } },
  });
  ctx.requestRefresh();
  const rec = dev.config.errdisableRecovery;
  if (reason === 'psecure-violation' && rec.psecure)
    ctx.setTimer(`errdisable:${portId}`, rec.intervalSec * 1_000_000);
}

function securityAllows(
  ctx: DeviceCtx,
  dev: SwitchDev,
  portId: string,
  src: string,
  base: {
    from: string;
    port: ReturnType<DeviceCtx['port']>;
    frame: Frame;
    summary: string;
    proto: ReturnType<typeof summarizeFrame>['proto'];
  },
): boolean {
  const ps = (dev.config.ports[portId] as SwitchPortCfg).psec;
  if (ps.macs.includes(src) || ps.dynMacs.includes(src)) return true;
  if (ps.macs.length + ps.dynMacs.length < ps.max) {
    if (ps.sticky) ps.macs.push(src);
    else ps.dynMacs.push(src);
    return true;
  }
  ps.violations++;
  ps.lastMac = src;
  const key = `switch.psec.${ps.violation}`;
  if (ps.violation !== 'protect') {
    ctx.log({
      ...base,
      kind: 'error',
      status: 'drop',
      msg: { key, params: { mac: src, port: base.port.name } },
    });
  }
  if (ps.violation === 'shutdown') errdisable(ctx, dev, portId, 'psecure-violation');
  return false;
}

// ------------------------------------------------------------------ Timer

export function switchTimer(ctx: DeviceCtx, dev: SwitchDev, name: string): void {
  if (name === 'stp:hello') stpHello(ctx, dev);
  else if (name === 'stp:tick') stpTick(ctx, dev);
  else if (name === 'vtp:periodic' || name.startsWith('vtp:')) vtpTimer(ctx, dev, name);
  else if (name.startsWith('errdisable:')) {
    const port = dev.ports.find((p) => p.id === name.slice(11));
    if (port?.errdisabled) {
      delete port.errdisabled;
      ctx.log({
        kind: 'info',
        proto: 'LINK',
        status: 'info',
        port,
        msg: { key: 'switch.errdisableRecovered', params: { port: port.name } },
      });
      ctx.requestRefresh();
    }
  }
}

/** Startet die Hintergrund-Timer (STP, VTP). */
export function switchStart(ctx: DeviceCtx, dev: SwitchDev): void {
  void dev;
  ctx.setTimer('bg:stp:hello', 2_000_000, 2_000_000);
  ctx.setTimer('bg:stp:tick', 1_000_000, 1_000_000);
  ctx.setTimer('bg:vtp:periodic', 300_000_000, 300_000_000);
}

export { stpPortsChanged };
