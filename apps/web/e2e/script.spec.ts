import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function openConsole(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Extras' }).click();
  await page.getByRole('menuitem', { name: 'Skript-Konsole' }).click();
  await expect(page.getByRole('dialog', { name: 'Skript-Konsole' })).toBeVisible();
}

test('Skript-Konsole: Beispiel „3-Router-OSPF-Labor“ läuft und baut das Netz auf', async ({
  page,
}) => {
  await openConsole(page);
  const dlg = page.getByRole('dialog', { name: 'Skript-Konsole' });
  await dlg.getByLabel('Beispiele').selectOption({ label: '3-Router-OSPF-Labor aufbauen und prüfen' });
  await dlg.getByRole('button', { name: 'Ausführen' }).click();
  const out = dlg.getByRole('log', { name: 'Skript-Ausgabe' });
  await expect(out).toContainText('OSPF konvergiert: true', { timeout: 30_000 });
  await expect(out).toContainText('O        10.0.23.0');
  await dlg.getByRole('button', { name: 'Skript-Konsole schließen' }).click();
  const list = page.getByRole('list', { name: /Netz/ });
  for (const n of ['R1', 'R2', 'R3']) await expect(list).toContainText(n);
});

test('Skript-Konsole: Fehler wird mit Zeilennummer gemeldet, Sandbox blockt eval', async ({
  page,
}) => {
  await openConsole(page);
  const dlg = page.getByRole('dialog', { name: 'Skript-Konsole' });
  await dlg.getByLabel('Skript-Editor').fill("log('hallo');\neval('1+1');");
  await dlg.getByRole('button', { name: 'Ausführen' }).click();
  const out = dlg.getByRole('log', { name: 'Skript-Ausgabe' });
  await expect(out).toContainText('hallo');
  await expect(out).toContainText('Fehler:');
});

test('Skript-Konsole: Stopp bricht eine Endlosschleife ab', async ({ page }) => {
  await openConsole(page);
  const dlg = page.getByRole('dialog', { name: 'Skript-Konsole' });
  await dlg
    .getByLabel('Skript-Editor')
    .fill('for (;;) { engine.runFor(1); }');
  await dlg.getByRole('button', { name: 'Ausführen' }).click();
  await expect(dlg.getByRole('button', { name: 'Stopp' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Stopp' }).click();
  await expect(dlg.getByRole('log', { name: 'Skript-Ausgabe' })).toContainText('Abgebrochen');
  await expect(dlg.getByRole('button', { name: 'Ausführen' })).toBeEnabled();
});

test('PCAP-Export: Datei beginnt mit libpcap-Magic, Hex-Ansicht im Inspektor', async ({ page }) => {
  await openConsole(page);
  const dlg = page.getByRole('dialog', { name: 'Skript-Konsole' });
  await dlg
    .getByLabel('Beispiele')
    .selectOption({ label: 'Ereignisse zählen (onPacket/onLinkChange)' });
  await dlg.getByRole('button', { name: 'Ausführen' }).click();
  await expect(dlg.getByRole('log', { name: 'Skript-Ausgabe' })).toContainText('Pakete:', {
    timeout: 30_000,
  });
  await dlg.getByRole('button', { name: 'Skript-Konsole schließen' }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'PCAP exportieren' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('netsim.pcap');
  const path = await download.path();
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 4)]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
  expect(bytes.readUInt16LE(4)).toBe(2);
  expect(bytes.readUInt32LE(20)).toBe(1); // LINKTYPE_ETHERNET
  expect(bytes.length).toBeGreaterThan(24 + 16 + 60);

  // Hex-Ansicht eines ICMP-Echo-Ereignisses
  await page.locator('.event', { hasText: 'echo-request' }).first().click();
  await page.getByRole('button', { name: 'Hex', exact: true }).click();
  const hex = page.getByLabel('Frame-Bytes (Hexdump)');
  await expect(hex).toContainText('0000  ');
  await expect(hex).toContainText('08 00 45 00');
});
