import { Engine } from '@netsim/engine';
import { ETHERCHANNEL, ROAS, SOHO, STP_RING, VLAN_TRUNK, WLAN } from './basic';
import { ACL_LAB, BGP, DHCP_RELAY, HSRP, IPSEC, IPV6, NAT_PAT, OSPF3 } from './routing';
import { Lab } from './lab';
import type { Template, TemplateCheck } from './types';

export type { Template, TemplateCheck, Bilingual } from './types';
export { Lab } from './lab';

/** Beispielnetze für Datei → Vorlagen (Spec 6). Jedes ist vollständig per IOS-CLI konfiguriert. */
export const TEMPLATES: readonly Template[] = [
  SOHO,
  VLAN_TRUNK,
  ROAS,
  OSPF3,
  NAT_PAT,
  DHCP_RELAY,
  STP_RING,
  ETHERCHANNEL,
  ACL_LAB,
  WLAN,
  HSRP,
  IPV6,
  BGP,
  IPSEC,
];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Baut die Vorlage in eine (leere) Engine und simuliert bis zur Konvergenz. Wirft bei Fehlern in der Vorlage. */
export function buildTemplate(engine: Engine, id: string): Lab {
  const tpl = templateById(id);
  if (!tpl) throw new Error(`unknown template ${id}`);
  const lab = new Lab(engine);
  tpl.build(lab);
  lab.settle(tpl.settleSec);
  return lab;
}

export interface CheckResult {
  check: TemplateCheck;
  ok: boolean;
  passed: boolean;
}

/** Führt die Prüfungen einer Vorlage aus (Ping mit vier Versuchen bzw. HTTP-GET). */
export function runTemplateChecks(lab: Lab, tpl: Template): CheckResult[] {
  return tpl.checks.map((check) => {
    const id = lab.id(check.from);
    const cfg = lab.hostCfg(check.from);
    let ok = false;
    if (check.kind === 'ping') {
      const before = cfg.pings.length;
      const r = lab.e.ping(id, check.to, { count: 4 });
      if (r.ok) {
        lab.settle(12);
        ok = cfg.pings.slice(before).some((p) => p.status === 'reply');
      }
    } else {
      const r = lab.e.httpGet(id, check.to);
      if (r.ok) {
        lab.settle(10);
        const req = cfg.requests.find((q) => q.id === r.value);
        ok = req?.status === 'done' && req.code === 200;
      }
    }
    return { check, ok, passed: ok === (check.expect === 'ok') };
  });
}

export function newTemplateEngine(seed = 1): Engine {
  return new Engine({ seed });
}
