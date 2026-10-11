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
    await page.keyboard.type(l, { delay: 1 });
    await page.keyboard.press('Enter');
  }
}

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

async function hostIp(page: Page, x: number, y: number, ip: string): Promise<void> {
  await click(page, x, y, 2);
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'IP-Konfiguration' }).click();
  await dlg.getByLabel('IPv4-Adresse').fill(ip);
  await dlg.getByRole('button', { name: 'Übernehmen' }).first().click();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await page.waitForTimeout(300);
}

const rows = (page: Page) => page.locator('.xterm-rows');
async function closeDialog(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.waitForTimeout(300);
}

async function routerCli(page: Page, x: number, y: number, lines: string[]): Promise<void> {
  await click(page, x, y, 2);
  await page.getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await expect(rows(page)).toContainText('initial configuration dialog');
  await typeLines(page, ['no', 'enable', 'configure terminal', ...lines, 'end']);
}

test('Proto: PPPoE – CPE wählt sich beim BRAS ein und erhält Adresse und Sitzung', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Netzwerk', 'Router', 160, 220);
  await place(page, 'Netzwerk', 'Router', 460, 220);
  await cable(page, [[160, 220, 460, 220]]);

  // BRAS (rechter Router)
  await routerCli(page, 460, 220, [
    'username kunde password geheim',
    'ip local pool KUNDEN 203.0.113.100 203.0.113.110',
    'interface loopback0',
    'ip address 203.0.113.1 255.255.255.255',
    'exit',
    'bba-group pppoe GLOBAL',
    'virtual-template 1',
    'exit',
    'interface virtual-template 1',
    'ip unnumbered loopback0',
    'peer default ip address pool KUNDEN',
    'ppp authentication chap',
    'exit',
    'interface gi0/0',
    'pppoe enable group GLOBAL',
    'no shutdown',
    'end',
  ]);
  await closeDialog(page);

  // CPE (linker Router)
  await routerCli(page, 160, 220, [
    'interface dialer 1',
    'encapsulation ppp',
    'ip address negotiated',
    'dialer pool 1',
    'ppp chap hostname kunde',
    'ppp chap password 0 geheim',
    'exit',
    'interface gi0/0',
    'pppoe-client dial-pool-number 1',
    'no shutdown',
    'end',
    'show pppoe session',
  ]);
  await expect(rows(page)).toContainText('203.0.113.100', { timeout: 30_000 });
  await typeLines(page, ['show ip interface brief']);
  await expect(rows(page)).toContainText('Dialer1');
  await closeDialog(page);

  // Routing-Panel zeigt die Sitzung
  await click(page, 160, 220, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await expect(page.getByTestId('pppoe-session').first()).toContainText('verbunden');
  expect(errors).toEqual([]);
});

test('Proto: IPsec – Crypto-Map-Konfiguration, show crypto und Routing-Panel ohne Peer', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Netzwerk', 'Router', 300, 220);
  await page.waitForTimeout(500);
  await routerCli(page, 300, 220, [
    'crypto isakmp policy 10',
    'encryption aes',
    'authentication pre-share',
    'group 2',
    'exit',
    'crypto isakmp key geheim address 198.51.100.1',
    'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
    'exit',
    'access-list 101 permit ip 10.1.0.0 0.0.0.255 10.2.0.0 0.0.0.255',
    'crypto map VPN 10 ipsec-isakmp',
    'set peer 198.51.100.1',
    'set transform-set TS',
    'match address 101',
    'end',
    'show crypto map',
  ]);
  await expect(rows(page)).toContainText('Peer = 198.51.100.1');
  await typeLines(page, ['show crypto isakmp policy']);
  await expect(rows(page)).toContainText('Pre-Shared Key');
  await closeDialog(page);
  expect(errors).toEqual([]);
});

test('Proto: WPA2-Enterprise – Access Point zeigt RADIUS-Felder, Wi-Fi-Profil hat Benutzer/Passwort', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Drahtlos', 'Access Point', 300, 220);
  await place(page, 'Endgeräte', 'Laptop', 480, 220);
  // erst doppelklicken, wenn beide Geräte in der Engine angekommen sind
  await expect(page.getByRole('button', { name: /^Laptop0 / })).toBeVisible();
  await click(page, 300, 220, 2);
  const dlg = page.getByRole('dialog');
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByLabel('Sicherheit 2.4').selectOption('wpa2-enterprise');
  await expect(dlg.getByLabel('RADIUS-Server 2.4')).toBeVisible();
  await expect(dlg.getByLabel('Shared Secret 2.4')).toBeVisible();
  await closeDialog(page);
  await click(page, 480, 220, 2);
  await dlg.getByRole('button', { name: 'PC Wireless' }).click();
  await expect(dlg.getByLabel('Benutzername (802.1X)')).toBeVisible();
  await expect(dlg.getByLabel('Passwort (802.1X)')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Proto: Server-Dienste zeigen TACACS+ und die SNMP-Trap-Liste', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await place(page, 'Endgeräte', 'Server', 300, 220);
  await page.waitForTimeout(500);
  await hostIp(page, 300, 220, '10.0.0.10');
  await click(page, 300, 220, 2);
  const dlg = page.getByRole('dialog');
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await expect(dlg.getByLabel('TACACS+', { exact: true })).toBeVisible();
  await dlg
    .locator('details', { hasText: 'SNMP' })
    .first()
    .locator('summary')
    .click({ position: { x: 4, y: 4 } });
  await expect(dlg.getByText('Noch keine Traps empfangen.')).toBeVisible();
  expect(errors).toEqual([]);
});
