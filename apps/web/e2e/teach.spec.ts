import { expect, test, type Page } from '@playwright/test';
import { cable, click, closeDialog, collectErrors, hostIp, place, typeLines } from './helpers';

/** Zwei PCs, direkt verbunden, mit IP-Adressen. */
async function twoPcs(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();
  await place(page, 'Endgeräte', 'PC', 160, 140);
  await page.waitForTimeout(300);
  await place(page, 'Endgeräte', 'PC', 160, 320);
  await page.waitForTimeout(300);
  await cable(page, [[160, 140, 160, 320]]);
  await hostIp(page, 160, 140, '10.0.0.1');
  await hostIp(page, 160, 320, '10.0.0.2');
}

test('Szenarien: Complex PDU mit Wiederholung, Status, Rerun und mehrere Szenarien', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await twoPcs(page);

  await page.getByText('Szenarien & PDU-Liste').click();
  await page.getByRole('button', { name: 'Complex PDU …', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Complex PDU …' });
  await dlg.getByLabel('Quellgerät').selectOption({ label: 'PC0' });
  await dlg.getByLabel('Protokoll').selectOption('icmp');
  await dlg.getByLabel(/^Ziel \(/).fill('10.0.0.2');
  await dlg.getByLabel('Start nach (s)').fill('1');
  await dlg.getByLabel('Anzahl').fill('3');
  await dlg.getByLabel('Abstand (s)').fill('1');
  await dlg.getByRole('button', { name: 'Senden', exact: true }).click();

  const list = page.getByRole('table', { name: 'PDU-Liste' });
  await expect(list.getByRole('row')).toHaveCount(2); // Kopf + 1
  await expect(list.getByText('Läuft')).toBeVisible();
  await expect(list.getByText('Erfolgreich')).toBeVisible({ timeout: 30_000 });
  await expect(list.getByRole('row').nth(1)).toContainText('3/3');

  // zweite PDU: UDP auf einen Port ohne Dienst -> Failed
  await page.getByRole('button', { name: 'Complex PDU …', exact: true }).click();
  const d2 = page.getByRole('dialog', { name: 'Complex PDU …' });
  await d2.getByLabel('Protokoll').selectOption('udp');
  await d2.getByLabel(/^Ziel \(/).fill('10.0.0.2');
  await d2.getByLabel('Zielport').fill('5000');
  await d2.getByRole('button', { name: 'Senden', exact: true }).click();
  await expect(list.getByRole('row')).toHaveCount(3);
  await expect(list.getByText('Fehlgeschlagen')).toBeVisible({ timeout: 30_000 });
  await expect(list).toContainText('Kein Dienst auf dem Zielport');

  // Rerun der ersten PDU
  await page.getByRole('button', { name: 'PDU 1 erneut senden' }).click();
  await expect(list.getByRole('row').nth(1)).toContainText('Läuft');
  await expect(list.getByRole('row').nth(1)).toContainText('Erfolgreich', { timeout: 30_000 });

  // Delete
  await page.getByRole('button', { name: 'PDU 2 löschen' }).click();
  await expect(list.getByRole('row')).toHaveCount(2);

  // Simple PDU über das Werkzeug landet ebenfalls in der Liste
  await page.getByRole('button', { name: 'PDU senden' }).click();
  await click(page, 160, 140);
  await click(page, 160, 320);
  await expect(list.getByRole('row')).toHaveCount(3);
  await expect(list.getByRole('row').nth(2)).toContainText('ICMP');
  await expect(list.getByRole('row').nth(2)).toContainText('Erfolgreich', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Auswählen' }).click();

  // mehrere Szenarien: neues Szenario hat eine leere Liste, das alte bleibt erhalten
  await page.getByLabel('Name', { exact: true }).fill('Test Zwei');
  await page.getByLabel('Beschreibung').fill('Zweites Szenario');
  await page.getByLabel('Beschreibung').blur();
  await page.getByRole('button', { name: 'Neu', exact: true }).click();
  await expect(page.getByText('Noch keine PDUs.')).toBeVisible();
  await page.getByLabel('Szenario', { exact: true }).selectOption({ index: 0 });
  await expect(page.getByRole('table', { name: 'PDU-Liste' }).getByRole('row')).toHaveCount(3);
  await expect(page.getByLabel('Beschreibung')).toHaveValue('Zweites Szenario');
  await page.getByLabel('Szenario', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Szenario löschen' }).click();
  await expect(page.getByLabel('Szenario', { exact: true }).locator('option')).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('Aufgabe: Beispiel laden, teilweise lösen, Fortschritt sehen, vollständig lösen', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('.canvas-wrap canvas').first()).toBeVisible();

  await page.getByText('Aufgabe', { exact: true }).click();
  await page.getByLabel('Beispiel', { exact: true }).selectOption({ label: 'ACL sperrt HTTP aus dem Gastnetz' });
  await page.getByRole('button', { name: 'Beispiel laden' }).click();
  await expect(page.getByRole('heading', { name: 'ACL sperrt HTTP aus dem Gastnetz' })).toBeVisible();
  await expect(page.getByTestId('act-percent')).toHaveText('noch nicht geprüft');
  await expect(page.getByRole('list', { name: 'Netzwerk-Info' }).getByRole('listitem')).toHaveCount(4);

  // Startnetz: nur Ping und Staff-HTTP funktionieren (4 von 12 Gewichtspunkten)
  await page.getByRole('button', { name: 'Prüfen', exact: true }).click();
  await expect(page.getByTestId('act-percent')).toHaveText('33 %', { timeout: 30_000 });
  const checks = page.getByRole('list', { name: 'Prüfungen' });
  await expect(checks.locator('[data-state="fail"]')).toHaveCount(4);
  await expect(checks.locator('[data-state="pass"]')).toHaveCount(2);
  await expect(checks).toContainText('ACL GUEST-IN enthält keinen passenden');

  // Hinweis auf Abruf
  await checks.getByRole('button', { name: 'Hinweis anzeigen' }).first().click();
  await expect(checks).toContainText(/Wildcard-Maske|Sonst blockiert|ip access-group/);

  // Router öffnen (R1 bei 350/200) und die ACL anlegen, aber noch nicht anwenden
  await click(page, 350, 200, 2);
  await page.getByRole('dialog').getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, [
    'enable',
    'configure terminal',
    'ip access-list extended GUEST-IN',
    'deny tcp 192.168.20.0 0.0.0.255 host 192.168.30.10 eq 80',
    'permit ip any any',
    'end',
  ]);
  await page.waitForTimeout(500);
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await page.getByRole('button', { name: 'Prüfen', exact: true }).click();
  await expect(page.getByTestId('act-percent')).toHaveText('58 %', { timeout: 30_000 });

  // ACL an die Schnittstelle binden -> alles erfüllt
  await click(page, 350, 200, 2);
  await page.getByRole('dialog').getByRole('tab', { name: 'CLI' }).click();
  await page.locator('.xterm').click();
  await typeLines(page, [
    'configure terminal',
    'interface gigabitethernet0/0',
    'ip access-group GUEST-IN in',
    'end',
  ]);
  await page.waitForTimeout(500);
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await page.getByRole('button', { name: 'Prüfen', exact: true }).click();
  await expect(page.getByTestId('act-percent')).toHaveText('100 %', { timeout: 30_000 });
  await expect(page.getByText('Bestanden!')).toBeVisible();
  await expect(checks.locator('[data-state="pass"]')).toHaveCount(6);

  // Sperren der Aufgabe: keine Geräte hinzufügen
  await page.getByRole('tab', { name: 'Endgeräte' }).click();
  await expect(page.getByRole('button', { name: 'PC', exact: true }).first()).toBeDisabled();

  // Neustart setzt das Startnetz zurück
  await page.getByRole('button', { name: 'Neu starten' }).click();
  await page.getByRole('button', { name: 'Prüfen', exact: true }).click();
  await expect(page.getByTestId('act-percent')).toHaveText('33 %', { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('Challenge Me: Frage zum Echo-Request beantworten und Punktestand', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await twoPcs(page);
  await page.getByRole('button', { name: 'PDU senden' }).click();
  await click(page, 160, 140);
  await click(page, 160, 320);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Auswählen' }).click();

  const row = page.getByRole('row').filter({ hasText: 'echo-request' }).first();
  await row.click();
  await page.getByLabel('Challenge Me').check();
  const quiz = page.locator('.challenge-quiz');
  await expect(quiz).toContainText('Echo-Request');
  // die Erklärung der Engine ist erst nach der Antwort sichtbar
  await expect(page.locator('.explain')).toHaveCount(0);

  const q = quiz.locator('fieldset', { hasText: 'Was tut der Host?' });
  await q.getByLabel(/Echo-Reply an 10\.0\.0\.1 senden/).check();
  await expect(q).toContainText('Richtig.');
  await expect(q).toContainText('Der Host schickt einen Echo-Reply'.slice(0, 20));
  await expect(page.getByTestId('challenge-score')).toContainText('1 von 1 richtig (100 %)');

  // falsche Antwort: Punktestand sinkt, die richtige Option wird markiert
  const layer = quiz.locator('fieldset', { hasText: 'Bis zu welcher Schicht' });
  await layer.getByLabel('Schicht 7').check();
  await expect(layer).toContainText('Leider falsch.');
  await expect(layer.locator('.is-correct')).toContainText('Schicht 3');
  await expect(page.getByTestId('challenge-score')).toContainText('1 von 2 richtig (50 %)');

  // Antworten sind endgültig, Zurücksetzen löscht den Stand
  await expect(q.getByLabel(/Echo-Reply an 10\.0\.0\.1 senden/)).toBeDisabled();
  await page.getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect(page.getByTestId('challenge-score')).toContainText('0 von 0');
  expect(errors).toEqual([]);
  void closeDialog;
});
