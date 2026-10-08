import type { Device } from '../types';

export type Varbind = [oid: string, value: string | number];

/** Namen der unterstützten Objekte (für den MIB-Browser). */
export const MIB_NAMES: Record<string, string> = {
  '1.3.6.1.2.1.1.1.0': 'sysDescr.0',
  '1.3.6.1.2.1.1.3.0': 'sysUpTime.0',
  '1.3.6.1.2.1.1.4.0': 'sysContact.0',
  '1.3.6.1.2.1.1.5.0': 'sysName.0',
  '1.3.6.1.2.1.1.6.0': 'sysLocation.0',
  '1.3.6.1.2.1.2.1.0': 'ifNumber.0',
};
const IF_COLS: Record<number, string> = {
  1: 'ifIndex',
  2: 'ifDescr',
  3: 'ifType',
  4: 'ifMtu',
  5: 'ifSpeed',
  6: 'ifPhysAddress',
  7: 'ifAdminStatus',
  8: 'ifOperStatus',
  10: 'ifInOctets',
  11: 'ifInUcastPkts',
  14: 'ifInErrors',
  16: 'ifOutOctets',
  17: 'ifOutUcastPkts',
  20: 'ifOutErrors',
};

/** Lesbarer Name zu einer OID (`ifDescr.2`), sonst die OID selbst. */
export function oidName(oid: string): string {
  const fixed = MIB_NAMES[oid];
  if (fixed) return fixed;
  const m = /^1\.3\.6\.1\.2\.1\.2\.2\.1\.(\d+)\.(\d+)$/.exec(oid);
  const col = m ? IF_COLS[Number(m[1])] : undefined;
  return m && col ? `${col}.${m[2]}` : oid;
}

/** Namen → OIDs (`sysName.0`, `ifDescr.1`, …); numerische OIDs bleiben unverändert. */
export function oidFromName(text: string): string {
  const t = text.trim().replace(/^\./, '');
  for (const [oid, n] of Object.entries(MIB_NAMES))
    if (n.toLowerCase() === t.toLowerCase()) return oid;
  const m = /^([A-Za-z]+)\.(\d+)$/.exec(t);
  if (m) {
    const col = Object.entries(IF_COLS).find(
      ([, n]) => n.toLowerCase() === (m[1] ?? '').toLowerCase(),
    );
    if (col) return `1.3.6.1.2.1.2.2.1.${col[0]}.${m[2]}`;
  }
  return t;
}

const cmpOid = (a: string, b: string): number => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
};

export interface SnmpIdent {
  name: string;
  location?: string;
  contact?: string;
}

/** Die MIB-Sicht eines Geräts (nach OID sortiert). */
export function buildMib(dev: Device, ident: SnmpIdent, nowUs: number): Varbind[] {
  const out: Varbind[] = [
    ['1.3.6.1.2.1.1.1.0', `NetSim ${dev.model} (${dev.type})`],
    ['1.3.6.1.2.1.1.3.0', Math.floor(nowUs / 10_000)],
    ['1.3.6.1.2.1.1.4.0', ident.contact ?? ''],
    ['1.3.6.1.2.1.1.5.0', ident.name],
    ['1.3.6.1.2.1.1.6.0', ident.location ?? ''],
    ['1.3.6.1.2.1.2.1.0', dev.ports.length],
  ];
  dev.ports.forEach((p, i) => {
    const n = i + 1;
    const col = (c: number, v: string | number): void => {
      out.push([`1.3.6.1.2.1.2.2.1.${c}.${n}`, v]);
    };
    col(1, n);
    col(2, p.name);
    col(3, p.kind === 'wifi' ? 71 : p.kind === 'serial' ? 22 : 6);
    col(4, p.mtu);
    col(5, p.operSpeed * 1_000_000);
    col(6, p.mac);
    col(7, p.adminUp ? 1 : 2);
    col(8, p.operUp ? 1 : 2);
    col(10, p.counters.inBytes);
    col(11, p.counters.inPkts);
    col(14, p.counters.inErrors);
    col(16, p.counters.outBytes);
    col(17, p.counters.outPkts);
    col(20, p.counters.outErrors);
  });
  return out.sort((a, b) => cmpOid(a[0], b[0]));
}

/** Alle Einträge unterhalb von `prefix` (Walk) bzw. der Eintrag selbst. */
export function mibWalk(mib: Varbind[], prefix: string): Varbind[] {
  const p = prefix.replace(/^\./, '');
  return mib.filter(([oid]) => oid === p || oid.startsWith(p + '.'));
}

/** Nächster Eintrag nach `oid` (GETNEXT). */
export function mibNext(mib: Varbind[], oid: string): Varbind | undefined {
  return mib.find(([o]) => cmpOid(o, oid) > 0);
}
