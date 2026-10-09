import { expect, test } from '@playwright/test';
import { cable, click, closeDialog, collectErrors, hostIp, place, warp } from './helpers';

test('GUI: Mail – Konten am Server, Senden/Abrufen per E-Mail-Client, falsches Passwort, unbekannter Empfänger', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await place(page, 'Endgeräte', 'Server', 120, 220);
  await place(page, 'Netzwerk', 'Switch', 320, 220);
  await place(page, 'Endgeräte', 'PC', 520, 120);
  await place(page, 'Endgeräte', 'PC', 520, 320);
  await cable(page, [
    [120, 220, 320, 220],
    [320, 220, 520, 120],
    [320, 220, 520, 320],
  ]);
  await hostIp(page, 120, 220, '10.0.0.10');
  await hostIp(page, 520, 120, '10.0.0.21');
  await hostIp(page, 520, 320, '10.0.0.22');

  await warp(page);

  // Server: Mail-Dienst, Domäne, zwei Konten
  await click(page, 120, 220, 2);
  const dlg = page.getByRole('dialog');
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByRole('checkbox', { name: 'Mail (SMTP/POP3)' }).click();
  await expect(dlg.getByRole('checkbox', { name: 'Mail (SMTP/POP3)' })).toBeChecked();
  const mail = dlg.locator('details.svc5').filter({
    has: page.getByRole('checkbox', { name: 'Mail (SMTP/POP3)' }),
  });
  await mail.locator('summary').click({ position: { x: 4, y: 4 } });
  await mail.getByLabel('Mail-Domäne').fill('lab.test');
  await mail.getByLabel('Mail-Domäne').blur();
  for (const [u, p] of [
    ['alice', 'pw-a'],
    ['bob', 'pw-b'],
  ] as const) {
    await mail.getByLabel('mail Benutzer').fill(u);
    await mail.getByLabel('mail Passwort').fill(p);
    await mail.getByRole('button', { name: 'Hinzufügen' }).click();
  }
  await expect(mail.getByRole('list', { name: 'Benutzer' })).toContainText('bob');
  await closeDialog(page);

  const account = async (x: number, y: number, addr: string, pass: string) => {
    await click(page, x, y, 2);
    await dlg.getByRole('button', { name: 'E-Mail' }).click();
    await dlg.getByLabel('Mailserver (IP)').fill('10.0.0.10');
    await dlg.getByLabel('E-Mail-Adresse').fill(addr);
    await dlg.getByLabel('Passwort').fill(pass);
  };

  // Alice (PC 1): falsches Passwort, unbekannter Empfänger, dann Senden
  await account(520, 120, 'alice@lab.test', 'falsch');
  await dlg.getByLabel('An', { exact: true }).fill('bob@lab.test');
  await dlg.getByLabel('Betreff').fill('Hallo');
  await dlg.getByLabel('Text', { exact: true }).fill('Testnachricht');
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await expect(dlg.getByTestId('mail-status')).toContainText('535 Authentication failed');
  await dlg.getByLabel('Passwort').fill('pw-a');
  await dlg.getByLabel('An', { exact: true }).fill('niemand@lab.test');
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await expect(dlg.getByTestId('mail-status')).toContainText('550 Unknown recipient');
  await dlg.getByLabel('An', { exact: true }).fill('bob@lab.test');
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await expect(dlg.getByTestId('mail-status')).toContainText('Nachricht gesendet');
  await closeDialog(page);

  // Bob (PC 2): falsches Passwort beim Abrufen, dann richtig
  await account(520, 320, 'bob@lab.test', 'falsch');
  await dlg.getByRole('button', { name: 'Abrufen' }).click();
  await expect(dlg.getByTestId('mail-status')).toContainText('authentication failed');
  await dlg.getByLabel('Passwort').fill('pw-b');
  await dlg.getByRole('button', { name: 'Abrufen' }).click();
  await expect(dlg.getByTestId('mail-status')).toContainText('1 Nachricht(en)');
  await dlg.getByRole('button', { name: /alice@lab.test: Hallo/ }).click();
  await expect(dlg.locator('pre')).toContainText('Testnachricht');
  await closeDialog(page);

  // Server-Panel zeigt das Postfach
  await click(page, 120, 220, 2);
  await page.getByRole('tab', { name: 'Konfiguration' }).click();
  await mail.locator('summary').click({ position: { x: 4, y: 4 } });
  await expect(mail).toContainText('bob: 1');
  expect(errors).toEqual([]);
});
