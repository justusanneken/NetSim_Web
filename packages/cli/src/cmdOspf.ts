import { isValidIpv4 } from '@netsim/protocols';
import type { IfaceCfg, OspfAreaCfg, OspfCfg } from '@netsim/engine';
import { l3c, touch } from './commandsGaps';
import { targets } from './commands';
import { K, P, choice, opt, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import * as show4 from './show4';

const normArea = (a: string): string => (a.includes('.') ? a : String(Number(a)));
const OSPF = ['config-ospf'] as const;

function proc(s: CliSession): OspfCfg {
  const c = l3c(s).routing.ospf[s.procId];
  if (!c) throw new CliError('% OSPF process is not running');
  return c;
}

/** Area-Konfiguration holen/anlegen; leere Standardwerte werden wieder entfernt. */
function areaOf(c: OspfCfg, id: string): OspfAreaCfg {
  c.areas ??= {};
  return (c.areas[id] ??= { id, type: 'normal', noSummary: false });
}
function tidy(c: OspfCfg, id: string): void {
  const a = c.areas?.[id];
  if (
    a &&
    a.type === 'normal' &&
    !a.noSummary &&
    a.defaultCost === undefined &&
    !a.auth &&
    !a.nssaDefaultOriginate
  )
    delete c.areas?.[id];
}

export function addOspfAreas(r: Registry<CliSession>): void {
  const AREA = [
    K('area', 'OSPF area parameters'),
    P('area', 'word', 'AREA', 'OSPF area ID as a decimal value or in IP address format'),
  ];
  const upd = (
    s: CliSession,
    a: Record<string, string>,
    f: (x: OspfAreaCfg, c: OspfCfg) => void,
  ) => {
    const c = proc(s);
    const id = normArea(a.area as string);
    f(areaOf(c, id), c);
    tidy(c, id);
    c.dirty = true;
    touch(s);
  };
  r.add({
    modes: [...OSPF],
    only: 'l3',
    negatable: true,
    slots: [
      ...AREA,
      K('stub', 'Configure OSPF area as stub'),
      opt(K('no-summary', 'Do not send summary LSA into stub area')),
    ],
    run: (s, a) =>
      upd(s, a, (x) => {
        if (s.negated) {
          if (x.type === 'stub') {
            x.type = 'normal';
            x.noSummary = false;
          }
          return;
        }
        if (x.id === '0') throw new CliError('% Backbone area cannot be a stub');
        x.type = 'stub';
        x.noSummary = Object.values(a).includes('no-summary');
      }),
  });
  r.add({
    modes: [...OSPF],
    only: 'l3',
    negatable: true,
    slots: [
      ...AREA,
      K('nssa', 'Specify a NSSA area'),
      opt(K('no-summary', 'Do not send summary LSA into NSSA')),
      opt(K('default-information-originate', 'Originate Type 7 default into NSSA area')),
    ],
    run: (s, a) =>
      upd(s, a, (x) => {
        if (s.negated) {
          if (x.type === 'nssa') {
            x.type = 'normal';
            x.noSummary = false;
            x.nssaDefaultOriginate = undefined;
          }
          return;
        }
        if (x.id === '0') throw new CliError('% Backbone area cannot be an NSSA');
        x.type = 'nssa';
        const words = Object.values(a);
        x.noSummary = words.includes('no-summary');
        x.nssaDefaultOriginate = words.includes('default-information-originate') || undefined;
      }),
  });
  r.add({
    modes: [...OSPF],
    only: 'l3',
    negatable: true,
    slots: [
      ...AREA,
      K('default-cost', 'Set the summary default-cost of a NSSA/stub area'),
      P('cost', 'int', '<0-16777215>', 'Advertised default summary cost', [0, 16777215]),
    ],
    run: (s, a) =>
      upd(s, a, (x) => {
        x.defaultCost = s.negated ? undefined : Number(a.cost);
      }),
  });
  r.add({
    modes: [...OSPF],
    only: 'l3',
    negatable: true,
    slots: [
      ...AREA,
      K('authentication', 'Enable authentication'),
      opt(K('message-digest', 'Use message-digest authentication')),
    ],
    run: (s, a) =>
      upd(s, a, (x) => {
        x.auth = s.negated
          ? undefined
          : Object.values(a).includes('message-digest')
            ? 'md5'
            : 'simple';
      }),
  });
  r.add({
    modes: [...OSPF],
    only: 'l3',
    negatable: true,
    slots: [
      ...AREA,
      K('virtual-link', 'Define a virtual link and its parameters'),
      P('rid', 'ip', 'A.B.C.D', 'ID (IP addr) associated with virtual link neighbor'),
    ],
    run: (s, a) => {
      const c = proc(s);
      const area = normArea(a.area as string);
      if (area === '0')
        throw new CliError('% Virtual link cannot use the backbone as transit area');
      const rid = a.rid as string;
      if (!isValidIpv4(rid)) throw new CliError('% Invalid router ID');
      c.vlinks = (c.vlinks ?? []).filter((v) => !(v.area === area && v.rid === rid));
      if (!s.negated) c.vlinks.push({ area, rid });
      if (c.vlinks.length === 0) c.vlinks = undefined;
      c.dirty = true;
      touch(s);
    },
  });

  // ------------------------------------------------------------ Schnittstellen: Authentifizierung
  const ifo = (s: CliSession, f: (o: NonNullable<IfaceCfg['ospf']>) => void): void => {
    for (const id of targets(s)) {
      s.engine.ensureIface(s.deviceId, id);
      const ic = l3c(s).ifaces[id];
      if (!ic) continue;
      ic.ospf ??= {};
      f(ic.ospf);
    }
    for (const c of Object.values(l3c(s).routing.ospf)) c.dirty = true;
    touch(s);
  };
  const IFM = ['config-if', 'config-subif', 'config-if-range'] as const;
  const IPK = [
    K('ip', 'Interface Internet Protocol config commands'),
    K('ospf', 'OSPF interface commands'),
  ];
  r.add({
    modes: [...IFM],
    only: 'l3',
    negatable: true,
    slots: [
      ...IPK,
      K('authentication', 'Enable authentication'),
      opt(
        choice(
          'mode',
          ['message-digest', 'Use message-digest authentication'],
          ['null', 'Use no authentication'],
        ),
      ),
    ],
    run: (s, a) =>
      ifo(s, (o) => {
        o.auth = s.negated
          ? undefined
          : a.mode === 'message-digest'
            ? 'md5'
            : a.mode === 'null'
              ? 'null'
              : 'simple';
      }),
  });
  r.add({
    modes: [...IFM],
    only: 'l3',
    negatable: true,
    slots: [
      ...IPK,
      K('authentication-key', 'Authentication password (key)'),
      P('key', 'word', 'KEY', 'The OSPF password (key)'),
    ],
    run: (s, a) => ifo(s, (o) => (o.authKey = s.negated ? undefined : (a.key as string))),
  });
  r.add({
    modes: [...IFM],
    only: 'l3',
    negatable: true,
    slots: [
      ...IPK,
      K('message-digest-key', 'Message digest authentication password (key)'),
      P('id', 'int', '<1-255>', 'Key ID', [1, 255]),
      K('md5', 'Use MD5 algorithm'),
      P('key', 'word', 'KEY', 'The OSPF password (key)'),
    ],
    run: (s, a) =>
      ifo(s, (o) => {
        o.md5Keys ??= {};
        if (s.negated) delete o.md5Keys[Number(a.id)];
        else o.md5Keys[Number(a.id)] = a.key as string;
        if (Object.keys(o.md5Keys).length === 0) o.md5Keys = undefined;
      }),
  });

  // ------------------------------------------------------------ show
  r.add({
    modes: ['user', 'priv'],
    only: 'l3',
    slots: [
      K('show', 'Show running system information'),
      K('ip', 'IP information'),
      K('ospf', 'OSPF information'),
      K('virtual-links', 'Virtual link information'),
    ],
    run: (s) => s.outLines(show4.showOspfVirtualLinks(s.engine, s.device)),
  });
}
