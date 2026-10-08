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

async function typeLines(page: Page, lines: string[]): Promise<void> {
  for (const l of lines) {
    await page.keyboard.type(l, { delay: 2 });
    await page.keyboard.press('Enter');
  }
}

test('Phase 2: Router per CLI konfigurieren, Ping/Tracert vom PC, Inspektor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await place(page, 'Endgeräte', 'PC', 140, 120);
  await place(page, 'Endgeräte', 'PC', 140, 320);
  await place(page, 'Netzwerk', 'Router', 420, 220);
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Automatisch' }).click();
  await click(page, 140, 120);
  await click(page, 420, 220);
  await click(page, 140, 320);
  await click(page, 420, 220);
  await page.getByRole('button', { name: 'Auswählen' }).click();

  // Router-CLI (Doppelklick öffnet den Geräte-Dialog)
  await click(page, 420, 220, 2);
  await page.getByRole('tab', { name: 'CLI' }).click();
  const term = page.locator('.xterm');
  await term.click();
  await expect(page.locator('.xterm-rows')).toContainText('initial configuration dialog');
  await typeLines(page, [
    'no',
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.1.1 255.255.255.0',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 10.0.2.1 255.255.255.0',
    'no shutdown',
    'end',
    'show ip route',
  ]);
  await expect(page.locator('.xterm-rows')).toContainText(
    'C        10.0.1.0/24 is directly connected, GigabitEthernet0/0',
  );
  // Fehlermeldung mit Caret
  await typeLines(page, ['sh ipp']);
  await expect(page.locator('.xterm-rows')).toContainText(
    "% Invalid input detected at '^' marker.",
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();

  // PCs: IP-Konfiguration über den Desktop
  for (const [y, ip, gw] of [
    [120, '10.0.1.10', '10.0.1.1'],
    [320, '10.0.2.10', '10.0.2.1'],
  ] as const) {
    await click(page, 140, y, 2);
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('IPv4-Adresse').fill(ip);
    await dlg.getByLabel('Standard-Gateway').fill(gw);
    await dlg.getByRole('button', { name: 'Übernehmen' }).click();
    await page.keyboard.press('Escape');
  }

  await click(page, 140, 120, 2);
  await page.getByRole('dialog').getByRole('button', { name: 'Eingabeaufforderung' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, ['ping 10.0.2.10', 'tracert 10.0.2.10']);
  await expect(page.locator('.xterm-rows')).toContainText('Reply from 10.0.2.10');
  await expect(page.locator('.xterm-rows')).toContainText('Trace complete.');
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();

  // Simulationsmodus: Schritt vor und PDU-Inspektor
  await page.getByRole('button', { name: 'Simulation', exact: true }).click();
  await page.getByRole('button', { name: 'Zurücksetzen' }).click();
  await click(page, 140, 120, 2);
  await page.getByRole('dialog').getByRole('button', { name: 'Eingabeaufforderung' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, ['ping 10.0.2.10 -n 1']);
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect(page.locator('.event')).toHaveCount(0);
  await page.getByRole('button', { name: 'Schritt vor' }).click();
  await page.getByRole('button', { name: 'Schritt vor' }).click();
  await page.locator('.event').first().click();
  await expect(page.locator('.inspector table.osi')).toBeVisible();
  expect(errors).toEqual([]);
});
