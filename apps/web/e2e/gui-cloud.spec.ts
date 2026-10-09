import { expect, test, type Page } from '@playwright/test';
import {
  click,
  closeDialog,
  collectErrors,
  hostIp,
  openCmd,
  place,
  rows,
  typeLines,
  warp,
} from './helpers';

/** Kabel mit gewähltem Typ und expliziter Portwahl über den Port-Picker. */
async function cablePorts(
  page: Page,
  kind: string,
  a: [number, number, string],
  b: [number, number, string],
): Promise<void> {
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: kind, exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Port auswählen' });
  for (const [x, y, port] of [a, b]) {
    await click(page, x, y);
    await picker.getByRole('button', { name: new RegExp(`^${port}`) }).click();
  }
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Auswählen' }).click();
}

test('GUI: Cloud/Modem – DSL und Koax über die Cloud, Port-Gruppen-Tabelle, Ping PC → Router/Server', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await place(page, 'Endgeräte', 'PC', 60, 160);
  await place(page, 'WAN / Modem', 'DSL-Modem', 200, 160);
  await place(page, 'WAN / Modem', 'Cloud', 380, 250);
  await place(page, 'WAN / Modem', 'DSL-Modem', 560, 160);
  await place(page, 'Netzwerk', 'Router', 740, 160);
  await place(page, 'WAN / Modem', 'Kabelmodem', 380, 370);
  await place(page, 'Endgeräte', 'Server', 560, 370);

  await cablePorts(page, 'Straight', [60, 160, 'FastEthernet0'], [200, 160, 'Ethernet0']);
  await cablePorts(page, 'Telefon', [200, 160, 'Dsl0'], [380, 250, 'Dsl0']);
  await cablePorts(page, 'Telefon', [380, 250, 'Dsl1'], [560, 160, 'Dsl0']);
  await cablePorts(page, 'Straight', [560, 160, 'Ethernet0'], [740, 160, 'GigabitEthernet0/0']);
  await cablePorts(page, 'Koax', [380, 250, 'Coax0'], [380, 370, 'Coax0']);
  await cablePorts(page, 'Straight', [380, 370, 'Ethernet0'], [560, 370, 'FastEthernet0']);

  // Router konfigurieren
  await click(page, 740, 160, 2);
  await page.getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await expect(rows(page)).toContainText('initial configuration dialog');
  await typeLines(page, [
    'no',
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.0.2 255.255.255.0',
    'no shutdown',
    'end',
  ]);
  await closeDialog(page);
  await hostIp(page, 60, 160, '10.0.0.1');
  await hostIp(page, 560, 370, '10.0.0.3');
  await warp(page, 1_500);

  // Cloud-Dialog: Tabelle der Port-Gruppen zeigt alle sechs Ports in Gruppe 1
  await click(page, 380, 250, 2);
  const dlg = page.getByRole('dialog');
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  const table = dlg.getByRole('table', { name: 'Port-Zuordnung' });
  await expect(table.getByRole('row')).toHaveCount(7);
  await expect(dlg.getByLabel('Gruppe Dsl1')).toHaveValue('1');
  await closeDialog(page);

  // Ping über DSL → Cloud → DSL zum Router und über Koax zum Server
  await openCmd(page, 60, 160);
  await typeLines(page, ['ping 10.0.0.2']);
  await expect(rows(page)).toContainText('Reply from 10.0.0.2');
  await typeLines(page, ['ping 10.0.0.3']);
  await expect(rows(page)).toContainText('Reply from 10.0.0.3');
  await closeDialog(page);

  // Dsl1 in Gruppe 2 → Router nicht mehr erreichbar, Server (Gruppe 1) weiter
  await click(page, 380, 250, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByLabel('Gruppe Dsl1').selectOption('2');
  await expect(dlg.getByLabel('Gruppe Dsl1')).toHaveValue('2');
  await closeDialog(page);
  await openCmd(page, 60, 160);
  await typeLines(page, ['cls', 'ping -n 1 10.0.0.2']);
  await expect(rows(page)).toContainText('Request timed out');
  await typeLines(page, ['ping -n 1 10.0.0.3']);
  await expect(rows(page)).toContainText('Reply from 10.0.0.3');
  await closeDialog(page);

  // Zurück in Gruppe 1 → wieder erreichbar
  await click(page, 380, 250, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByLabel('Gruppe Dsl1').selectOption('1');
  await closeDialog(page);
  await openCmd(page, 60, 160);
  await typeLines(page, ['cls', 'ping 10.0.0.2']);
  await expect(rows(page)).toContainText('Reply from 10.0.0.2');
  await closeDialog(page);

  // Das DSL-Modem hat eine feste Zuordnung (keine Auswahlfelder)
  await click(page, 200, 160, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await expect(dlg.getByRole('table', { name: 'Port-Zuordnung' })).toBeVisible();
  await expect(dlg.getByLabel(/^Gruppe /)).toHaveCount(0);
  expect(errors).toEqual([]);
});
