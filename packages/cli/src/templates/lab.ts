import { pickCable, type DeviceType, type Engine, type HostConfig } from '@netsim/engine';
import { CliSession } from '../session';
import { resolvePort } from '../format';

/** Kleiner Baukasten, mit dem Vorlagen Geräte platzieren, verkabeln und per IOS-CLI konfigurieren. */
export class Lab {
  readonly ids: Record<string, string> = {};

  constructor(readonly e: Engine) {}

  add(type: DeviceType, name: string, x: number, y: number): string {
    const id = this.e.addDevice(type, { name, pos: { x, y } });
    this.ids[name] = id;
    const d = this.e.getDevice(id);
    if (d && (d.config.kind === 'router' || d.config.kind === 'switch'))
      d.config.sys.setupDone = true;
    return id;
  }

  id(name: string): string {
    const id = this.ids[name];
    if (!id) throw new Error(`template: unknown device ${name}`);
    return id;
  }

  /** Verkabelt `a`:`ap` mit `b`:`bp` (Portnamen wie `Gi0/0`, `Fa0/1`, `Fa0`); der Kabeltyp wird automatisch gewählt. */
  link(a: string, ap: string, b: string, bp: string): void {
    const da = this.e.getDevice(this.id(a));
    const db = this.e.getDevice(this.id(b));
    const pa = da && resolvePort(da.ports, ap);
    const pb = db && resolvePort(db.ports, bp);
    if (!da || !db || !pa || !pb) throw new Error(`template: bad link ${a}:${ap} - ${b}:${bp}`);
    const r = this.e.connect(
      { deviceId: da.id, portId: pa.id },
      { deviceId: db.id, portId: pb.id },
      pickCable(da, pa, db, pb),
    );
    if (!r.ok) throw new Error(`template: link ${a}:${ap} - ${b}:${bp}: ${r.error}`);
  }

  host(name: string, ip: string, mask: string, gw?: string): void {
    const r = this.e.setHostIp(this.id(name), ip, mask, gw);
    if (!r.ok) throw new Error(`template: ${name}: ${r.error}`);
  }

  /**
   * Führt IOS-Zeilen aus (`enable` und `configure terminal` werden vorangestellt, `end` und `write memory` angehängt).
   * Jede Fehlermeldung (`%` am Zeilenanfang) bricht den Aufbau ab – Vorlagen sind IOS-korrekt oder gar nicht.
   */
  cli(name: string, lines: string[]): void {
    const s = new CliSession(this.e, this.id(name));
    const all = ['enable', 'configure terminal', ...lines, 'end', 'write memory'];
    for (const l of all) {
      const out = s.input(l);
      if (/^% /m.test(out)) throw new Error(`template: ${name}: "${l}" -> ${out.trim()}`);
    }
  }

  /** Führt einen Anzeigebefehl im privilegierten Modus aus und liefert die Ausgabe. */
  show(name: string, cmd: string): string {
    const s = new CliSession(this.e, this.id(name));
    s.input('enable');
    return s.input(cmd);
  }

  settle(seconds: number): void {
    this.e.runUntil(this.e.state.now + seconds * 1_000_000);
  }

  hostCfg(name: string): HostConfig {
    return this.e.getDevice(this.id(name))?.config as HostConfig;
  }
}
