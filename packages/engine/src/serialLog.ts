/** Protokollierung des Serial-Line-Protocols: Syslog, Ereignisliste, `debug ppp …`. */
import type { Engine } from './engine';
import type { DeviceCtx } from './ctx';
import { syslogEmit } from './p5/syslog';
import { serialCfgOf, serialShort } from './serial';
import type { Device, Port, SerialDown } from './types';

/** Debug-Zeile (nur bei aktivem Schalter); eigene Kopie, um Importzyklen mit routing/core zu vermeiden. */
function dbg(
  rt: { ctx: DeviceCtx; flags: string[] },
  proto: 'PPP',
  tag: string,
  text: () => string,
): void {
  if (!rt.flags.includes(tag)) return;
  rt.ctx.log({
    kind: 'info',
    proto,
    status: 'info',
    msg: { key: 'rt.debug' },
    debug: { tag, text: text() },
  });
}

const REASON: Record<SerialDown, string> = {
  noclock: 'serial.reason.noclock',
  encap: 'serial.reason.encap',
  auth: 'serial.reason.auth',
  peerdown: 'serial.reason.peerdown',
  keepalive: 'serial.reason.keepalive',
};

/** Lokale Magic Number für Debug-Ausgaben (deterministisch aus der MAC). */
const magic = (p: Port): string =>
  p.mac
    .replace(/[^0-9a-f]/gi, '')
    .slice(-8)
    .toUpperCase();

export function serialLineChanged(
  eng: Engine,
  dev: Device,
  p: Port,
  up: boolean,
  wasProto: SerialDown | undefined,
  proto: SerialDown | undefined,
  _peerUp: boolean,
): void {
  void wasProto;
  const cfg = serialCfgOf(dev, p.id);
  eng.addLog(dev, {
    kind: 'info',
    proto: 'LINK',
    status: up ? 'ok' : 'info',
    port: p,
    msg: up
      ? { key: 'serial.protoUp', params: { port: p.name, encap: cfg.encap.toUpperCase() } }
      : {
          key: 'serial.protoDown',
          params: { port: p.name, reason: REASON[p.protoDown ?? proto ?? 'keepalive'] },
        },
  });
  if (dev.config.kind !== 'router' || !dev.powered) return;
  const debugFlags = dev.config.routing.debug;
  eng.withCtx(dev, (ctx) => {
    syslogEmit(
      ctx,
      dev,
      5,
      'LINEPROTO-5-UPDOWN',
      `Line protocol on Interface ${p.name}, changed state to ${up ? 'up' : 'down'}`,
    );
    if (cfg.encap !== 'ppp') return;
    const rt = { ctx, flags: debugFlags };
    const n = serialShort(p);
    const lcp = (): void => {
      dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} PPP: Phase is ESTABLISHING, Active Open`);
      dbg(
        rt,
        'PPP',
        'ppp.negotiation',
        () => `${n} LCP: O CONFREQ [Closed] id 1 len ${cfg.auth?.length ? 15 : 10}`,
      );
      if (cfg.auth?.length)
        dbg(
          rt,
          'PPP',
          'ppp.negotiation',
          () =>
            `${n} LCP:    AuthProto ${cfg.auth?.[0] === 'pap' ? 'PAP (0x0304C023)' : 'CHAP (0x0305C22305)'}`,
        );
      dbg(
        rt,
        'PPP',
        'ppp.negotiation',
        () => `${n} LCP:    MagicNumber 0x${magic(p)} (0x0506${magic(p)})`,
      );
    };
    if (up) {
      lcp();
      dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} LCP: I CONFACK [REQsent] id 1 len 10`);
      dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} LCP: State is Open`);
      if (cfg.auth?.length) {
        const m = cfg.auth[0] === 'pap' ? 'PAP' : 'CHAP';
        dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} PPP: Phase is AUTHENTICATING, by this end`);
        dbg(
          rt,
          'PPP',
          'ppp.authentication',
          () => `${n} ${m}: O ${m === 'PAP' ? 'AUTH-REQ' : 'CHALLENGE'} id 1`,
        );
        dbg(
          rt,
          'PPP',
          'ppp.authentication',
          () => `${n} ${m}: I ${m === 'PAP' ? 'AUTH-REQ' : 'RESPONSE'} id 1`,
        );
        dbg(
          rt,
          'PPP',
          'ppp.authentication',
          () => `${n} ${m}: O ${m === 'PAP' ? 'AUTH-ACK' : 'SUCCESS'} id 1 len 4`,
        );
      }
      dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} PPP: Phase is UP`);
      dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} IPCP: State is Open`);
    } else if (p.protoDown === 'auth') {
      lcp();
      dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} PPP: Phase is AUTHENTICATING, by this end`);
      dbg(
        rt,
        'PPP',
        'ppp.authentication',
        () => `${n} ${cfg.auth?.[0] === 'pap' ? 'PAP' : 'CHAP'}: Authentication failed`,
      );
      dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} PPP: Phase is TERMINATING`);
    } else {
      dbg(rt, 'PPP', 'ppp.negotiation', () => `${n} PPP: Phase is DOWN`);
    }
  });
}
