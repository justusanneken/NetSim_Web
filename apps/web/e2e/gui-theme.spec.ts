import { expect, test, type Page } from '@playwright/test';
import { scanContrast, type ContrastIssue } from './contrast';
import {
  cable,
  click,
  closeDialog,
  collectErrors,
  hostIp,
  place,
  typeLines,
  warp,
} from './helpers';

test.use({ viewport: { width: 1280, height: 800 }, actionTimeout: 8_000 });

/** Schaltet Dunkel-/Farbenblind-Modus über das Optionen-Menü auf den gewünschten Zustand. */
async function setModes(page: Page, dark: boolean, cb: boolean): Promise<void> {
  const root = page.locator('html');
  const want = async (attr: string, on: boolean, item: string): Promise<void> => {
    const isOn = (await root.getAttribute(attr)) === (attr === 'data-theme' ? 'dark' : '1');
    if (isOn === on) return;
    await page.getByRole('button', { name: 'Optionen', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: item }).click();
  };
  await want('data-theme', dark, 'Dunkles Design');
  await want('data-colorblind', cb, 'Farbenblind-Modus (Muster)');
  await expect(root).toHaveAttribute('data-theme', dark ? 'dark' : 'light');
  await expect(root).toHaveAttribute('data-colorblind', cb ? '1' : '0');
}

async function buildScenario(page: Page): Promise<void> {
  await place(page, 'Endgeräte', 'PC', 120, 120);
  await place(page, 'Netzwerk', 'Switch', 320, 120);
  await place(page, 'Netzwerk', 'Router', 520, 120);
  await place(page, 'Endgeräte', 'Server', 320, 260);
  await cable(page, [
    [120, 120, 320, 120],
    [320, 120, 520, 120],
    [320, 120, 320, 260],
  ]);
  await hostIp(page, 120, 120, '10.0.0.1', '10.0.0.254');
  await hostIp(page, 320, 260, '10.0.0.10');
}

type Shot = { screen: string; issues: ContrastIssue[]; checked: number; min: number };

async function scan(page: Page, screen: string, out: Shot[]): Promise<void> {
  const r = await scanContrast(page);
  out.push({ screen, issues: r.issues, checked: r.checked, min: r.min });
}

async function tab(page: Page, name: string): Promise<void> {
  await page.getByRole('dialog').getByRole('tab', { name, exact: true }).click();
  await page.waitForTimeout(150);
}

async function app(page: Page, name: string): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(150);
}

async function allScreens(page: Page, out: Shot[]): Promise<void> {
  // Toast (OK): IP-Konfiguration übernehmen
  await click(page, 120, 120, 2);
  await app(page, 'IP-Konfiguration');
  await page.getByRole('dialog').getByRole('button', { name: 'Übernehmen' }).first().click();
  await expect(page.locator('.toast.ok')).toBeVisible();
  await scan(page, 'toast/OK', out);
  await closeDialog(page);

  // Hauptansicht: Auswahl eines Geräts (Seitenleiste), alle Palettenreiter
  await click(page, 120, 120);
  await scan(page, 'main/Auswahl', out);
  for (const cat of ['Endgeräte', 'Netzwerk', 'Drahtlos', 'WAN / Modem', 'IoT', 'Kabel']) {
    await page.getByRole('tab', { name: cat, exact: true }).click();
    await scan(page, `palette/${cat}`, out);
  }
  await page.getByRole('tab', { name: 'Endgeräte' }).click();

  // Menüs und Port-Picker
  await page.getByRole('button', { name: 'Optionen', exact: true }).click();
  await scan(page, 'menu/Optionen', out);
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 500);

  // Gerätedialog PC: alle Reiter und Desktop-Apps
  await click(page, 120, 120, 2);
  for (const a of [
    'IP-Konfiguration',
    'Eingabeaufforderung',
    'Webbrowser',
    'E-Mail',
    'MIB-Browser',
    'IoT-Monitor',
    'Dateien',
    'Firewall',
  ]) {
    await app(page, a);
    if (a === 'Eingabeaufforderung') {
      await page.locator('.xterm').click();
      await typeLines(page, ['ipconfig', 'ping 10.0.0.10']);
      await page.waitForTimeout(1500);
    }
    await scan(page, `pc/desktop/${a}`, out);
  }
  await tab(page, 'Konfiguration');
  await scan(page, 'pc/Konfiguration', out);
  await tab(page, 'Physical');
  await scan(page, 'pc/Physical', out);
  await closeDialog(page);

  // Server: Konfiguration mit allen Diensten geöffnet
  await click(page, 320, 260, 2);
  await tab(page, 'Konfiguration');
  const summaries = page.getByRole('dialog').locator('details > summary');
  for (let i = 0, n = await summaries.count(); i < n; i++)
    await summaries.nth(i).click({ position: { x: 4, y: 4 } });
  await scan(page, 'server/Konfiguration', out);
  await closeDialog(page);

  // Router: Konfiguration, CLI, Physical
  await click(page, 520, 120, 2);
  await tab(page, 'Konfiguration');
  await scan(page, 'router/Konfiguration', out);
  await tab(page, 'CLI');
  await page.locator('.xterm').click();
  await typeLines(page, ['no', 'enable', 'show ip interface brief']);
  await page.waitForTimeout(600);
  await scan(page, 'router/CLI', out);
  await tab(page, 'Physical');
  await scan(page, 'router/Physical', out);
  await closeDialog(page);

  // Switch
  await click(page, 320, 120, 2);
  await tab(page, 'Konfiguration');
  await scan(page, 'switch/Konfiguration', out);
  await closeDialog(page);

  // Simulationsmodus: Ereignisliste, Umschläge, Inspektor
  await page.getByRole('button', { name: 'Simulation', exact: true }).click();
  await page.getByRole('button', { name: 'PDU', exact: false }).first().click();
  await click(page, 120, 120);
  await click(page, 320, 260);
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Auswählen' }).click();
  await scan(page, 'sim/Ereignisse', out);
  const row = page.locator('.event').first();
  if (await row.count()) {
    await row.click();
    await scan(page, 'sim/Inspektor', out);
  }
  await page.getByRole('button', { name: 'Echtzeit', exact: true }).click();

  // Physical View
  await page.getByRole('button', { name: 'Ansicht', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Physical View' }).click();
  await scan(page, 'physical-view', out);
  await page.getByRole('button', { name: 'Ansicht', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Logical View' }).click();

  // Toast (Fehler): PDU zu einem Gerät ohne IP-Adresse (Switch)
  await page.getByRole('button', { name: 'PDU senden' }).click();
  await click(page, 120, 120);
  await click(page, 320, 120);
  await expect(page.locator('.toast:not(.ok)')).toBeVisible();
  await scan(page, 'toast/Fehler', out);
  await page.getByRole('button', { name: 'Auswählen' }).click();
}

test('GUI: Kontrast in allen Themes (WCAG AA)', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await buildScenario(page);
  await warp(page, 2000);
  const report: Record<string, Shot[]> = {};
  for (const [dark, cb] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    const key = `${dark ? 'dark' : 'light'}${cb ? '+cb' : ''}`;
    await setModes(page, dark, cb);
    const shots: Shot[] = [];
    await allScreens(page, shots);
    report[key] = shots;
  }
  const summary = Object.entries(report).map(([k, shots]) => ({
    mode: k,
    checked: shots.reduce((n, s) => n + s.checked, 0),
    min: Math.min(...shots.map((s) => s.min)),
    issues: shots.flatMap((s) => s.issues.map((i) => ({ screen: s.screen, ...i }))),
  }));
  console.log('CONTRAST ' + JSON.stringify(summary, null, 1));
  expect(errors).toEqual([]);
  for (const s of summary) expect(s.issues, s.mode).toEqual([]);
});

test('GUI: Dunkel- und Farbenblind-Modus per Menü, bleiben nach dem Neuladen erhalten', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bodyBg()).toBe('rgb(246, 248, 250)');
  await setModes(page, true, true);
  expect(await bodyBg()).toBe('rgb(13, 17, 23)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-colorblind', '1');
  await page.getByRole('button', { name: 'Optionen', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Dunkles Design' })).toBeChecked();
  await expect(
    page.getByRole('menuitemcheckbox', { name: 'Farbenblind-Modus (Muster)' }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 500);
  await setModes(page, false, false);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-colorblind', '0');
  expect(errors).toEqual([]);
});

test('GUI: Farbenblind-Modus unterscheidet Link-Zustände per Form (Raute für down), nicht nur Farbe', async ({
  page,
}) => {
  await page.goto('/');
  await place(page, 'Endgeräte', 'PC', 120, 150);
  await place(page, 'Netzwerk', 'Switch', 320, 150);
  await cable(page, [[120, 150, 320, 150]]);
  // Switch ausschalten → Link down
  await click(page, 320, 150);
  await page.locator('.device-panel button.power').click();
  await page.waitForTimeout(500);
  const picker = page.getByRole('dialog', { name: 'Port auswählen' });
  await page.getByRole('tab', { name: 'Kabel' }).click();
  await page.getByRole('button', { name: 'Straight', exact: true }).click();
  const shape = async () => {
    await click(page, 120, 150);
    const dot = picker.locator('.dot.down').first();
    const t = await dot.evaluate((e) => {
      const cs = getComputedStyle(e);
      return { transform: cs.transform, radius: cs.borderRadius };
    });
    await page
      .getByRole('dialog', { name: 'Port auswählen' })
      .getByRole('button', { name: 'Abbrechen' })
      .click();
    return t;
  };
  const plain = await shape();
  expect(plain.transform).toBe('none');
  await setModes(page, false, true);
  const cb = await shape();
  expect(cb.transform).not.toBe('none'); // um 45° gedreht = Raute
  expect(cb.radius).toBe('0px');
});
