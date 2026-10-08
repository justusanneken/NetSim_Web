import { expect, test, type Page } from '@playwright/test';

/** Platziert ein Gerät per Palette (Klick) und Klick auf die Arbeitsfläche. */
async function place(page: Page, label: string, x: number, y: number): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + x, box.y + y);
}

async function clickDevice(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + x, box.y + y);
}

test('Phase 1: platzieren, verkabeln, pingen, Event-Liste', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();

  // Geräte platzieren
  await place(page, 'PC', 160, 140);
  await place(page, 'PC', 160, 300);
  await page.getByRole('tab', { name: 'Netzwerk' }).click();
  await place(page, 'Switch', 420, 220);
  await expect(page.getByRole('list', { name: 'Netzwerk-Info' }).getByRole('listitem')).toHaveCount(
    3,
  );

  // Automatisch verkabeln: PC0 → Switch0, PC1 → Switch0
  await page.getByRole('button', { name: 'Kabel', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Automatisch' }).click();
  await clickDevice(page, 160, 140);
  await clickDevice(page, 420, 220);
  await clickDevice(page, 160, 300);
  await clickDevice(page, 420, 220);
  await expect(page.getByText('Link FastEthernet0 ist aktiv').first()).toBeVisible();

  // IPs konfigurieren
  await page.getByRole('button', { name: 'Auswählen' }).click();
  for (const [y, ip] of [
    [140, '10.0.0.1'],
    [300, '10.0.0.2'],
  ] as const) {
    await clickDevice(page, 160, y);
    await page.getByLabel('IPv4-Adresse').fill(ip);
    await page.getByRole('button', { name: 'Übernehmen' }).click();
  }

  // Ping PC0 → 10.0.0.2
  await clickDevice(page, 160, 140);
  await page.getByLabel('Ziel-IP').fill('10.0.0.2');
  await page.getByRole('button', { name: 'Senden', exact: true }).click();
  await expect(page.locator('.ping-list .ping-reply')).toHaveCount(1, { timeout: 15_000 });

  // Event-Liste: ARP-Flooding sichtbar, MAC-Tabelle des Switches gefüllt
  await expect(page.locator('.event.proto-ARP').first()).toBeVisible();
  await page.locator('.event.proto-ARP').last().click();
  await expect(page.locator('.inspector table.osi')).toBeVisible();
  await expect(page.locator('.inspector details').first()).toContainText('Ethernet II');

  await page.getByRole('list', { name: 'Netzwerk-Info' }).getByText('Switch0').click();
  await expect(page.getByText('MAC-Adresstabelle')).toBeVisible();
  await expect(
    page.locator('.device-panel table.grid tbody tr').filter({ hasText: '02:00:' }).first(),
  ).toBeVisible();

  // Sprache umschalten
  await page.getByRole('button', { name: 'Sprache' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'Select' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('Phase 1: PC↔PC mit Straight-Kabel bleibt down', async ({ page }) => {
  await page.goto('/');
  await place(page, 'PC', 160, 140);
  await place(page, 'PC', 400, 140);
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Straight' }).click();
  await clickDevice(page, 160, 140);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /FastEthernet0/ })
    .click();
  await clickDevice(page, 400, 140);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /FastEthernet0/ })
    .click();
  await expect(page.getByText('falscher Kabeltyp').first()).toBeVisible();
});
