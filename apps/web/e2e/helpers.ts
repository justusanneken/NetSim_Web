import { expect, type Page } from '@playwright/test';

export async function place(
  page: Page,
  tab: string,
  label: string,
  x: number,
  y: number,
): Promise<void> {
  await page.getByRole('tab', { name: tab }).click();
  await page.getByRole('button', { name: label, exact: true }).first().click();
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + x, box.y + y);
}

export async function click(page: Page, x: number, y: number, count = 1): Promise<void> {
  const box = await page.locator('.canvas-wrap').boundingBox();
  if (!box) throw new Error('Canvas fehlt');
  await page.mouse.click(box.x + x, box.y + y, { clickCount: count });
}

export async function typeLines(page: Page, lines: string[]): Promise<void> {
  for (const l of lines) {
    await page.keyboard.type(l, { delay: 2 });
    await page.keyboard.press('Enter');
  }
}

/** Kabel (Automatisch oder gewählter Typ) zwischen zwei Geräten legen. */
export async function cable(
  page: Page,
  pairs: [number, number, number, number][],
  kind = 'Automatisch',
): Promise<void> {
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: kind, exact: true }).click();
  for (const [x1, y1, x2, y2] of pairs) {
    await click(page, x1, y1);
    await click(page, x2, y2);
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: 'Auswählen' }).click();
}

export async function closeDialog(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.waitForTimeout(300);
}

export async function hostIp(
  page: Page,
  x: number,
  y: number,
  ip: string,
  gw?: string,
): Promise<void> {
  await click(page, x, y, 2);
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'IP-Konfiguration' }).click();
  await dlg.getByLabel('IPv4-Adresse').fill(ip);
  if (gw) await dlg.getByLabel('Standard-Gateway').fill(gw);
  await dlg.getByRole('button', { name: 'Übernehmen' }).first().click();
  await closeDialog(page);
}

/** Öffnet das Gerät per Doppelklick und die Eingabeaufforderung. */
export async function openCmd(page: Page, x: number, y: number): Promise<void> {
  await click(page, x, y, 2);
  await page.getByRole('dialog').getByRole('button', { name: 'Eingabeaufforderung' }).click();
  await page.locator('.xterm').click();
}

/** Virtuelle Zeit raffen (z. B. damit Switch-Ports den STP-Zustand „forwarding“ erreichen). */
export async function warp(page: Page, wallMs = 3_000): Promise<void> {
  const speed = page.getByRole('combobox').filter({ hasText: '20×' });
  await speed.selectOption('20');
  await page.waitForTimeout(wallMs);
  await speed.selectOption('1');
}

export const rows = (page: Page) => page.locator('.xterm-rows');

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
