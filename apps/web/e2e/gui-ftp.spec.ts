import { expect, test } from '@playwright/test';
import {
  cable,
  click,
  closeDialog,
  collectErrors,
  hostIp,
  place,
  rows,
  typeLines,
} from './helpers';

test('GUI: FTP – Server-Benutzer, put/get/dir und falsches Passwort über die Eingabeaufforderung', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await place(page, 'Endgeräte', 'Server', 120, 220);
  await place(page, 'Endgeräte', 'PC', 420, 220);
  await cable(page, [[120, 220, 420, 220]]);
  await hostIp(page, 120, 220, '10.0.0.10');
  await hostIp(page, 420, 220, '10.0.0.20');

  // Server: FTP einschalten, Benutzer anlegen
  await click(page, 120, 220, 2);
  const dlg = page.getByRole('dialog');
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByRole('checkbox', { name: 'FTP', exact: true }).click();
  await expect(dlg.getByRole('checkbox', { name: 'FTP', exact: true })).toBeChecked();
  const ftp = dlg
    .locator('details.svc5')
    .filter({ has: page.getByRole('checkbox', { name: 'FTP', exact: true }) });
  await ftp.locator('summary').click({ position: { x: 4, y: 4 } });
  await ftp.getByLabel('ftp Benutzer').fill('bob');
  await ftp.getByLabel('ftp Passwort').fill('geheim');
  await ftp.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(ftp.getByRole('list', { name: 'Benutzer' })).toContainText('bob');
  await closeDialog(page);

  // PC: Datei anlegen (Desktop → Dateien)
  await click(page, 420, 220, 2);
  await dlg.getByRole('button', { name: 'Dateien' }).click();
  await dlg.getByLabel('Dateiname').fill('hallo.txt');
  await dlg.getByLabel('Inhalt').fill('Hallo FTP');
  await dlg.getByRole('button', { name: 'Speichern' }).click();
  await expect(dlg.getByRole('list', { name: 'Dateien' })).toContainText('hallo.txt');

  // ftp: falsches Passwort, dann richtig; put, dir, get
  await dlg.getByRole('button', { name: 'Eingabeaufforderung' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, ['ftp 10.0.0.10']);
  await expect(rows(page)).toContainText('User (10.0.0.10');
  await typeLines(page, ['bob', 'falsch']);
  await expect(rows(page)).toContainText('Login failed');
  await typeLines(page, ['bob', 'geheim']);
  await expect(rows(page)).toContainText('ftp>');
  await typeLines(page, ['put hallo.txt']);
  await typeLines(page, ['dir']);
  await expect(rows(page)).toContainText('226 Transfer complete');
  await expect(rows(page)).toContainText('hallo.txt');
  await typeLines(page, ['get hallo.txt kopie.txt']);
  await expect(rows(page)).toContainText('bytes received');
  await typeLines(page, ['quit']);
  await dlg.getByRole('button', { name: 'Dateien' }).click();
  await expect(dlg.getByRole('list', { name: 'Dateien' })).toContainText('kopie.txt');
  await closeDialog(page);

  // Datei liegt auf dem Server-Panel
  await click(page, 120, 220, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  const ftp2 = dlg.locator('details.svc5').filter({
    has: page.getByRole('checkbox', { name: 'FTP', exact: true }),
  });
  await ftp2.locator('summary').click({ position: { x: 4, y: 4 } });
  await expect(ftp2.getByRole('list', { name: 'Dateien' })).toContainText('hallo.txt');
  expect(errors).toEqual([]);
});
