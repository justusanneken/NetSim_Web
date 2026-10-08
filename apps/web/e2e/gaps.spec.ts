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

test('Lücken: OSPF-Stub-Area, HSRP v2, clock set und Routing-Panel mit Bereichsinfo', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await place(page, 'Netzwerk', 'Router', 280, 220);
  await place(page, 'Netzwerk', 'Router', 460, 220);
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Automatisch' }).click();
  await click(page, 280, 220);
  await click(page, 460, 220);
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Auswählen' }).click();

  const configure = async (x: number, ip: string): Promise<void> => {
    await click(page, x, 220, 2);
    await page.getByRole('tab', { name: 'CLI' }).click();
    await page.locator('.xterm').click();
    await expect(page.locator('.xterm-rows')).toContainText('initial configuration dialog');
    await typeLines(page, [
      'no',
      'enable',
      'clock set 10:30:00 15 March 2025',
      'show clock',
      'debug ip ospf adj',
      'configure terminal',
      'interface gi0/0',
      `ip address ${ip} 255.255.255.0`,
      'standby version 2',
      'standby 300 ip 10.0.12.254',
      'no shutdown',
      'exit',
      'router ospf 1',
      'network 10.0.12.0 0.0.0.255 area 1',
      'area 1 stub',
      'end',
    ]);
    await expect(page.locator('.xterm-rows')).toContainText('Sat Mar 15 2025');
  };
  await configure(280, '10.0.12.1');
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await configure(460, '10.0.12.2');

  // Zeit raffen: OSPF-Nachbarschaft und HSRP stabilisieren
  await page.getByRole('combobox').filter({ hasText: '20×' }).selectOption('20');
  await page.waitForTimeout(8_000);
  await page.getByRole('combobox').filter({ hasText: '20×' }).selectOption('1');

  // debug-Zeitstempel folgen der gesetzten Uhr
  await page.locator('.xterm').click();
  await expect(page.locator('.xterm-rows')).toContainText('Mar 15 10:3');
  await typeLines(page, ['undebug all', 'clear', 'show standby brief', 'show ip ospf']);
  await expect(page.locator('.xterm-rows')).toContainText('It is a stub area');
  await expect(page.locator('.xterm-rows')).toContainText('300');

  // Routing-Panel zeigt Bereichstyp und HSRP-Version
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await expect(page.getByTestId('ospf-area').first()).toContainText('Stub');
  await expect(page.getByRole('dialog')).toContainText('HSRP');
  await expect(page.getByRole('dialog')).toContainText('v2');
  expect(errors).toEqual([]);
});
