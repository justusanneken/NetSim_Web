import { EngineService } from './service';
import type { IotCfg, MgmtCfg, Radio, ServerSvc5, WifiBand, Wlan } from './p5types';
import { oidFromName, type Varbind } from './p5/snmp';
import type { Result } from './types';

/**
 * Phase-5-Nachrichtenprotokoll (UI ↔ Worker): WLAN, Server-Dienste, Management, IoT, Module, Physical View.
 * Getrennt von `EngineService`, damit sich Phase 5 und Phase-4-Nachbesserungen nicht überschneiden.
 */
export class EngineService5 extends EngineService {
  private done<T>(r: Result<T>): Result<T> {
    this.touch();
    return r;
  }

  /** Simuliert vor, bis `ready()` gilt (nicht im Simulationsmodus, dort wird schrittweise gefahren). */
  private pump(ready: () => boolean, maxEvents = 200_000): void {
    if (this.inSimulationMode) return;
    const e = this.engine;
    let n = 0;
    while (!ready() && e.queueLength > 0 && n++ < maxEvents) e.step();
  }

  // ---- WLAN
  setApRadio(id: string, band: WifiBand, patch: Partial<Omit<Radio, 'band'>>): Result<true> {
    return this.done(this.engine.p5.setApRadio(id, band, patch));
  }
  setApController(id: string, ip: string): Result<true> {
    return this.done(this.engine.p5.setApController(id, ip));
  }
  wifiAddProfile(
    id: string,
    ssid: string,
    key?: string,
    cred?: { username: string; password: string },
  ): Result<true> {
    return this.done(this.engine.p5.wifiAddProfile(id, ssid, key, cred));
  }
  wifiRemoveProfile(id: string, ssid: string): Result<true> {
    return this.done(this.engine.p5.wifiRemoveProfile(id, ssid));
  }
  wifiEnable(id: string, on: boolean): Result<true> {
    return this.done(this.engine.p5.wifiEnable(id, on));
  }
  wlcSetWlan(id: string, w: Omit<Wlan, 'id'> & { id?: number }): Result<number> {
    return this.done(this.engine.p5.wlcSetWlan(id, w));
  }
  wlcRemoveWlan(id: string, wlanId: number): Result<true> {
    return this.done(this.engine.p5.wlcRemoveWlan(id, wlanId));
  }

  // ---- Server-Dienste und Clients
  setServices(id: string, patch: Partial<ServerSvc5>): Result<true> {
    return this.done(this.engine.p5.setServices(id, patch));
  }
  setMailAccount(id: string, a: { server?: string; user: string; pass: string }): Result<true> {
    return this.done(this.engine.p5.setMailAccount(id, a));
  }
  mailSend(id: string, to: string, subject: string, body: string): Result<true> {
    const r = this.engine.p5.mailSend(id, to, subject, body);
    this.pump(() => this.mailStatus(id) !== 'mail.working');
    return this.done(r);
  }
  mailFetch(id: string): Result<true> {
    const r = this.engine.p5.mailFetch(id);
    this.pump(() => this.mailStatus(id) !== 'mail.working');
    return this.done(r);
  }
  private mailStatus(id: string): string | undefined {
    const c = this.engine.getDevice(id)?.config;
    return c?.kind === 'host' ? c.mail?.status?.key : undefined;
  }
  setHostNtp(id: string, server: string): Result<true> {
    return this.done(this.engine.p5.setHostNtp(id, server));
  }
  setHostFirewall(id: string, on: boolean): Result<true> {
    const c = this.engine.getDevice(id)?.config;
    if (c?.kind !== 'host') return { ok: false, error: 'ip.notAHost' };
    c.firewallOn = on;
    return this.done({ ok: true, value: true });
  }
  setHostFile(id: string, name: string, content: string | null): Result<true> {
    const c = this.engine.getDevice(id)?.config;
    if (c?.kind !== 'host') return { ok: false, error: 'ip.notAHost' };
    const files = (c.files ??= {});
    if (content === null) delete files[name];
    else files[name] = content;
    return this.done({ ok: true, value: true });
  }

  /** SNMP-Abfrage (MIB-Browser): liefert Status und Variablenbindungen. */
  async snmpQuery(
    id: string,
    dst: string,
    community: string,
    op: 'get' | 'getnext' | 'walk' | 'set',
    oid: string,
    value?: string,
  ): Promise<Result<{ status: string; varbinds: Varbind[] }>> {
    const args: Record<string, string> = { community, oid: oidFromName(oid) };
    if (value !== undefined) args.value = value;
    const r = this.engine.p5.request(id, dst, 'snmp', op, args);
    this.touch();
    if (!r.ok) return r;
    this.pump(() => this.engine.p5.reqStatus(id, r.value)?.status !== 'pending');
    const st = this.engine.p5.reqStatus(id, r.value);
    this.touch();
    if (st?.status === 'pending') return { ok: false, error: 'svc.pending' };
    if (st?.status !== 'done' || !st.reply) return { ok: false, error: 'conn.timeout' };
    return {
      ok: true,
      value: {
        status: String(st.reply.args.status ?? 'ok'),
        varbinds: JSON.parse(st.reply.body ?? '[]') as Varbind[],
      },
    };
  }

  // ---- Management
  setMgmt(
    id: string,
    patch: Partial<Pick<MgmtCfg, 'users' | 'ssh' | 'vty' | 'ntp' | 'syslog' | 'snmp' | 'aaa'>>,
  ): Result<true> {
    return this.done(this.engine.p5.setMgmt(id, patch));
  }
  setClock(id: string, epochMs: number): Result<true> {
    return this.done(this.engine.p5.setClock(id, epochMs));
  }

  // ---- IoT, Cloud, Module, Physical View
  setIotScript(id: string, code: string): Result<true> {
    return this.done(this.engine.p5.setIotScript(id, code));
  }

  runIotScript(id: string, run: boolean): Result<true> {
    return this.done(this.engine.p5.runIotScript(id, run));
  }

  setIot(id: string, patch: Partial<IotCfg>): Result<true> {
    return this.done(this.engine.p5.setIot(id, patch));
  }
  setBridgeGroup(id: string, portId: string, group: number): Result<true> {
    return this.done(this.engine.p5.setBridgeGroup(id, portId, group));
  }
  insertModule(id: string, slot: number, name: string): Result<true> {
    return this.done(this.engine.p5.insertModule(id, slot, name));
  }
  removeModule(id: string, slot: number): Result<true> {
    return this.done(this.engine.p5.removeModule(id, slot));
  }
  addLocation(path: string): Result<true> {
    return this.done(this.engine.p5.addLocation(path));
  }
  deleteLocation(path: string): Result<true> {
    return this.done(this.engine.p5.deleteLocation(path));
  }
  placeDevice(id: string, path: string, rackPos?: number): Result<true> {
    return this.done(this.engine.p5.placeDevice(id, path, rackPos));
  }
}
