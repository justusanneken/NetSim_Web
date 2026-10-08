# NetSim Web

Browserbasierter **Netzwerksimulator** (Simulation, kein Emulator): Geräte platzieren, verkabeln,
konfigurieren, Pakete senden und Hop für Hop beobachten. Zielgruppe: Auszubildende/Studierende (CCNA-Niveau).
UI: Deutsch (Default) und Englisch. Eigene Icons, keine Cisco-Marken.

> **Stand: Phase 2 – Layer 3 + CLI-Grundlage.** Siehe [docs/phase-1-plan.md](docs/phase-1-plan.md),
> [docs/phase-2-plan.md](docs/phase-2-plan.md), [docs/coverage-matrix.md](docs/coverage-matrix.md) und
> [docs/cli-reference.md](docs/cli-reference.md).

## Schnellstart

```bash
pnpm install
pnpm dev            # http://localhost:5173
pnpm check          # lint + typecheck + Tests (inkl. Coverage-Schwellen)
pnpm build          # Produktions-Build (mit CSP)
pnpm e2e            # Playwright (baut und startet `vite preview`)
```

Voraussetzungen: Node ≥ 20, pnpm ≥ 10.

## Struktur

| Pfad                 | Inhalt                                                                               |
| -------------------- | ------------------------------------------------------------------------------------ |
| `packages/protocols` | PDU-Typen (Ethernet, ARP, IPv4, ICMP), Adress-Helfer, `describe/size/clone`          |
| `packages/engine`    | Scheduler, Topologie, Kabelvalidierung, Host/Switch/Hub, Snapshot, Zeitsteuerung     |
| `packages/cli`       | CLI-Framework (ab Phase 2)                                                           |
| `apps/web`           | React-UI (Konva, Zustand, i18next), Engine-Worker (Comlink)                          |
| `docs/`              | Architektur, Entscheidungen, Vereinfachungen, Coverage-Matrix, Erweiterungsanleitung |

## Bedienung (Phase 2)

- **Geräte-Dialog:** Doppelklick auf ein Gerät (oder „Öffnen …“ in der Seitenleiste). Router/Switch:
  _Konfiguration_ (GUI) und _CLI_ (Console); PCs: _Desktop_ mit _IP-Konfiguration_ und _Eingabeaufforderung_
  (`ping`, `tracert`, `ipconfig [/all]`, `arp -a`). Routerports sind wie bei IOS zunächst `shutdown`.
- **CLI:** `enable`, `configure terminal`, `interface gi0/0`, `ip address …`, `no shutdown`, `ip route …`,
  `show ip route`, `copy running-config startup-config`. `?` und Tab funktionieren wie bei IOS.
- **Simulationsmodus:** Pakete wandern als Umschläge über die Links; mit _Schritt vor/zurück_ durchschalten,
  Umschlag oder Event-Eintrag anklicken → PDU-Inspektor (OSI-Schichten, Felder).

## Bedienung (Phase 1)

- **Platzieren:** Gerät in der Palette (unten links) anklicken und auf die Arbeitsfläche klicken – oder ziehen.
- **Verkabeln:** Tab _Kabel_ → Kabeltyp (oder _Automatisch_) → zwei Geräte anklicken (bei manuellem Kabel
  jeweils Port wählen). Link-Lights: grün = up, rot/Raute = down, hell = Verkehr.
- **Konfigurieren/Pingen:** Gerät auswählen → rechte Leiste (IP, Ping, Ports, MAC-Tabelle). Alternativ
  Werkzeug _PDU senden_ (Quelle, dann Ziel anklicken).
- **Simulation:** unten _Echtzeit_ oder _Simulation_ (Schritt vor/zurück, Auto-Capture), Event-Liste mit
  Filtern; Eintrag anklicken → PDU-Inspektor.
- **Tastatur:** `V` Auswählen, `H` Verschieben, `C` Kabel, `P` PDU, `X` Löschen, `Entf` Auswahl löschen,
  `Esc` Abbruch, `␣` Play/Pause, `Strg`+Mausrad Zoom.

## Sicherheit

Die Engine läuft in einem Web Worker; es gibt kein `eval` und keine externen Requests zur Laufzeit. Der
Produktions-Build enthält eine strikte CSP als `<meta>`. Beim Hosting zusätzlich als Header setzen:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'
```

Lizenzen: siehe [THIRD_PARTY.md](THIRD_PARTY.md).
