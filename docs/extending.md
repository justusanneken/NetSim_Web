# Erweiterungsanleitung

## Neues Gerät hinzufügen

1. `DeviceType` existiert bereits in `packages/engine/src/types.ts`. Neues Modell in `CATALOG`
   (`packages/engine/src/catalog.ts`) eintragen: Ports, `autoMdix`, `mdi`, `makeConfig()`.
2. Konfigurationsform in `DeviceState` (types.ts) ergänzen (`kind` als Diskriminator).
3. Verhalten in `packages/engine/src/devices/<name>.ts` als Funktionen `(ctx, cfg, …)`; in `Engine.onRx` /
   `onTimer` den `case` ergänzen. Zustand nur über `cfg`/`ctx` ändern – keine Closures im Zustand.
4. Laufzeitzustand in `setPower`/`resetRuntime` zurücksetzen.
5. UI: Icon in `apps/web/src/icons.ts`, Eintrag in `Palette.tsx` (`CATEGORIES`), Namen in `de.json`/`en.json`
   (`device.<type>`).
6. Tests: Szenario in `packages/engine/test`, Eintrag in `docs/coverage-matrix.md`.

## Neues Protokoll hinzufügen

1. PDU-Typ in `packages/protocols/src/types.ts` (Union `Pdu`, Diskriminator `kind`); Größe, `describePdu`,
   `LAYER_META`, `summarizeFrame` in `pdu.ts` ergänzen.
2. Verarbeitung im Geräteverhalten (z. B. `host.ts`); Log-Einträge mit i18n-Schlüsseln.
3. Schlüssel in beiden Sprachdateien ergänzen – der i18n-Test schlägt sonst fehl.
4. Vereinfachungen in `docs/simplifications.md` dokumentieren.

## Neuen Befehl hinzufügen

Ab Phase 2 (CLI-Framework): deklarative `CommandNode`-Definition + Handler. Wird dort ergänzt.
