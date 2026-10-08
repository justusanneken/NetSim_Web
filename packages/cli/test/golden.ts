import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/** Vergleicht mit `test/golden/<name>.txt`; `UPDATE_GOLDEN=1` (oder fehlende Datei) schreibt neu. */
export function matchGolden(name: string, actual: string): void {
  const file = fileURLToPath(new URL(`./golden/${name}.txt`, import.meta.url));
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) writeFileSync(file, actual);
  expect(actual).toBe(readFileSync(file, 'utf8'));
}
