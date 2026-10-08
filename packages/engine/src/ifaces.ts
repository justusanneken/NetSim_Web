import type { Ipv4Addr } from '@netsim/protocols';
import type { Device, IfaceCfg, L3Cfg, SwitchConfig } from './types';

/** Laufzeitsicht einer aktiven L3-Schnittstelle. */
export interface Iface {
  id: string;
  kind: IfaceCfg['kind'];
  portId: string;
  vlan?: number;
  mac: string;
  ip: Ipv4Addr;
  mask: string;
  mtu: number;
  cfg: IfaceCfg;
}

export const subId = (portId: string, vlan: number): string => `${portId}.${vlan}`;
export const sviId = (vlan: number): string => `vlan${vlan}`;
export const loopId = (n: number): string => `lo${n}`;
export const tunnelId = (n: number): string => `tu${n}`;
/** Virtuelle Schnittstelle ohne physischen Port (Loopback, Tunnel, SVI). */
export const isVirtualIface = (kind: IfaceCfg['kind']): boolean =>
  kind === 'svi' || kind === 'loop' || kind === 'tunnel';

/** Anzeigename (`GigabitEthernet0/0.10`, `Vlan10`). */
export function ifaceName(dev: Device, id: string, cfg?: IfaceCfg): string {
  const c = cfg ?? (dev.config as unknown as L3Cfg).ifaces?.[id];
  if (c?.kind === 'svi') return `Vlan${c.vlan}`;
  if (c?.kind === 'loop') return `Loopback${id.slice(2)}`;
  if (c?.kind === 'tunnel') return `Tunnel${id.slice(2)}`;
  if (c?.kind === 'sub') {
    const port = dev.ports.find((p) => p.id === c.portId);
    return `${port?.name ?? id}.${c.vlan}`;
  }
  return dev.ports.find((p) => p.id === id)?.name ?? id;
}

/** Trägt ein Port-VLAN-Datenverkehr (aktiv und up)? */
export function vlanActive(cfg: SwitchConfig, dev: Device, vlan: number): boolean {
  if (!cfg.vlans[vlan]) return false;
  return dev.ports.some((p) => {
    const pc = cfg.ports[p.id];
    if (!pc || pc.routed || !p.operUp) return false;
    if (cfg.operTrunk[p.id]) return pc.allowed === 'all' || pc.allowed.includes(vlan);
    return pc.accessVlan === vlan;
  });
}

/** Ob die Schnittstelle (unabhängig von der IP) betriebsbereit ist. */
export function ifaceUp(dev: Device, cfg: L3Cfg, id: string, c: IfaceCfg): boolean {
  if (c.kind === 'loop') return !c.shutdown;
  if (c.kind === 'tunnel') return !c.shutdown && tunnelUp(dev, cfg, c);
  if (c.kind === 'svi') {
    const sw = dev.config.kind === 'switch' ? dev.config : undefined;
    return !!sw && !c.shutdown && vlanActive(sw, dev, c.vlan ?? 0);
  }
  const port = dev.ports.find((p) => p.id === c.portId);
  if (!port || !port.operUp) return false;
  if (c.kind === 'sub') return !c.shutdown;
  if (dev.config.kind === 'switch') return dev.config.ports[port.id]?.routed === true;
  void cfg;
  void id;
  return true;
}

/** Tunnel ist up, wenn Quelle konfiguriert/aktiv ist und ein Ziel gesetzt wurde (Ziel-Erreichbarkeit prüft das Senden). */
function tunnelUp(dev: Device, cfg: L3Cfg, c: IfaceCfg): boolean {
  const t = c.tunnel;
  if (!t?.source || !t.destination) return false;
  const src = t.source;
  const ifc = cfg.ifaces[src];
  if (ifc) return !ifc.shutdown && ifaceUp(dev, cfg, src, ifc) && !!ifc.ip;
  return Object.entries(cfg.ifaces).some(
    ([id, x]) => x.ip === src && ifaceUp(dev, cfg, id, x) && id !== undefined,
  );
}

/** Alle aktiven Schnittstellen mit IP-Konfiguration. */
export function listIfaces(dev: Device, cfg: L3Cfg): Iface[] {
  const out: Iface[] = [];
  const baseMac = dev.ports[0]?.mac ?? '';
  for (const [id, c] of Object.entries(cfg.ifaces)) {
    if (!c.ip || !c.mask || !ifaceUp(dev, cfg, id, c)) continue;
    const port = dev.ports.find((p) => p.id === c.portId);
    if (isVirtualIface(c.kind)) {
      out.push({
        id,
        kind: c.kind,
        portId: '',
        vlan: c.kind === 'svi' ? c.vlan : undefined,
        mac: baseMac,
        ip: c.ip,
        mask: c.mask,
        mtu: c.kind === 'tunnel' ? 1476 : 1500,
        cfg: c,
      });
    } else if (port) {
      out.push({
        id,
        kind: c.kind,
        portId: port.id,
        vlan: c.kind === 'sub' ? c.vlan : undefined,
        mac: port.mac,
        ip: c.ip,
        mask: c.mask,
        mtu: port.mtu,
        cfg: c,
      });
    }
  }
  return out;
}
