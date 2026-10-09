import { mgmtOf, type SnmpTrapKind } from '@netsim/engine';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';

const CF: ModeId[] = ['config'];
const U: ModeId[] = ['user', 'priv'];
const ALL: SnmpTrapKind[] = ['linkdown', 'linkup', 'coldstart'];
const KNOWN = ['snmp', 'linkdown', 'linkup', 'coldstart', 'authentication', 'warmstart'];

/** Zeilen für die running-config (`snmp-server host`, `snmp-server enable traps`). */
export function snmpTrapLines(m: ReturnType<typeof mgmtOf>['snmp']): string[] {
  const L: string[] = [];
  for (const h of m.trapHosts ?? [])
    L.push(`snmp-server host ${h.host} version ${h.version} ${h.community}`);
  const t = m.traps ?? [];
  if (t.length > 0)
    L.push(
      `snmp-server enable traps snmp ${ALL.filter((x) => t.includes(x))
        .map((x) => (x === 'coldstart' ? 'coldstart' : x))
        .join(' ')}`,
    );
  return L;
}

/** SNMP-Traps: `snmp-server host`, `snmp-server enable traps`. */
export function addSnmpTraps(r: Registry<CliSession>): void {
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('show', 'Show running system information'),
      K('snmp', 'snmp statistics'),
      K('host', 'snmp host information'),
    ],
    run: (s) => {
      for (const h of mgmtOf(s.sys).snmp.trapHosts ?? [])
        s.outLines([
          `Notification host: ${h.host}\tudp-port: 162\ttype: trap`,
          `user: ${h.community}\tsecurity model: v${h.version}`,
          '',
        ]);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('snmp-server', 'Modify SNMP engine parameters'),
      K('host', 'Specify hosts to receive SNMP notifications'),
      P('ip', 'ip', 'A.B.C.D', 'IP address of SNMP notification host'),
      opt(K('version', 'SNMP version to use for notification messages')),
      opt(choice('ver', ['1', 'SNMPv1'], ['2c', 'SNMPv2C'])),
      P('community', 'word', 'WORD', 'SNMPv1/v2c community string'),
    ],
    run: (s, a) => {
      const m = mgmtOf(s.sys).snmp;
      const ip = a.ip as string;
      m.trapHosts = (m.trapHosts ?? []).filter((h) => h.host !== ip);
      if (!s.negated)
        m.trapHosts.push({
          host: ip,
          community: a.community as string,
          version: a.ver === '2c' ? '2c' : '1',
        });
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('snmp-server', 'Modify SNMP engine parameters'),
      K('enable', 'Enable SNMP Traps or Informs'),
      K('traps', 'Enable SNMP Traps'),
      opt(R('types', 'snmp|linkdown|linkup|coldstart', 'Trap types')),
    ],
    run: (s, a) => {
      const m = mgmtOf(s.sys).snmp;
      const words = ((a.types as string | undefined) ?? '').split(/\s+/).filter(Boolean);
      for (const w of words) if (!KNOWN.includes(w)) throw new CliError('% Invalid input detected');
      // ohne Angabe (oder nur `snmp`) alle drei Typen
      const wanted: SnmpTrapKind[] =
        words.length === 0 || words.every((w) => w === 'snmp')
          ? ALL
          : ALL.filter((x) => words.includes(x));
      const cur = new Set(m.traps ?? []);
      for (const k of wanted) {
        if (s.negated) cur.delete(k);
        else cur.add(k);
      }
      m.traps = ALL.filter((k) => cur.has(k));
    },
  });
}
