import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { click, place } from './helpers';

const MODES = [
  { name: 'hell', theme: 'light', cb: '0' },
  { name: 'dunkel', theme: 'dark', cb: '0' },
  { name: 'farbenblind', theme: 'light', cb: '1' },
] as const;

async function audit(page: Page, label: string): Promise<void> {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(['color-contrast']) // Kontrast wird über die Token-Unit-Tests geprüft; Canvas ist nicht prüfbar
    .analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    ),
  ).toEqual([]);
}

async function contrast(page: Page, label: string): Promise<void> {
  const res = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

for (const mode of MODES) {
  test(`axe: Hauptansicht und Dialoge (${mode.name})`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.addInitScript(
      ([theme, cb]) => {
        localStorage.setItem('netsim.theme', theme as string);
        localStorage.setItem('netsim.cb', cb as string);
      },
      [mode.theme, mode.cb],
    );
    await page.goto('/');
    await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
    await audit(page, 'leer');
    await contrast(page, 'leer');

    await place(page, 'Endgeräte', 'PC', 160, 140);
    await page.waitForTimeout(150);
    await place(page, 'Netzwerk', 'Router', 380, 140);
    await page.waitForTimeout(150);
    await place(page, 'Netzwerk', 'Switch', 380, 300);
    await page.waitForTimeout(150);
    await click(page, 380, 300);
    await audit(page, 'Gerät gewählt');
    await contrast(page, 'Gerät gewählt');

    // Menüs
    for (const m of [
      'Datei',
      'Bearbeiten',
      'Optionen',
      'Ansicht',
      'Anordnen',
      'Extras',
      'Hilfe',
      'Sprache',
    ]) {
      await page.getByRole('button', { name: m, exact: true }).click();
      await audit(page, `Menü ${m}`);
    }
    await page.keyboard.press('Escape');

    // Kontextmenü
    const box = await page.locator('.canvas-wrap').boundingBox();
    if (!box) throw new Error('Canvas fehlt');
    await page.mouse.click(box.x + 380, box.y + 140, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'Kontextmenü' })).toBeVisible();
    await audit(page, 'Kontextmenü');
    await page.keyboard.press('Escape');

    // Mini-Map, Notiz
    await page.getByRole('button', { name: 'Ansicht', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Mini-Map anzeigen' }).click();
    await page.getByRole('button', { name: 'Notiz', exact: true }).click();
    await click(page, 600, 250);
    await page.keyboard.type('Test');
    await page.keyboard.press('Escape');
    await audit(page, 'Mini-Map + Notiz');

    // Netzwerk-Info und Hintergrund-Dialog
    await page.getByRole('button', { name: 'Netzwerkinformationen öffnen' }).click();
    await audit(page, 'Netzwerk-Info');
    await contrast(page, 'Netzwerk-Info');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ansicht', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Hintergrundbild …' }).click();
    await audit(page, 'Hintergrund-Dialog');
    await page.keyboard.press('Escape');

    // Kabel-Port-Popup
    await page.getByRole('tab', { name: 'Kabel' }).click();
    await page.getByRole('button', { name: 'Straight', exact: true }).first().click();
    await click(page, 380, 140);
    await expect(page.getByRole('dialog', { name: /Port/ })).toBeVisible();
    await audit(page, 'Port-Popup');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Auswählen' }).click();

    // Geräte-Dialog: alle Tabs von Router und PC
    for (const [x, y] of [
      [380, 140],
      [160, 140],
    ] as const) {
      await click(page, x, y, 2);
      const dlg = page.getByRole('dialog').first();
      await expect(dlg).toBeVisible();
      const tabs = await dlg.getByRole('tab').allInnerTexts();
      for (const t of tabs) {
        await dlg.getByRole('tab', { name: t, exact: true }).click();
        await page.waitForTimeout(200);
        await audit(page, `Dialog ${t}`);
        await contrast(page, `Dialog ${t}`);
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
    }

    // Sprache English
    await page.getByRole('button', { name: 'Sprache', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'English' }).click();
    await audit(page, 'English');
  });
}
