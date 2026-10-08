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

/** Anzeigename (`GigabitEthernet0/0.10`, `Vlan10`). */
export function ifaceName(dev: Device, id: string, cfg?: IfaceCfg): string {
  const c = cfg ?? (dev.config as unknown as L3Cfg).ifaces?.[id];
  if (c?.kind === 'svi') return `Vlan${c.vlan}`;
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

/** Alle aktiven Schnittstellen mit IP-Konfiguration. */
export function listIfaces(dev: Device, cfg: L3Cfg): Iface[] {
  const out: Iface[] = [];
  const baseMac = dev.ports[0]?.mac ?? '';
  for (const [id, c] of Object.entries(cfg.ifaces)) {
    if (!c.ip || !c.mask || !ifaceUp(dev, cfg, id, c)) continue;
    const port = dev.ports.find((p) => p.id === c.portId);
    if (c.kind === 'svi') {
      out.push({
        id,
        kind: 'svi',
        portId: '',
        vlan: c.vlan,
        mac: baseMac,
        ip: c.ip,
        mask: c.mask,
        mtu: 1500,
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
