import { expect, test, type Page } from '@playwright/test';

async function place(page: Page, tab: string, label: string, x: number, y: number): Promise<void> {
  await page.getByRole('tab', { name: tab }).click();
  await page.getByRole('button', { name: label, exact: true }).first().click();
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + x, box.y + y);
}

async function click(page: Page, x: number, y: number, count = 1): Promise<void> {
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + x, box.y + y, { clickCount: count });
}

test('Phase 3: L3-Switch mit VLANs, Server-Dienste und Webbrowser im PC', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await place(page, 'Endgeräte', 'PC', 140, 120);
  await place(page, 'Endgeräte', 'Server', 140, 320);
  await place(page, 'Netzwerk', 'Layer-3-Switch', 420, 220);
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Automatisch' }).click();
  await click(page, 140, 120);
  await click(page, 420, 220);
  await click(page, 140, 320);
  await click(page, 420, 220);
  await page.getByRole('button', { name: 'Auswählen' }).click();

  const dlg = page.getByRole('dialog');

  // Switch: VLAN-Tabelle und SVI-Formular
  await click(page, 420, 220, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await expect(dlg.getByRole('table', { name: 'VLANs' })).toBeVisible();
  await dlg.getByLabel('VLAN-ID').fill('10');
  await dlg
    .locator('.form', { has: page.locator('[aria-label="VLAN-ID"]') })
    .getByRole('button', { name: 'Hinzufügen' })
    .click();
  await expect(dlg.getByRole('table', { name: 'VLANs' })).toContainText('VLAN0010');
  await dlg.getByRole('button', { name: 'Schließen' }).click();

  // Server: Dienste
  await click(page, 140, 320, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await expect(dlg.getByRole('heading', { name: 'Dienste' })).toBeVisible();
  const http = dlg.getByRole('checkbox', { name: 'HTTP', exact: true });
  await http.click();
  await expect(http).toBeChecked();
  await dlg.getByRole('button', { name: 'Schließen' }).click();

  // PC: Webbrowser-App vorhanden
  await click(page, 140, 120, 2);
  await dlg.getByRole('button', { name: 'Webbrowser' }).click();
  await expect(dlg.getByLabel('URL')).toBeVisible();

  expect(errors).toEqual([]);
});
