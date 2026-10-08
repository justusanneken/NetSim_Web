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

/** Kabel (Automatisch) zwischen zwei Geräten legen. */
async function cable(page: Page, pairs: [number, number, number, number][]): Promise<void> {
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Automatisch' }).click();
  for (const [x1, y1, x2, y2] of pairs) {
    await click(page, x1, y1);
    await click(page, x2, y2);
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: 'Auswählen' }).click();
}

async function hostIp(
  page: Page,
  x: number,
  y: number,
  ip: string,
  gw?: string,
  keepOpen = false,
): Promise<void> {
  await click(page, x, y, 2);
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'IP-Konfiguration' }).click();
  await dlg.getByLabel('IPv4-Adresse').fill(ip);
  if (gw) await dlg.getByLabel('Standard-Gateway').fill(gw);
  await dlg.getByRole('button', { name: 'Übernehmen' }).first().click();
  if (!keepOpen) {
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await page.waitForTimeout(300);
  }
}

async function cmd(page: Page, x: number, y: number, lines: string[]): Promise<void> {
  await click(page, x, y, 2);
  await page.getByRole('dialog').getByRole('button', { name: 'Eingabeaufforderung' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, lines);
}

const rows = (page: Page) => page.locator('.xterm-rows');
async function closeDialog(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.waitForTimeout(300);
}

test('Phase 5: Laptop verbindet sich per WPA2 mit dem Access Point und pingt den kabelgebundenen Server', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Endgeräte', 'Server', 120, 220);
  await place(page, 'Drahtlos', 'Access Point', 320, 220);
  await place(page, 'Endgeräte', 'Laptop', 480, 220);
  await cable(page, [[120, 220, 320, 220]]);

  // Access Point: SSID + WPA2-Schlüssel
  await click(page, 320, 220, 2);
  const dlg = page.getByRole('dialog');
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByLabel('SSID 2.4').fill('HomeNet');
  await dlg.getByLabel('Sicherheit 2.4').selectOption('wpa2-psk');
  await dlg.getByLabel('Schlüssel (8–63 Zeichen) 2.4').fill('secret123');
  await dlg
    .locator('fieldset', { hasText: '2.4 GHz' })
    .getByRole('button', { name: 'Übernehmen' })
    .click();
  await closeDialog(page);

  // Server + Laptop: IPs
  await hostIp(page, 120, 220, '10.0.0.10');
  await hostIp(page, 480, 220, '10.0.0.20');

  // Laptop: Wi-Fi-Profil mit falschem, dann richtigem Schlüssel
  await click(page, 480, 220, 2);
  await dlg.getByRole('button', { name: 'PC Wireless' }).click();
  await dlg.getByLabel('SSID', { exact: true }).fill('HomeNet');
  await dlg.getByLabel('Schlüssel (WPA2-PSK)').fill('wrongpass1');
  await dlg.getByRole('button', { name: 'Verbinden' }).click();
  await expect(dlg.getByTestId('wifi-status')).toContainText('Authentifizierung fehlgeschlagen');
  await dlg.getByLabel('Schlüssel (WPA2-PSK)').fill('secret123');
  await dlg.getByRole('button', { name: 'Verbinden' }).click();
  await expect(dlg.getByTestId('wifi-status')).toContainText('Verbunden mit „HomeNet“');

  // Ping über das WLAN zum Server
  await dlg.getByRole('button', { name: 'Eingabeaufforderung' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, ['ping 10.0.0.10']);
  await expect(rows(page)).toContainText('Reply from 10.0.0.10');
  await closeDialog(page);

  // Ereignisliste zeigt Authentifizierung und Assoziation
  await expect(page.locator('.event', { hasText: 'assoziiert' }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Phase 5: Telnet und SSH vom PC zum Router', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Endgeräte', 'PC', 140, 220);
  await place(page, 'Netzwerk', 'Router', 420, 220);
  await cable(page, [[140, 220, 420, 220]]);

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
    'username admin privilege 15 secret s3cret',
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 1024',
    'line vty 0 4',
    'password cisco',
    'login',
    'end',
  ]);
  await closeDialog(page);
  await hostIp(page, 140, 220, '10.0.0.2', '10.0.0.1');

  // Telnet mit vty-Passwort
  await cmd(page, 140, 220, ['telnet 10.0.0.1']);
  await expect(rows(page)).toContainText('Password:');
  await typeLines(page, ['cisco']);
  await expect(rows(page)).toContainText('Router0>');
  await typeLines(page, ['show users']);
  await expect(rows(page)).toContainText('vty 0');
  await typeLines(page, ['exit']);
  await expect(rows(page)).toContainText('closed by foreign host');

  // Nur noch SSH erlaubt: Telnet scheitert, SSH mit lokalem Benutzer klappt
  await closeDialog(page);
  await click(page, 420, 220, 2);
  await page.getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, [
    'configure terminal',
    'line vty 0 4',
    'transport input ssh',
    'login local',
    'end',
  ]);
  await closeDialog(page);
  await cmd(page, 140, 220, ['cls', 'telnet 10.0.0.1']);
  await expect(rows(page)).toContainText('Could not open connection');
  await typeLines(page, ['ssh -l admin 10.0.0.1']);
  await expect(rows(page)).toContainText('Password:');
  await typeLines(page, ['s3cret']);
  await expect(rows(page)).toContainText('Router0#');
  await typeLines(page, ['exit']);
  expect(errors).toEqual([]);
});

test('Phase 5: TFTP-Backup der Router-Konfiguration', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Endgeräte', 'Server', 140, 220);
  await place(page, 'Netzwerk', 'Router', 420, 220);
  await cable(page, [[140, 220, 420, 220]]);
  await hostIp(page, 140, 220, '10.0.0.10', '10.0.0.1');

  // TFTP-Dienst am Server einschalten
  await click(page, 140, 220, 2);
  const dlg = page.getByRole('dialog');
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByRole('checkbox', { name: 'TFTP', exact: true }).click();
  await expect(dlg.getByRole('checkbox', { name: 'TFTP', exact: true })).toBeChecked();
  await closeDialog(page);

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
    'end',
    'copy running-config tftp://10.0.0.10/r1-confg',
  ]);
  await expect(rows(page)).toContainText('[OK -');
  await closeDialog(page);

  // Datei liegt auf dem Server
  await click(page, 140, 220, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg
    .locator('details', { hasText: 'TFTP' })
    .first()
    .locator('summary')
    .click({ position: { x: 4, y: 4 } });
  await expect(dlg.getByRole('list', { name: 'Dateien' }).first()).toContainText('r1-confg');
  expect(errors).toEqual([]);
});

test('Phase 5: Firewall blockiert outside→inside, erlaubt Rückverkehr von inside→outside', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Endgeräte', 'PC', 120, 220);
  await place(page, 'Netzwerk', 'Firewall', 320, 220);
  await place(page, 'Endgeräte', 'Server', 520, 220);
  await cable(page, [
    [120, 220, 320, 220],
    [320, 220, 520, 220],
  ]);

  await click(page, 320, 220, 2);
  await page.getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await expect(rows(page)).toContainText('initial configuration dialog');
  await typeLines(page, [
    'no',
    'enable',
    'configure terminal',
    'interface gi0/0',
    'nameif inside',
    'security-level 100',
    'ip address 10.0.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'nameif outside',
    'security-level 0',
    'ip address 203.0.113.1 255.255.255.0',
    'no shutdown',
    'end',
    'show nameif',
  ]);
  await expect(rows(page)).toContainText('outside');
  await closeDialog(page);

  await hostIp(page, 120, 220, '10.0.0.10', '10.0.0.1');
  await hostIp(page, 520, 220, '203.0.113.10', '203.0.113.1');

  // inside → outside: erlaubt (Rückverkehr zustandsbehaftet)
  await cmd(page, 120, 220, ['ping 203.0.113.10']);
  await expect(rows(page)).toContainText('Reply from 203.0.113.10');
  await closeDialog(page);

  // outside → inside: blockiert
  await cmd(page, 520, 220, ['ping -n 1 10.0.0.10']);
  await expect(rows(page)).toContainText('Request timed out');
  await closeDialog(page);

  // Verbindungstabelle und Ereignis
  await click(page, 320, 220, 2);
  await page.getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, ['show conn']);
  await expect(rows(page)).toContainText('ICMP outside 203.0.113.10');
  await closeDialog(page);
  await expect(page.locator('.event', { hasText: 'Security-Level' }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Phase 5: Physical View und Geräte-Dialog Physical-Tab', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Netzwerk', 'Router', 300, 200);
  await click(page, 300, 200, 2);
  const dlg = page.getByRole('dialog');
  await page.getByRole('tab', { name: 'Physical' }).click();
  // Module nur bei ausgeschaltetem Gerät
  await dlg.getByRole('button', { name: 'Power-Taste' }).click();
  await dlg.getByLabel('Einstecken HWIC0').selectOption('HWIC-2T');
  await expect(dlg.getByRole('table', { name: 'Module' })).toContainText('HWIC-2T');
  await closeDialog(page);

  await page.getByRole('button', { name: 'Ansicht', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Physical View' }).click();
  await page.getByLabel('Neuer Ort').fill('Berlin/HQ/Serverraum/Rack1');
  await page.locator('.physical-view').getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(page.locator('.physical-view')).toContainText('Serverraum');
  await page.getByLabel('Raum / Rack Router0').selectOption('Berlin/HQ/Serverraum/Rack1');
  await expect(page.locator('.phys-rack')).toContainText('Router0');
  expect(errors).toEqual([]);
});
