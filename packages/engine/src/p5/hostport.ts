import type { Device, Port } from '../types';

/** Datenports eines Hosts (kein Console/USB). */
const isData = (p: Port): boolean => p.kind === 'fe' || p.kind === 'ge' || p.kind === 'wifi';

/**
 * Port, über den der IP-Stack eines Hosts arbeitet: Access Points/WLC immer der erste (kabelgebundene)
 * Port, sonst der erste aktive Datenport (kabelgebunden vor WLAN), sonst der erste Port.
 */
export function hostPort(dev: Device): Port | undefined {
  const cfg = dev.config;
  if (cfg.kind === 'host' && (cfg.ap || cfg.wlc)) return dev.ports[0];
  const data = dev.ports.filter(isData);
  return data.find((p) => p.operUp) ?? data[0] ?? dev.ports[0];
}
