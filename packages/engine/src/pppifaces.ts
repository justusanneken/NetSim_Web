import type { Iface } from './ifaces';
import type { Device, IfaceCfg, L3Cfg } from './types';

/** PPPoE-MTU (Ethernet 1500 − 8 Byte PPPoE/PPP). */
export const PPPOE_MTU = 1492;

/**
 * Aktive PPPoE-Schnittstellen: Dialer (Client) und Virtual-Access (Server) existieren als IP-Schnittstelle
 * nur, solange die Sitzung steht. Adresse und Gegenstelle stammen aus der IPCP-Aushandlung.
 */
export function pppIfaces(dev: Device, cfg: L3Cfg): Iface[] {
  const out: Iface[] = [];
  for (const s of Object.values(cfg.ppp?.sessions ?? {})) {
    if (s.state !== 'up' || !s.localIp) continue;
    const port = dev.ports.find((p) => p.id === s.portId);
    if (!port?.operUp) continue;
    const c: IfaceCfg = cfg.ifaces[s.ifaceId] ?? {
      kind: s.role === 'client' ? 'dialer' : 'vaccess',
    };
    if (c.shutdown) continue;
    out.push({
      id: s.ifaceId,
      kind: s.role === 'client' ? 'dialer' : 'vaccess',
      portId: s.portId,
      mac: port.mac,
      ip: s.localIp,
      mask: '255.255.255.255',
      mtu: PPPOE_MTU,
      cfg: c,
      peerIp: s.peerIp,
    });
  }
  return out;
}
