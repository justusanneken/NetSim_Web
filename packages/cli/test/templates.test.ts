import { describe, expect, it } from 'vitest';
import { Engine, decodeNsim, encodeNsim, exportNsim, importNsim } from '@netsim/engine';
import { TEMPLATES, buildTemplate, runTemplateChecks, templateById } from '../src';

describe('Vorlagen (Datei -> Vorlagen)', () => {
  it('enthält mindestens die zehn geforderten Beispielnetze mit de/en-Texten und Lernzielen', () => {
    const ids = TEMPLATES.map((t) => t.id);
    for (const need of [
      'soho',
      'vlan-trunk',
      'router-on-a-stick',
      'ospf-3-routers',
      'nat-pat',
      'dhcp-relay',
      'stp-ring',
      'etherchannel',
      'acl-lab',
      'wlan',
    ])
      expect(ids).toContain(need);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(t.title.de && t.title.en && t.summary.de && t.summary.en).toBeTruthy();
      expect(t.goals.de.length).toBeGreaterThanOrEqual(2);
      expect(t.goals.en.length).toBe(t.goals.de.length);
      expect(t.checks.length).toBeGreaterThan(0);
    }
    expect(templateById('nope')).toBeUndefined();
    expect(() => buildTemplate(new Engine(), 'nope')).toThrow();
  });

  for (const tpl of TEMPLATES) {
    describe(tpl.id, () => {
      it('baut ohne CLI-Fehler, konvergiert und besteht alle Prüfungen', () => {
        const e = new Engine({ seed: 1 });
        const lab = buildTemplate(e, tpl.id);
        expect(tpl.verify?.(lab)).toBeUndefined();
        const results = runTemplateChecks(lab, tpl);
        const failed = results.filter((r) => !r.passed).map((r) => r.check.label.en);
        expect(failed).toEqual([]);
      }, 60_000);

      it('übersteht .nsim-Speichern und -Öffnen (Round-Trip) und funktioniert danach weiter', () => {
        const e = new Engine({ seed: 1 });
        buildTemplate(e, tpl.id);
        const bytes = encodeNsim(exportNsim(e, { name: tpl.id }));
        const doc = decodeNsim(bytes);
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;
        const e2 = new Engine();
        expect(importNsim(e2, doc.value).ok).toBe(true);
        // erneutes Konvergieren nach dem Öffnen, danach gelten dieselben Prüfungen
        const { Lab } = require_lab();
        const lab2 = new Lab(e2);
        for (const d of Object.values(e2.state.devices)) lab2.ids[d.name] = d.id;
        lab2.settle(tpl.settleSec);
        const failed = runTemplateChecks(lab2, tpl)
          .filter((r) => !r.passed)
          .map((r) => r.check.label.en);
        expect(failed).toEqual([]);
      }, 60_000);
    });
  }
});

import { TemplateLab } from '../src';
function require_lab(): { Lab: typeof TemplateLab } {
  return { Lab: TemplateLab };
}
