/**
 * Serial-WAN: Line-Protocol-Auswertung (HDLC/PPP, Taktrate am DCE, PPP-Authentifizierung).
 * Die Auswertung geschieht sofort bei jeder Änderung (keine Keepalive-Wartezeit, siehe docs/simplifications.md).
 */
import type { Device, Link, Port, SerialCfg, SerialDown } from './types';

export const DEFAULT_SERIAL: SerialCfg = { encap: 'hdlc' };

/** Serial-Konfiguration eines Ports (Default: HDLC). */
export function serialCfgOf(dev: Device, portId: string): SerialCfg {
  const c = dev.config.kind === 'router' ? dev.config.ifaces[portId]?.serial : undefined;
  return c ?? DEFAULT_SERIAL;
}

const hostnameOf = (dev: Device): string =>
  dev.config.kind === 'router' ? dev.config.sys.hostname : dev.name;

/** Kürzel für Debug-Zeilen (`Se0/0/0`). */
export const serialShort = (p: Port): string => p.name.replace('Serial', 'Se');

export interface SerialEnd {
  dev: Device;
  port: Port;
  cfg: SerialCfg;
  /** DCE-Ende des Kabels. */
  dce: boolean;
}

/** DCE-Ende: bei `serial-dce` Port A, bei `serial-dte` Port B. */
export function serialEnds(
  link: Link,
  devA: Device,
  devB: Device,
  pa: Port,
  pb: Port,
): [SerialEnd, SerialEnd] {
  const aDce = link.cable !== 'serial-dte';
  return [
    { dev: devA, port: pa, cfg: serialCfgOf(devA, pa.id), dce: aDce },
    { dev: devB, port: pb, cfg: serialCfgOf(devB, pb.id), dce: !aDce },
  ];
}

/** Ob der Authenticator `a` den Peer `b` mit der gewählten Methode akzeptiert; liefert Methode und Ergebnis. */
export function authenticate(
  a: SerialEnd,
  b: SerialEnd,
): { method: 'chap' | 'pap'; ok: boolean; name: string } | undefined {
  const method = a.cfg.auth?.[0];
  if (method === undefined) return undefined;
  const users = a.dev.config.kind === 'router' ? (a.dev.config.sys.mgmt?.users ?? {}) : {};
  const peerUsers = b.dev.config.kind === 'router' ? (b.dev.config.sys.mgmt?.users ?? {}) : {};
  if (method === 'pap') {
    const name = b.cfg.papUser ?? '';
    const ok = name !== '' && b.cfg.papPass !== undefined && users[name]?.secret === b.cfg.papPass;
    return { method, ok, name };
  }
  const name = b.cfg.chapHostname ?? hostnameOf(b.dev);
  const challenger = a.cfg.chapHostname ?? hostnameOf(a.dev);
  const mine = users[name]?.secret ?? a.cfg.chapPassword;
  const theirs = b.cfg.chapPassword ?? peerUsers[challenger]?.secret;
  return { method, ok: mine !== undefined && theirs !== undefined && mine === theirs, name };
}

/** Berechnet das Line-Protocol beider Enden (undefined = up). */
export function evalSerial(a: SerialEnd, b: SerialEnd): SerialDown | undefined {
  const dce = a.dce ? a : b;
  if (!dce.cfg.clockRate) return 'noclock';
  if (a.cfg.encap !== b.cfg.encap) return 'encap';
  if (a.cfg.encap === 'ppp') {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const r = authenticate(x, y);
      if (r && !r.ok) return 'auth';
    }
  }
  return undefined;
}
