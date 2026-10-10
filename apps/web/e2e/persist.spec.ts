import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function place(page: Page, label: string, x: number, y: number): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + x, box.y + y);
}

const devices = (page: Page) =>
  page.getByRole('list', { name: 'Netzwerk-Info' }).getByRole('listitem');

async function menu(page: Page, top: string, item: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: top, exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.beforeEach(async ({ page }) => {
  // sauberer Zustand: kein altes Autosave, kein Absturz-Flag
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('init')) {
      sessionStorage.setItem('init', '1');
      localStorage.setItem('netsim.clean', '1');
      indexedDB.deleteDatabase('netsim');
    }
  });
});

test('Undo/Redo per Tastatur und Menü, Kopieren/Einfügen, Entf', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  await place(page, 'PC', 160, 140);
  await expect(devices(page)).toHaveCount(1);
  await place(page, 'PC', 300, 140);
  await expect(devices(page)).toHaveCount(2);

  await page.keyboard.press('Control+z');
  await expect(devices(page)).toHaveCount(1);
  await page.keyboard.press('Control+y');
  await expect(devices(page)).toHaveCount(2);
  await menu(page, 'Bearbeiten', /Rückgängig/);
  await expect(devices(page)).toHaveCount(1);
  await menu(page, 'Bearbeiten', /Wiederholen/);
  await expect(devices(page)).toHaveCount(2);

  // Kopieren/Einfügen des ausgewählten Geräts
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + 160, box.y + 140);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(devices(page)).toHaveCount(3);

  // Entf löscht die (neu eingefügte, ausgewählte) Kopie; Undo bringt sie zurück
  await page.keyboard.press('Delete');
  await expect(devices(page)).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(devices(page)).toHaveCount(3);
});

test('Vorlagen-Dialog: mindestens 10 Netze, Laden ersetzt das Netz, Undo stellt es wieder her', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  await place(page, 'PC', 160, 140);
  await menu(page, 'Datei', /Vorlagen/);
  const dlg = page.getByRole('dialog', { name: /Vorlagen/ });
  await expect(dlg).toBeVisible();
  expect(
    await dlg.getByRole('list', { name: 'Verfügbare Vorlagen' }).getByRole('button').count(),
  ).toBeGreaterThanOrEqual(10);
  await dlg.getByTestId('tpl-ospf-3-routers').click();
  await expect(dlg.getByRole('heading', { name: 'OSPF mit drei Routern' })).toBeVisible();
  await expect(dlg.getByText('Lernziele')).toBeVisible();
  await dlg.getByRole('button', { name: /Vorlage laden: OSPF/ }).click();
  await expect(dlg).toBeHidden();
  await expect(devices(page)).toHaveCount(6);
  await page.keyboard.press('Control+z');
  await expect(devices(page)).toHaveCount(1);
});

test('Speichern und Öffnen (.nsim) ergibt dasselbe Netz', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  await menu(page, 'Datei', /Vorlagen/);
  await page.getByTestId('tpl-vlan-trunk').click();
  await page.getByRole('button', { name: /Vorlage laden: VLANs/ }).click();
  await expect(devices(page)).toHaveCount(6);

  // Strg+S -> Dateiname -> Download
  await page.keyboard.press('Control+s');
  const dlg = page.getByRole('dialog', { name: 'Speichern unter' });
  await dlg.getByLabel('Dateiname').fill('mein-lab');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dlg.getByRole('button', { name: 'Speichern' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('mein-lab.nsim');
  const path = join(mkdtempSync(join(tmpdir(), 'nsim-')), 'mein-lab.nsim');
  await download.saveAs(path);

  // Neu -> leer
  await menu(page, 'Datei', 'Neu');
  await expect(devices(page)).toHaveCount(0);

  // Öffnen per Strg+O (bei Last kann der Dateiauswahl-Dialog verspätet kommen: wiederholen)
  await page.locator('.canvas-wrap').hover();
  await expect(async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      page.keyboard.press('Control+o'),
    ]);
    await chooser.setFiles(path);
  }).toPass({ timeout: 60_000 });
  await expect(devices(page)).toHaveCount(6);
  await expect(page.getByRole('alert')).toContainText('mein-lab');

  // kaputte Datei: klare Fehlermeldung, Netz bleibt
  await expect(async () => {
    const [chooser2] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      menu(page, 'Datei', /Öffnen/),
    ]);
    await chooser2.setFiles({
      name: 'kaputt.nsim',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('das ist kein nsim'),
    });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByRole('alert')).toContainText('keine gültige .nsim-Datei');
  await expect(devices(page)).toHaveCount(6);
});

test('Autosave und Wiederherstellung nach unsauberem Beenden', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('netsim.autosaveMs', '300');
    // simulierter Absturz: das Flag „sauber beendet“ bleibt auf 0, wenn crash markiert ist
    if (sessionStorage.getItem('crash')) localStorage.setItem('netsim.clean', '0');
  });
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  await place(page, 'PC', 160, 140);
  await place(page, 'PC', 300, 140);
  await expect(devices(page)).toHaveCount(2);
  await page.waitForTimeout(1500); // mehrere Autosave-Takte

  await page.evaluate(() => sessionStorage.setItem('crash', '1'));
  await page.reload();
  const dlg = page.getByRole('dialog', { name: 'Wiederherstellung' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('2 Geräte');
  await dlg.getByRole('button', { name: 'Wiederherstellen' }).click();
  await expect(dlg).toBeHidden();
  await expect(devices(page)).toHaveCount(2);

  // Verwerfen: leeres Netz, nach erneutem „Absturz“ kein Angebot mehr
  await page.waitForTimeout(800);
  await page.reload();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Verwerfen' }).click();
  await expect(dlg).toBeHidden();
  await expect(devices(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  await expect(dlg).toBeHidden();

  // sauberes Beenden (kein Absturz-Flag) -> keine Nachfrage
  await page.evaluate(() => sessionStorage.removeItem('crash'));
  await place(page, 'PC', 160, 140);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  await expect(dlg).toBeHidden();
});
