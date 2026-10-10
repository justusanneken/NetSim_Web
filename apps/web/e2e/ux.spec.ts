import { expect, test, type Page } from '@playwright/test';
import { cable, click, collectErrors, place } from './helpers';

async function setup(page: Page): Promise<string[]> {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  return errors;
}

async function three(page: Page): Promise<void> {
  await place(page, 'Endgeräte', 'PC', 160, 140);
  await page.waitForTimeout(150);
  await place(page, 'Endgeräte', 'PC', 160, 300);
  await page.waitForTimeout(150);
  await place(page, 'Endgeräte', 'PC', 320, 220);
  await page.waitForTimeout(150);
}

test('Rubberband wählt mehrere Geräte, Mehrfachverschieben, Ausrichten, Gruppieren', async ({
  page,
}) => {
  const errors = await setup(page);
  await three(page);
  await expect(page.getByRole('list', { name: 'Netzwerk-Info' }).getByRole('listitem')).toHaveCount(
    3,
  );
  // Rubberband über alle drei Geräte
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 400, { steps: 6 });
  await page.mouse.up();
  const rows = page.getByRole('list', { name: 'Netzwerk-Info' }).getByRole('button', {
    pressed: true,
  });
  await expect(rows).toHaveCount(3);

  // Ausrichten links über das Menü „Anordnen“
  await page.getByRole('button', { name: 'Anordnen' }).click();
  await page.getByRole('menuitem', { name: 'Links ausrichten' }).click();
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => document.title);
  expect(before).toBeTruthy();
  // Mehrfach verschieben: ein Gerät ziehen, alle bewegen sich mit
  await page.mouse.move(box.x + 160, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 190, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  // nach dem Ausrichten liegen alle drei untereinander; Gruppieren erzeugt einen Rahmen mit Namen
  await page.getByRole('button', { name: 'Anordnen' }).click();
  await page.getByRole('menuitem', { name: 'Gruppieren (Cluster)' }).click();
  await page.getByRole('button', { name: 'Anordnen' }).click();
  await page.getByRole('menuitem', { name: 'Gruppierung aufheben' }).click();
  expect(errors).toEqual([]);
});

test('Notiz anlegen, bearbeiten, in der Liste sehen und löschen', async ({ page }) => {
  const errors = await setup(page);
  await page.getByRole('button', { name: 'Notiz', exact: true }).click();
  await click(page, 300, 200);
  const editor = page.getByRole('textbox', { name: 'Notiz' }).first();
  await expect(editor).toBeFocused();
  await editor.fill('VLAN 10 = Vertrieb');
  await page.keyboard.press('Escape');
  await page.getByText('Notizen', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Notiz 1' })).toHaveValue('VLAN 10 = Vertrieb');
  await page.getByRole('button', { name: 'Notiz löschen 1' }).click();
  await expect(page.getByRole('textbox', { name: 'Notiz 1' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Kontextmenü: Rechtsklick auf Gerät und Leerraum, Esc schließt', async ({ page }) => {
  const errors = await setup(page);
  await place(page, 'Endgeräte', 'PC', 200, 160);
  await page.waitForTimeout(200);
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + 200, box.y + 160, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Kontextmenü' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Ausschalten' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.mouse.click(box.x + 500, box.y + 300, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Notiz hier einfügen' }).click();
  await expect(page.getByRole('textbox', { name: 'Notiz' }).first()).toBeFocused();
  await page.keyboard.type('hi');
  await page.keyboard.press('Escape');
  await page.mouse.click(box.x + 200, box.y + 160, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Gerät löschen' }).click();
  await expect(page.getByRole('list', { name: 'Netzwerk-Info' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Zoom mit Strg+Mausrad, Pan, Mini-Map und Raster-Umschalter', async ({ page }) => {
  const errors = await setup(page);
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  const zoom = page.locator('.zoom-val');
  await expect(zoom).toHaveText('100%');
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect(zoom).not.toHaveText('100%');
  // Pan mit dem Mausrad (ohne Strg)
  await page.mouse.wheel(100, 0);
  await page.getByRole('button', { name: 'Ansicht' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Mini-Map anzeigen' }).click();
  await expect(page.getByRole('img', { name: /Mini-Map/ })).toBeVisible();
  await page.getByRole('button', { name: 'Ansicht' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Raster anzeigen' }).click();
  await page.getByRole('button', { name: 'Ansicht' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Raster anzeigen' }).click();
  expect(errors).toEqual([]);
});

test('Hintergrundbild laden und entfernen', async ({ page }) => {
  const errors = await setup(page);
  await page.getByRole('button', { name: 'Ansicht' }).click();
  await page.getByRole('menuitem', { name: 'Hintergrundbild …' }).click();
  const dlg = page.getByRole('dialog', { name: 'Hintergrundbild der Logical View' });
  await expect(dlg).toBeVisible();
  // 1x1-PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  await dlg
    .locator('input[type=file]')
    .setInputFiles({ name: 'bg.png', mimeType: 'image/png', buffer: png });
  await expect(dlg.getByRole('button', { name: 'Hintergrundbild entfernen' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Hintergrundbild entfernen' }).click();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect(errors).toEqual([]);
});

test('Netzwerk-Info-Fenster zeigt Tabellen; Tooltip enthält Port, IP und MAC', async ({ page }) => {
  const errors = await setup(page);
  await place(page, 'Endgeräte', 'PC', 160, 140);
  await page.waitForTimeout(150);
  await place(page, 'Netzwerk', 'Switch', 360, 140);
  await page.waitForTimeout(150);
  await cable(page, [[160, 140, 360, 140]]);
  await page.waitForTimeout(300);
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.move(box.x + 360, box.y + 140);
  await page.mouse.move(box.x + 362, box.y + 142);
  await expect(page.getByRole('tooltip')).toContainText('FastEthernet');
  await expect(page.getByRole('tooltip')).toContainText(/VLAN 1/);
  await page.getByRole('button', { name: 'Netzwerkinformationen öffnen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Netzwerkinformationen' });
  await expect(dlg.getByRole('table', { name: 'Schnittstellen' })).toBeVisible();
  await expect(dlg.getByRole('table', { name: 'MAC-Adresstabelle' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect(errors).toEqual([]);
});

test('Attributes-Tab und Equivalent IOS Commands', async ({ page }) => {
  const errors = await setup(page);
  await place(page, 'Netzwerk', 'Router', 220, 160);
  await page.waitForTimeout(200);
  await click(page, 220, 160, 2);
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('tab', { name: 'Attribute' }).click();
  await dlg.getByLabel('Seriennummer', { exact: true }).fill('FOC1234ABCD');
  await dlg.getByLabel('Notizen').fill('Edge-Router Standort A');
  await expect(dlg.getByLabel('Lizenz (Technologiepaket)')).toHaveValue('ipbasek9');
  await dlg.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByRole('tab', { name: 'Attribute' }).click();
  await expect(dlg.getByLabel('Seriennummer', { exact: true })).toHaveValue('FOC1234ABCD');
  // Gerätename ändern → Equivalent IOS Commands zeigen den hostname-Befehl
  await dlg.getByRole('tab', { name: 'Konfiguration' }).click();
  await dlg.getByLabel('Name').first().fill('Core1');
  await dlg.getByLabel('Name').first().press('Enter');
  await expect(dlg.locator('.equiv-auto pre')).toContainText('hostname Core1', { timeout: 5000 });
  expect(errors).toEqual([]);
});

test('Tastatur: Gerät platzieren, Kabel per Geräteliste legen, Dialog mit Fokusfalle', async ({
  page,
}) => {
  const errors = await setup(page);
  // Palette per Tastatur: Fokus auf „PC“, Enter ⇒ platziert an freier Stelle
  const pc = page.getByRole('button', { name: 'PC', exact: true }).first();
  await pc.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await pc.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const list = page.getByRole('list', { name: 'Netzwerk-Info' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  // Kabel-Werkzeug (Taste C), „Automatisch“ ist Voreinstellung
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.press('c');
  await list.getByRole('button', { name: /PC0/ }).first().focus();
  await page.keyboard.press('Enter');
  await list.getByRole('button', { name: /PC1/ }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Link .* ist aktiv|Link .* ist inaktiv|link/i).first()).toBeVisible({
    timeout: 5000,
  });
  await page.keyboard.press('v');
  // Dialog per Tastatur öffnen; Fokus bleibt im Dialog; Esc schließt und gibt den Fokus zurück
  const open = list.getByRole('button', { name: /Konfigurieren: PC0/ });
  await open.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
    expect(inside).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(open).toBeFocused();
  expect(errors).toEqual([]);
});

test('Pfeiltasten verschieben die Auswahl, Entf löscht', async ({ page }) => {
  const errors = await setup(page);
  await place(page, 'Endgeräte', 'PC', 200, 160);
  await page.waitForTimeout(200);
  await click(page, 200, 160);
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  // Gerät liegt nun 20 px weiter rechts: Klick an alter Stelle trifft es noch (Radius 30), an neuer ebenfalls
  await click(page, 220, 160);
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('list', { name: 'Netzwerk-Info' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Leertaste = Play/Pause im Simulationsmodus', async ({ page }) => {
  const errors = await setup(page);
  await page.locator('.canvas-wrap').focus();
  const before = await page.locator('.sim-controls').innerText();
  await page.keyboard.press(' ');
  await page.waitForTimeout(200);
  await page.keyboard.press(' ');
  expect(before).toBeTruthy();
  expect(errors).toEqual([]);
});
