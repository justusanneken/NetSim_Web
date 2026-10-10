import { pduSize, type Ipv4Pdu } from '@netsim/protocols';
import { aclEval, l4Of } from './acl';
import type { L3Cfg, QosClass } from './types';

export const defaultQos = (): NonNullable<L3Cfg['qos']> => ({
  classes: {},
  policies: {},
  counters: {},
});

export const qosOf = (cfg: L3Cfg): NonNullable<L3Cfg['qos']> => (cfg.qos ??= defaultQos());

/** Protokollname -> (IP-Protokoll, Zielport). */
const PROTOCOLS: Record<string, { proto: 'tcp' | 'udp' | 'icmp'; port?: number }> = {
  http: { proto: 'tcp', port: 80 },
  secure_http: { proto: 'tcp', port: 443 },
  https: { proto: 'tcp', port: 443 },
  telnet: { proto: 'tcp', port: 23 },
  ssh: { proto: 'tcp', port: 22 },
  ftp: { proto: 'tcp', port: 21 },
  smtp: { proto: 'tcp', port: 25 },
  dns: { proto: 'udp', port: 53 },
  tftp: { proto: 'udp', port: 69 },
  ntp: { proto: 'udp', port: 123 },
  snmp: { proto: 'udp', port: 161 },
  syslog: { proto: 'udp', port: 514 },
  icmp: { proto: 'icmp' },
};

export const KNOWN_PROTOCOLS = Object.keys(PROTOCOLS);

function classMatches(l3: L3Cfg, c: QosClass, ip: Ipv4Pdu): boolean {
  const tests: boolean[] = [];
  if (c.any) tests.push(true);
  if (c.dscp.length) tests.push(c.dscp.includes(ip.dscp ?? 0));
  if (c.acl) {
    // Prüfung ohne die Trefferzähler der ACL zu verändern
    const acl = l3.acls[c.acl];
    tests.push(acl ? aclEval(structuredClone(acl), ip).action === 'permit' : false);
  }
  for (const p of c.protocols) {
    const d = PROTOCOLS[p];
    const k = l4Of(ip);
    tests.push(!!d && k.proto === d.proto && (d.port === undefined || k.dport === d.port));
  }
  if (tests.length === 0) return false;
  return c.matchAll ? tests.every(Boolean) : tests.some(Boolean);
}

/**
 * Wendet die Service-Policy einer Schnittstelle an: Klassifizierung (erste passende Klasse),
 * Zähler und `set dscp`. Gibt das (ggf. neu markierte) Paket zurück.
 */
export function qosApply(
  l3: L3Cfg,
  ifaceId: string,
  dir: 'in' | 'out',
  policyName: string | undefined,
  ip: Ipv4Pdu,
): Ipv4Pdu {
  const q = l3.qos;
  const pol = policyName ? q?.policies[policyName] : undefined;
  if (!q || !pol) return ip;
  for (const pc of pol.classes) {
    const cls = q.classes[pc.class];
    const isDefault = pc.class === 'class-default';
    if (!isDefault && (!cls || !classMatches(l3, cls, ip))) continue;
    const key = `${ifaceId}|${dir}|${pc.class}`;
    const ctr = (q.counters[key] ??= { pkts: 0, bytes: 0, marked: 0 });
    ctr.pkts++;
    ctr.bytes += pduSize(ip);
    if (pc.setDscp !== undefined && pc.setDscp !== (ip.dscp ?? 0)) {
      ctr.marked++;
      return { ...ip, dscp: pc.setDscp };
    }
    if (pc.setDscp !== undefined) ctr.marked++;
    return ip;
  }
  return ip;
}
