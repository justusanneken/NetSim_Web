import { expect, test, type Page } from '@playwright/test';

/**
 * QA3: Wettläufe zwischen RPC-Antworten und Ansichts-Aktualisierungen (eigener Comlink-Port).
 * Schnelle Bedienung ohne Wartezeiten darf weder Platzierungen noch die Auswahl verlieren.
 */

const devices = (page: Page) =>
  page.getByRole('list', { name: 'Netzwerk-Info' }).getByRole('listitem');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('init')) {
      sessionStorage.setItem('init', '1');
      localStorage.setItem('netsim.clean', '1');
      indexedDB.deleteDatabase('netsim');
    }
  });
});

test('schnelles Platzieren: jeder Palette-Klick + Klick auf die Fläche ergibt ein Gerät', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  const pc = page.getByRole('button', { name: 'PC', exact: true }).first();
  const n = 12;
  for (let i = 0; i < n; i++) {
    await pc.click();
    await page.mouse.click(box.x + 80 + (i % 6) * 120, box.y + 80 + Math.floor(i / 6) * 140);
  }
  await expect(devices(page)).toHaveCount(n);
  // das zuletzt platzierte Gerät bleibt ausgewählt
  await expect(page.locator('.device-panel input').first()).toHaveValue(`PC${n - 1}`);
});

test('Einfügen wählt die Kopie zuverlässig aus; Entf direkt danach löscht die Kopie', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.getByRole('button', { name: 'PC', exact: true }).first().click();
  await page.mouse.click(box.x + 160, box.y + 140);
  await expect(devices(page)).toHaveCount(1);
  for (let i = 0; i < 6; i++) {
    // Auswahl über die Geräteliste (ein zweiter Klick auf die Fläche wäre ein Doppelklick)
    await devices(page).first().getByRole('button').first().click();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await expect(devices(page)).toHaveCount(2);
    await expect(page.locator('.device-panel input').first()).toHaveValue(/^PC[1-9]\d*$/);
    await page.keyboard.press('Delete');
    await expect(devices(page)).toHaveCount(1);
    await expect(devices(page).first()).toContainText('PC0');
  }
});

test('Autosave: Geräteanzahl in der Wiederherstellungs-Abfrage passt zur Sicherung', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('netsim.autosaveMs', '100');
    if (sessionStorage.getItem('crash')) localStorage.setItem('netsim.clean', '0');
  });
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  const pc = page.getByRole('button', { name: 'PC', exact: true }).first();
  for (let i = 0; i < 5; i++) {
    await pc.click();
    await page.mouse.click(box.x + 100 + i * 120, box.y + 140);
  }
  await expect(devices(page)).toHaveCount(5);
  await page.waitForTimeout(1000);
  await page.evaluate(() => sessionStorage.setItem('crash', '1'));
  await page.reload();
  const dlg = page.getByRole('dialog', { name: 'Wiederherstellung' });
  await expect(dlg).toContainText('5 Geräte');
  await dlg.getByRole('button', { name: 'Wiederherstellen' }).click();
  await expect(devices(page)).toHaveCount(5);
});
