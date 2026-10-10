import { MAC_CDP, MAC_LLDP, type CdpPdu, type Frame, type LldpPdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { syslogEmit } from '../p5/syslog';
import type { Device, DiscCfg, DiscNeighbor, L3Cfg, SwitchConfig } from '../types';

/** Geräte mit CDP/LLDP: Router und Switches. */
export type DiscDev = Device & { config: L3Cfg & { kind: 'router' | 'switch' } };

export const defaultDisc = (): DiscCfg => ({
  cdpRun: true,
  cdpTimer: 60,
  cdpHold: 180,
  cdpOff: [],
  lldpRun: false,
  lldpTimer: 30,
  lldpHold: 120,
  lldpReinit: 2,
  lldpTxOff: [],
  lldpRxOff: [],
  cdp: {},
  lldp: {},
  stats: { cdpSent: 0, cdpRecv: 0, lldpSent: 0, lldpRecv: 0 },
});

export const discOf = (cfg: L3Cfg): DiscCfg => (cfg.disc ??= defaultDisc());

const isDisc = (d: Device): d is DiscDev =>
  d.config.kind === 'router' || d.config.kind === 'switch';

function hostname(dev: DiscDev): string {
  return dev.config.sys.hostname;
}

function caps(dev: DiscDev): string[] {
  if (dev.config.kind === 'router') return ['R', 'S', 'I'];
  return dev.type === 'switch-l3' ? ['R', 'S', 'I'] : ['S', 'I'];
}

function lldpCaps(dev: DiscDev): string[] {
  if (dev.config.kind === 'router') return ['R'];
  return dev.type === 'switch-l3' ? ['B', 'R'] : ['B'];
}

/** IP-Adresse, die das Gerät auf diesem Port annonciert (Router: Schnittstelle, Switch: erste SVI). */
function advAddr(dev: DiscDev, portId: string): string | undefined {
  const cfg = dev.config;
  if (cfg.kind === 'router') {
    const ic = cfg.ifaces[portId];
    return ic?.ip;
  }
  const svi = Object.entries(cfg.ifaces)
    .filter(([, c]) => c.kind === 'svi' && c.ip && !c.shutdown)
    .sort((a, b) => (a[1].vlan ?? 0) - (b[1].vlan ?? 0))[0];
  if (svi) return svi[1].ip;
  const rp = Object.entries(cfg.ifaces).find(([, c]) => c.kind === 'phys' && c.ip);
  return rp?.[1].ip;
}

export const iosVersionText = (dev: Device): string =>
  dev.type.startsWith('switch')
    ? 'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)'
    : 'Cisco IOS Software, C1900 Software (C1900-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc2)';

export function platformText(dev: Device): string {
  const sw = /^SW(\d+)-(\d+)$/.exec(dev.model);
  if (sw) return `cisco WS-C${sw[1]}-${sw[2]}${sw[1] === '3560' ? 'TS-S' : 'TT-L'}`;
  return `Cisco CISCO${dev.model.replace(/^R/, '')}/K9`;
}

function cdpFrame(dev: DiscDev, portId: string, ctx: DeviceCtx): Frame {
  const port = ctx.port(portId);
  const cfg = dev.config;
  const d = discOf(cfg);
  const pc = cfg.kind === 'switch' ? cfg.ports[portId] : undefined;
  const pdu: CdpPdu = {
    kind: 'cdp',
    deviceId: hostname(dev),
    portName: port.name,
    platform: platformText(dev),
    capabilities: caps(dev),
    version: iosVersionText(dev),
    holdtime: d.cdpHold,
    addr: advAddr(dev, portId),
    nativeVlan: pc && !pc.routed ? pc.nativeVlan : undefined,
    duplex: port.operDuplex,
  };
  return { kind: 'ethernet', dst: MAC_CDP, src: port.mac, etherType: 0x2000, payload: pdu };
}

function lldpFrame(dev: DiscDev, portId: string, ctx: DeviceCtx): Frame {
  const port = ctx.port(portId);
  const d = discOf(dev.config);
  const pdu: LldpPdu = {
    kind: 'lldp',
    chassisId: dev.ports[0]?.mac ?? '',
    portId: port.name,
    portDesc: dev.config.sys.descriptions[portId] ?? port.name,
    ttl: d.lldpHold,
    sysName: hostname(dev),
    sysDesc: iosVersionText(dev),
    capabilities: lldpCaps(dev),
    enabledCaps: lldpCaps(dev),
    mgmtAddr: advAddr(dev, portId),
  };
  return { kind: 'ethernet', dst: MAC_LLDP, src: port.mac, etherType: 0x88cc, payload: pdu };
}

function eligible(dev: DiscDev, portId: string): boolean {
  const p = dev.ports.find((x) => x.id === portId);
  return !!p && p.operUp && !p.errdisabled && p.adminUp;
}

export function discSendCdp(ctx: DeviceCtx, dev: DiscDev, only?: string): void {
  const d = discOf(dev.config);
  if (!d.cdpRun) return;
  for (const p of dev.ports) {
    if ((only && p.id !== only) || !eligible(dev, p.id) || d.cdpOff.includes(p.id)) continue;
    d.stats.cdpSent++;
    ctx.send(p.id, cdpFrame(dev, p.id, ctx), ctx.processingUs);
  }
}

export function discSendLldp(ctx: DeviceCtx, dev: DiscDev, only?: string): void {
  const d = discOf(dev.config);
  if (!d.lldpRun) return;
  for (const p of dev.ports) {
    if ((only && p.id !== only) || !eligible(dev, p.id) || d.lldpTxOff.includes(p.id)) continue;
    d.stats.lldpSent++;
    ctx.send(p.id, lldpFrame(dev, p.id, ctx), ctx.processingUs);
  }
}

/** Timer: periodische Advertisements. */
export function discTimer(ctx: DeviceCtx, dev: Device, name: string): void {
  if (!isDisc(dev)) return;
  const d = discOf(dev.config);
  if (name === 'disc:cdp') {
    discSendCdp(ctx, dev);
    ctx.setTimer('bg:disc:cdp', d.cdpTimer * 1_000_000);
  } else if (name === 'disc:lldp') {
    discSendLldp(ctx, dev);
    ctx.setTimer('bg:disc:lldp', d.lldpTimer * 1_000_000);
  } else if (name.startsWith('disc:up:')) {
    const id = name.slice(8);
    discSendCdp(ctx, dev, id);
    discSendLldp(ctx, dev, id);
  }
}

/** (Neu-)Start der Timer nach Boot oder Konfigurationsänderung. */
export function discStart(ctx: DeviceCtx, dev: Device): void {
  if (!isDisc(dev)) return;
  const d = discOf(dev.config);
  if (d.cdpRun) ctx.setTimer('bg:disc:cdp', 2_000_000);
  else ctx.cancelTimer('bg:disc:cdp');
  if (d.lldpRun) ctx.setTimer('bg:disc:lldp', 2_000_000);
  else ctx.cancelTimer('bg:disc:lldp');
}

/** Link kam hoch: kurz danach sofort ein Advertisement senden. */
export function discLinkUp(ctx: DeviceCtx, dev: Device, portId: string): void {
  if (!isDisc(dev)) return;
  ctx.setTimer(`bg:disc:up:${portId}`, 1_000_000);
}

export function discLinkDown(dev: Device, portId: string): void {
  if (!isDisc(dev)) return;
  const d = discOf(dev.config);
  for (const [k, n] of Object.entries(d.cdp)) if (n.localPortId === portId) delete d.cdp[k];
  for (const [k, n] of Object.entries(d.lldp)) if (n.localPortId === portId) delete d.lldp[k];
}

type Base = {
  from: string;
  port: ReturnType<DeviceCtx['port']>;
  frame: Frame;
  summary: string;
  proto: 'CDP' | 'LLDP';
};

/** Empfang eines CDP-/LLDP-Frames. Liefert true, wenn der Frame verbraucht wurde. */
export function discRx(
  ctx: DeviceCtx,
  dev: Device,
  portId: string,
  frame: Frame,
  fromId: string,
): boolean {
  const p = frame.payload;
  if (p.kind !== 'cdp' && p.kind !== 'lldp') return false;
  if (!isDisc(dev)) return true;
  const d = discOf(dev.config);
  const port = ctx.port(portId);
  const base = {
    from: fromId,
    port,
    frame,
    summary: p.kind === 'cdp' ? `Device ID: ${p.deviceId}` : `System Name = ${p.sysName}`,
    proto: p.kind === 'cdp' ? 'CDP' : 'LLDP',
  } as Base;
  if (p.kind === 'cdp') {
    if (!d.cdpRun || d.cdpOff.includes(portId)) return true;
    d.stats.cdpRecv++;
    const nbr: DiscNeighbor = {
      deviceId: p.deviceId,
      platform: p.platform,
      capabilities: p.capabilities,
      localPortId: portId,
      remotePort: p.portName,
      addr: p.addr,
      holdUntil: ctx.now + p.holdtime * 1_000_000,
      version: p.version,
      nativeVlan: p.nativeVlan,
      duplex: p.duplex,
      ttl: p.holdtime,
    };
    const isNew = !d.cdp[`${portId}|${p.deviceId}`];
    d.cdp[`${portId}|${p.deviceId}`] = nbr;
    if (isNew)
      ctx.log({
        ...base,
        kind: 'info',
        status: 'ok',
        msg: {
          key: 'cdp.neighbor',
          params: { dev: p.deviceId, port: port.name, rport: p.portName },
        },
      });
    if (dev.config.kind === 'switch')
      mismatch(ctx, dev as DiscDev & { config: SwitchConfig }, portId, p);
    return true;
  }
  if (!d.lldpRun || d.lldpRxOff.includes(portId)) return true;
  d.stats.lldpRecv++;
  const key = `${portId}|${p.chassisId}`;
  const isNew = !d.lldp[key];
  d.lldp[key] = {
    deviceId: p.sysName,
    platform: '',
    capabilities: p.capabilities,
    localPortId: portId,
    remotePort: p.portId,
    addr: p.mgmtAddr,
    holdUntil: ctx.now + p.ttl * 1_000_000,
    version: '',
    chassisId: p.chassisId,
    sysDesc: p.sysDesc,
    ttl: p.ttl,
  };
  if (isNew)
    ctx.log({
      ...base,
      kind: 'info',
      status: 'ok',
      msg: { key: 'lldp.neighbor', params: { dev: p.sysName, port: port.name, rport: p.portId } },
    });
  return true;
}

function mismatch(
  ctx: DeviceCtx,
  dev: DiscDev & { config: SwitchConfig },
  portId: string,
  p: CdpPdu,
): void {
  const cfg = dev.config;
  const pc = cfg.ports[portId];
  if (!pc || pc.routed || !cfg.operTrunk[portId] || p.nativeVlan === undefined) return;
  if (p.nativeVlan === pc.nativeVlan) return;
  const port = ctx.port(portId);
  syslogEmit(
    ctx,
    dev,
    4,
    'CDP-4-NATIVE_VLAN_MISMATCH',
    `Native VLAN mismatch discovered on ${port.name} (${pc.nativeVlan}), with ${p.deviceId} ${p.portName} (${p.nativeVlan}).`,
  );
  ctx.log({
    kind: 'error',
    proto: 'CDP',
    status: 'error',
    port,
    msg: {
      key: 'cdp.nativeMismatch',
      params: {
        port: port.name,
        mine: pc.nativeVlan,
        dev: p.deviceId,
        rport: p.portName,
        theirs: p.nativeVlan,
      },
    },
  });
}

/** Aktuell gültige Nachbarn (Hold-Time nicht abgelaufen), sortiert nach lokalem Port. */
export function liveNeighbors(dev: Device, now: number, proto: 'cdp' | 'lldp'): DiscNeighbor[] {
  if (!isDisc(dev)) return [];
  const d = discOf(dev.config);
  return Object.values(d[proto])
    .filter((n) => n.holdUntil > now)
    .sort(
      (a, b) =>
        dev.ports.findIndex((x) => x.id === a.localPortId) -
          dev.ports.findIndex((x) => x.id === b.localPortId) ||
        a.deviceId.localeCompare(b.deviceId),
    );
}
