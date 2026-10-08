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

test('Phase 4: OSPF zwischen zwei Routern, debug-Ausgabe und Ping End-to-End', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await place(page, 'Endgeräte', 'PC', 100, 220);
  await place(page, 'Netzwerk', 'Router', 280, 220);
  await place(page, 'Netzwerk', 'Router', 460, 220);
  await place(page, 'Endgeräte', 'PC', 640, 220);
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Automatisch' }).click();
  for (const [x1, x2] of [
    [100, 280],
    [280, 460],
    [460, 640],
  ] as const) {
    await click(page, x1, 220);
    await click(page, x2, 220);
    await page.waitForTimeout(600); // kein Doppelklick auf dem Gerät zwischen zwei Kabeln
  }
  await page.getByRole('button', { name: 'Auswählen' }).click();

  const configure = async (
    x: number,
    lan: string,
    link: string,
    lanPort: string,
    linkPort: string,
  ) => {
    await click(page, x, 220, 2);
    await page.getByRole('tab', { name: 'CLI' }).click();
    await page.locator('.xterm').click();
    await expect(page.locator('.xterm-rows')).toContainText('initial configuration dialog');
    await typeLines(page, [
      'no',
      'enable',
      'debug ip ospf adj',
      'configure terminal',
      `interface ${lanPort}`,
      `ip address ${lan} 255.255.255.0`,
      'no shutdown',
      'exit',
      `interface ${linkPort}`,
      `ip address ${link} 255.255.255.0`,
      'no shutdown',
      'exit',
      'router ospf 1',
      'network 10.0.0.0 0.255.255.255 area 0',
      'end',
    ]);
    await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  };
  // R0: LAN links an gi0/0, Verbindung zu R1 an gi0/1; R1: Verbindung an gi0/0, LAN an gi0/1
  await configure(280, '10.0.1.1', '10.0.12.1', 'gi0/0', 'gi0/1');
  await configure(460, '10.0.2.1', '10.0.12.2', 'gi0/1', 'gi0/0');

  for (const [x, ip, gw] of [
    [100, '10.0.1.10', '10.0.1.1'],
    [640, '10.0.2.10', '10.0.2.1'],
  ] as const) {
    await click(page, x, 220, 2);
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('IPv4-Adresse').fill(ip);
    await dlg.getByLabel('Standard-Gateway').fill(gw);
    await dlg.getByRole('button', { name: 'Übernehmen' }).click();
    await page.keyboard.press('Escape');
  }

  // Zeit raffen: 20× → in wenigen Sekunden Wanduhr sind 2 Minuten OSPF vergangen
  await page.getByRole('combobox').filter({ hasText: '20×' }).selectOption('20');
  await page.waitForTimeout(9_000);
  await page.getByRole('combobox').filter({ hasText: '20×' }).selectOption('1');

  // debug-Meldungen und Nachbartabelle im CLI von R0
  await click(page, 280, 220, 2);
  await page.getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await expect(page.locator('.xterm-rows')).toContainText('OSPF-1 ADJ');
  await typeLines(page, ['undebug all', 'clear', 'show ip ospf neighbor', 'show ip route']);
  await expect(page.locator('.xterm-rows')).toContainText('FULL/');
  await expect(page.locator('.xterm-rows')).toContainText('10.0.2.0/24 [110/');
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();

  // Ende-zu-Ende-Ping vom PC
  await click(page, 100, 220, 2);
  await page.getByRole('dialog').getByRole('button', { name: 'Eingabeaufforderung' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, ['ping 10.0.2.10']);
  await expect(page.locator('.xterm-rows')).toContainText('Reply from 10.0.2.10');
  expect(errors).toEqual([]);
});
