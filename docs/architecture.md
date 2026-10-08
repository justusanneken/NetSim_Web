# Architektur

```
apps/web  ──Comlink──▶  Web Worker ── EngineService ── SimController ── Engine
   │                                                          │
   └─ React/Zustand/Konva/i18next                    EngineState (JSON) + Log
packages/protocols  PDU-Typen, Adress-Helfer, describe/size/clone
packages/engine     Scheduler, Topologie, Kabel, Geräteverhalten (host/switch/hub)
packages/cli        (Phase 2)
```

## Engine

- **Zustand** (`EngineState`) ist reines JSON: Geräte, Links, Min-Heap-Queue, Transmissions, RNG-Zustand,
  Zähler. Snapshot = `structuredClone(state)` + Log-Länge; Restore ersetzt den Zustand.
- **Ereignisse** `{t, seq, deviceId, kind, payload}` mit `kind ∈ rx | tx | timer | collision`,
  Ordnung `(t, seq)`. Jedes Senden läuft über ein `tx`-Ereignis; Empfang als `rx` zum Ende des Frames.
- **Übertragung** (`Transmission`): hält Sendezeit, Ankunftsfenster, Frame, Versuchszähler und den
  Kollisionsstatus – Grundlage für Carrier Sense, Kollisionserkennung und (ab Phase 2) die Animation.
- **Geräteverhalten** = Funktionen in `src/devices/*`, die über `DeviceCtx` mit der Engine sprechen
  (Senden mit Verzögerung, Timer, Log, RNG). Kein Gerät kennt die Queue direkt.
- **Log** (`LogEntry`): je Hop ein Eintrag mit Zeit, letztem/aktuellem Gerät, Protokoll-Tag, Status und
  i18n-Nachricht + optional Frame (für den Inspektor).
- **Zeitsteuerung** (`SimController`): `tick(wallMs)` treibt Realtime/Auto-Capture; `step()` läuft bis zum
  nächsten Log-Eintrag; Verlauf für Step Back.
- **Service** (`EngineService`): die Methoden dieser Klasse sind das typisierte Nachrichtenprotokoll
  UI ↔ Worker. Rückgaben sind strukturell klonbar (`Result<T>`, `ViewModel`, `LogEntry[]`).

## Web-App

- Der Worker veröffentlicht höchstens ~30× pro Sekunde ein `ViewModel`; das Log wird inkrementell per
  `getLog(from)` nachgeladen (`logEpoch` erkennt Step-Back/Reset).
- Konva-Canvas: Geräte (eigene Strich-Icons als SVG-Pfade, gleiche Pfade in Palette und Canvas), Links mit
  Link-Lights; Pan (Werkzeug/Mausrad), Zoom (Strg+Mausrad), Drag & Drop aus der Palette.
- Event-Liste virtualisiert (`react-window`), Filter je Protokoll-Tag.
- Barrierefreiheit: ARIA-Rollen/-Labels, Tastaturbedienung (Geräteliste als Alternative zur Canvas),
  Farbenblind-Modus (Raute statt Punkt, Status-Symbole ✓ ✗ ⚠ ℹ).
