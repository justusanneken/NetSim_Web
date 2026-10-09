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

async function closeDialog(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.waitForTimeout(300);
}

const rows = (page: Page) => page.locator('.xterm-rows');

test('TCP: Telnet-Sitzung PC → Router, Verbindungstabelle zeigt Port 23', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Endgeräte', 'PC', 140, 220);
  await place(page, 'Netzwerk', 'Router', 420, 220);
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Automatisch' }).click();
  await click(page, 140, 220);
  await click(page, 420, 220);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Auswählen' }).click();

  await click(page, 420, 220, 2);
  await page.getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await expect(rows(page)).toContainText('initial configuration dialog');
  await typeLines(page, [
    'no',
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'line vty 0 4',
    'password cisco',
    'login',
    'end',
  ]);
  await closeDialog(page);

  await click(page, 140, 220, 2);
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'IP-Konfiguration' }).click();
  await dlg.getByLabel('IPv4-Adresse').fill('10.0.0.2');
  await dlg.getByLabel('Standard-Gateway').fill('10.0.0.1');
  await dlg.getByRole('button', { name: 'Übernehmen' }).first().click();
  await dlg.getByRole('button', { name: 'Eingabeaufforderung' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, ['telnet 10.0.0.1']);
  await expect(rows(page)).toContainText('Password:');
  await typeLines(page, ['cisco']);
  await expect(rows(page)).toContainText('Router0>');
  // Eingabezeilen und Ausgabe laufen als TCP-Segmente; die Router-Verbindungstabelle zeigt Port 23
  await typeLines(page, ['show tcp brief']);
  await expect(rows(page)).toContainText('ESTAB');
  await expect(rows(page)).toContainText('10.0.0.1.23');
  await typeLines(page, ['exit']);
  await expect(rows(page)).toContainText('closed by foreign host');
  expect(errors).toEqual([]);
});

test('IoT: Programm auf dem SBC läuft, Konsole zeigt die Ausgabe', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'IoT', 'Einplatinenrechner', 200, 200);
  await click(page, 200, 200, 2);
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('tab', { name: 'Programmierung' }).click();
  await dlg.getByRole('button', { name: 'Beispiel' }).click();
  await dlg.getByRole('button', { name: 'Run' }).click();
  await expect(dlg.getByRole('status')).toContainText('läuft');
  await expect(dlg.getByLabel('Konsole', { exact: true }).last()).toContainText('program started');
  await expect(dlg.getByLabel('Konsole', { exact: true }).last()).toContainText('tick 2', {
    timeout: 20_000,
  });
  await dlg.getByRole('button', { name: 'Stop' }).click();
  await expect(dlg.getByRole('status')).toContainText('gestoppt');

  // Fehler im Programm: Gerät angehalten, Meldung in der Konsole
  await dlg.getByLabel('Programmtext').fill('every(500, () => { while (true) {} });');
  await dlg.getByRole('button', { name: 'Run' }).click();
  await expect(dlg.getByRole('status')).toContainText('Fehler', { timeout: 20_000 });
  await expect(dlg.getByLabel('Konsole', { exact: true }).last()).toContainText('step limit');
  expect(errors).toEqual([]);
});
