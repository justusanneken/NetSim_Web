# NetSim Web

Browserbasierter **Netzwerksimulator** (Simulation, kein Emulator): Geräte platzieren, verkabeln,
konfigurieren, Pakete senden und Hop für Hop beobachten. Zielgruppe: Auszubildende/Studierende (CCNA-Niveau).
UI: Deutsch (Default) und Englisch. Eigene Icons, keine Cisco-Marken.

> **Stand: Phase 4 – Routing-Protokolle und IPv6** (Phase 3: Switching/Dienste, Phase 2: Layer 3 + CLI). Siehe [docs/phase-1-plan.md](docs/phase-1-plan.md),
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

## Bedienung (Phase 5)

- **Palette:** neue Kategorien _Drahtlos_ (Access Point, WLAN-Controller), _WAN / Modem_ (Cloud, DSL-/Kabelmodem), _IoT_ (Sensor,
  Aktor, SBC) sowie Tablet, Smartphone, Drucker und Firewall. Kabel _Telefon_ und _Koax_ für Modems/Cloud.
- **WLAN:** Access Point doppelklicken → _Konfiguration_ (SSID, WPA2-Schlüssel, Kanal je Band). Laptop/Tablet/Smartphone/Drucker:
  _Desktop → PC Wireless_ (SSID + Schlüssel → _Verbinden_). Funklinks erscheinen gestrichelt; der Reichweitenkreis des ausgewählten APs wird
  angezeigt, Ereignisse (Authentifizierung/Assoziation) stehen in der Ereignisliste. Lightweight-AP: WLC-Adresse im AP eintragen, WLANs im WLC pflegen.
- **Server-Dienste:** Server → _Konfiguration_ → TFTP, FTP, Mail, NTP, Syslog, SNMP, AAA, IoT. Clients: _Desktop → E-Mail / MIB-Browser /
  IoT-Monitor / Dateien_; in der Eingabeaufforderung `ftp`, `tftp`, `telnet`, `ssh -l`, `w32tm /resync`.
- **Router/Switch:** `copy running-config tftp://10.0.0.10/r1-confg`, `ntp server`, `logging host`, `snmp-server community`, `username`,
  `ip domain-name` + `crypto key generate rsa`, `line vty 0 4` / `transport input ssh` / `login local`; `telnet`/`ssh -l` öffnen weitere
  Sitzungen (`exit` zurück, `show users`). Das Panel _Verwaltung_ zeigt dieselbe Konfiguration samt „Equivalent IOS Commands“.
- **Firewall:** `nameif`/`security-level` je Schnittstelle, `access-list … extended`, `access-group … in interface`, `object network` + `nat`;
  `show conn`, `show xlate`. Windows-Firewall am PC: _Desktop → Firewall_.
- **Physical View:** Menü _Ansicht → Physical View_ (Orte `Stadt/Gebäude/Raum/Rack` anlegen, Geräte zuordnen); im Geräte-Dialog Tab
  _Physical_ (Power-Taste, Module bei ausgeschaltetem Gerät, Standort).

## Bedienung (Phase 4)

- Routing per CLI (`router ospf 1`, `network … area 0` …). Zeit beschleunigen (Geschwindigkeit bis 20×): OSPF braucht ca. 40–60 s virtuelle Zeit bis FULL.
- `debug ip ospf adj` o. ä. im Router-CLI: Meldungen erscheinen asynchron; `undebug all` beendet sie.
- Ereignisfilter: Hello-/Update-Protokolle (RIP, OSPF, EIGRP, BGP, HSRP) sind standardmäßig ausgeblendet.
- Hosts: IPv6 im Panel (statisch oder SLAAC); Router: IPv6-Adressen, Loopbacks und Routing-Übersicht im Konfigurations-Panel.

## Bedienung (Phase 3)

- **Layer-3-Switch** und Switches: Doppelklick → _Konfiguration_ → VLAN-Tabelle, VTP/STP-Modus, Switchport-Modus je Port;
  Links blockierter STP-Ports leuchten orange. Router/L3-Switch: Subinterfaces bzw. SVIs im Panel anlegen.
- **Server:** _Konfiguration_ → Dienste (HTTP/HTTPS, DNS-Einträge, Startseite); DHCP-Pools per CLI (`ip dhcp pool`).
- **PC:** IP per DHCP beziehen, DNS-Server eintragen, _Desktop → Webbrowser_ (`http://name/`), `nslookup`, `ping name`.
- Spanning Tree braucht ~30 s virtuelle Zeit, bis Access-Ports weiterleiten (PortFast: sofort).

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
