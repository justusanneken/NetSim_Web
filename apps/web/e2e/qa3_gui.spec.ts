import { expect, test } from '@playwright/test';
import { click, closeDialog, collectErrors, place } from './helpers';

test('Seitenleiste zeigt eine im Gerätedialog geänderte IP (kein veraltetes Formular)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  await place(page, 'Endgeräte', 'PC', 160, 140);
  const side = page.locator('.device-panel');
  await expect(side.getByLabel('IPv4-Adresse')).toHaveValue('');

  await click(page, 160, 140, 2);
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'IP-Konfiguration' }).click();
  await dlg.getByLabel('IPv4-Adresse').fill('10.0.0.5');
  await dlg.getByLabel('Standard-Gateway').fill('10.0.0.1');
  await dlg.getByRole('button', { name: 'Übernehmen' }).first().click();
  await closeDialog(page);

  await expect(side.getByLabel('IPv4-Adresse')).toHaveValue('10.0.0.5');
  await expect(side.getByLabel('Standard-Gateway')).toHaveValue('10.0.0.1');
  // „Übernehmen“ in der Seitenleiste (z. B. nur DNS ändern) darf die IP nicht löschen
  await side.getByLabel('DNS-Server').fill('10.0.0.53');
  await side.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByRole('list', { name: 'Netzwerk-Info' })).toContainText('10.0.0.5');
  expect(errors).toEqual([]);
});
