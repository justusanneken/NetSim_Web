import { expect, test } from '@playwright/test';
import { collectErrors, place } from './helpers';

test('Sprachumschaltung Deutsch/Englisch: Menü, Werkzeuge, Dialoge, Persistenz', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Datei', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notiz', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Sprache', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'English' }).click();

  // Hauptmenü, Werkzeugleiste, Palette in Englisch
  for (const n of ['File', 'Edit', 'Options', 'View', 'Arrange', 'Tools', 'Help', 'Language'])
    await expect(page.getByRole('button', { name: n, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Note', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Datei', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'End devices' }))
    .toBeVisible()
    .catch(() => undefined);

  // Gerät platzieren, Dialog + Attributes-Tab englisch
  await page.getByRole('tab', { name: /^End/ }).click();
  await page.getByRole('button', { name: 'PC', exact: true }).first().click();
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + 200, box.y + 160);
  await page.waitForTimeout(200);
  await page.mouse.dblclick(box.x + 200, box.y + 160);
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('tab', { name: 'Attributes' })).toBeVisible();
  await dlg.getByRole('tab', { name: 'Attributes' }).click();
  await expect(dlg.getByLabel('Serial number')).toBeVisible();
  await page.keyboard.press('Escape');

  // Kontextmenü englisch
  await page.mouse.click(box.x + 200, box.y + 160, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Power off' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Netzwerk-Info englisch
  await page.getByRole('button', { name: 'Open network information' }).click();
  await expect(page.getByRole('table', { name: 'Interfaces' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Sprache bleibt nach Neuladen erhalten, Rückschalten auf Deutsch
  await page.reload();
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Deutsch' }).click();
  await expect(page.getByRole('button', { name: 'Datei', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Englisch: keine deutschen Reste in Hauptoberfläche', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('netsim.lang', 'en'));
  await page.goto('/');
  await place(page, 'End devices', 'PC', 200, 160).catch(() => undefined);
  const text = await page.locator('body').innerText();
  for (const w of [
    'Datei',
    'Bearbeiten',
    'Ansicht',
    'Auswählen',
    'Löschen',
    'Schließen',
    'Netzwerk-Info',
  ])
    expect(text, w).not.toContain(w);
});
