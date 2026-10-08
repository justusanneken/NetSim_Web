# Projekt: NetSim Web – browserbasierter Netzwerksimulator (Cisco-Packet-Tracer-Äquivalent)

## 0. Ziel und Abgrenzung

Baue eine vollständig im Browser laufende Web-App, die Netzwerke SIMULIERT (kein Emulator, kein echtes IOS,
keine echten Netzwerkzugriffe). Nutzer platzieren Geräte, verkabeln sie, konfigurieren sie per CLI/GUI,
senden Pakete und beobachten sie Hop für Hop. Zielgruppe: Auszubildende/Studierende (CCNA-Niveau).
UI-Sprache: Deutsch und Englisch (i18n von Anfang an, `de` ist Default). Keine Cisco-Marken/-Logos/-Assets
verwenden; eigener Name und eigene Icons. CLI-Syntax darf IOS-kompatibel sein.

## 1. Tech-Stack (verbindlich)

- TypeScript strict (kein `any`), Vite, React 18, Zustand, i18next
- Monorepo (pnpm workspaces): `/packages/engine` (reines TS, null DOM-Abhängigkeit), `/packages/cli`
  (Befehlsparser + Befehlsdefinitionen), `/packages/protocols` (PDU-Typen + Stacks), `/apps/web` (UI)
- Canvas: Konva (react-konva) für Arbeitsfläche und Paketanimation
- Terminal: xterm.js; Editor für Konfigurationstexte: CodeMirror 6
- Engine läuft in einem Web Worker (Comlink), UI kommuniziert über ein typisiertes Message-Protokoll
- Tests: Vitest (Unit/Szenario), Playwright (E2E), ESLint + Prettier, `pnpm check` = lint+typecheck+test
- Persistenz: IndexedDB (idb) + JSON-Export/Import (zlib-komprimiert, Endung `.nsim`)
- Kein Backend nötig; optional später WebSocket-Server für Multiuser (Phase 6)

## 2. Simulations-Engine (`/packages/engine`)

### 2.1 Zeit und Scheduler

- Virtuelle Zeit in Mikrosekunden (integer). Min-Heap-Scheduler, Ereignis `{t, seq, deviceId, kind, payload}`,
  Ordnung nach `(t, seq)` für Determinismus. Seedbarer RNG (mulberry32) für Jitter, DHCP-XID, ISN, Backoff.
- Modi: `realtime` (virtuelle Uhr gekoppelt an Wanduhr, Faktor 0.1×–20×), `simulation` (manuell: Step / Capture-Forward /
  Auto-Capture mit Verzögerung), `paused`.
- Verzögerungsmodell: Serialisierungszeit = Bits / Linkgeschwindigkeit; Propagation = konstant 5 µs/Link
  (konfigurierbar); Gerätebearbeitung = konfigurierbare Konstante (Default 50 µs). Simulationsmodus darf Zeit „sichtbar skalieren“.
- Timer-API für Geräte: `setTimer(deviceId, name, delay, repeat?)`, `cancelTimer`.
- Snapshot/Restore des gesamten Engine-Zustands (für Undo/Redo, Reset, Autosave): Zustand ist rein serialisierbar
  (keine Closures im Zustand).

### 2.2 Topologie-Modell

```ts
type DeviceType =
  | 'pc'
  | 'laptop'
  | 'server'
  | 'tablet'
  | 'smartphone'
  | 'printer'
  | 'switch-l2'
  | 'switch-l3'
  | 'router'
  | 'hub'
  | 'ap'
  | 'wlc'
  | 'firewall'
  | 'cloud'
  | 'dsl-modem'
  | 'cable-modem'
  | 'iot-sensor'
  | 'iot-actuator'
  | 'sbc'
  | 'note';
type Device = {
  id;
  type;
  model;
  name;
  pos: { x; y };
  ports: Port[];
  modules: ModuleSlot[];
  powered: boolean;
  config: DeviceState;
  physical: { rackPos?; location? };
};
type Port = {
  id;
  name;
  kind: 'fe' | 'ge' | 'tengig' | 'serial' | 'console' | 'aux' | 'usb' | 'wifi' | 'fiber-sfp';
  mac;
  adminUp;
  operUp;
  speed: 'auto' | 10 | 100 | 1000 | 10000;
  duplex: 'auto' | 'half' | 'full';
  linkId?;
  vlanMode?: 'access' | 'trunk' | 'routed';
  counters: { inPkts; outPkts; inBytes; outBytes; inErrors; outErrors; collisions };
};
type Link = {
  id;
  cable:
    | 'straight'
    | 'crossover'
    | 'rollover'
    | 'serial-dce'
    | 'serial-dte'
    | 'fiber'
    | 'coax'
    | 'phone'
    | 'usb'
    | 'wireless';
  a: PortRef;
  b: PortRef;
  operUp;
  lengthM?: number;
};
```

- Kabelvalidierung nach Auto-MDIX-Regeln: PC↔PC nur Crossover (Straight → down), Switch↔Switch Crossover
  (Auto-MDIX an Switches/Routern aktiv = beides ok), Serial braucht DCE+DTE (Clock Rate nötig), Console nur Rollover
  auf Console-Port, Fiber nur auf SFP/Fiber-Ports. Kabellänge > 100 m (Kupfer) → Link down (Option).
- Modulsystem: Router-Slots (HWIC/NM-ähnlich), Switch-Module, PC-NIC-Tausch (Gerät muss dafür ausgeschaltet sein).
- Link-Lights: grün = up/up, rot = down, orange = STP Blocking/Listening/Learning, blinkend = Traffic.

### 2.3 Gerätekatalog (Modelle mit festen Port-Sets)

- PC, Laptop, Tablet, Smartphone, Server (je 1× FastEthernet/Wi-Fi), Drucker
- Router: 1941-, 2911-, 4331-ähnlich (je GigabitEthernet 0/0, 0/1, optional Serial-Slots), Router-PT (leer, frei bestückbar)
- Switch: 2960-24-ähnlich (24×Fa + 2×Gi), 3560-24-ähnlich (L3, SVIs), Switch-PT leer
- Hub, AP (Wi-Fi 2.4/5 GHz), WLC (vereinfacht), Firewall (ASA-ähnlich mit Security-Levels, vereinfacht)
- Cloud-PT (Frame-Relay/PPP-Simulation, DSL, Ethernet-Bridge), DSL-/Kabel-Modem
- IoT (Sensor/Aktor/SBC) mit einfacher Regel-Engine („wenn Sensor X > Y dann Aktor Z“) und Python/JS-Scripting
- Zusatz: Textnotizen, Rechtecke/Ellipsen/Linien als Annotationen, Cluster (einklappbare Gerätegruppen)

### 2.4 PDUs (strukturierte Objekte, keine echten Bytes; Größe wird berechnet)

Ethernet II/802.3+LLC, 802.1Q, ARP, RARP-nicht-nötig, IPv4, IPv6, ICMPv4, ICMPv6 (ND, RS/RA), TCP (Flags, Seq/Ack,
Window, vereinfachter Handshake/Teardown, Retransmission-Timer), UDP, DHCPv4 (DORA), DHCPv6 (SLAAC + stateless/stateful),
DNS (A, AAAA, CNAME, MX, PTR), HTTP/HTTPS (vereinfacht, kein echtes TLS), FTP, TFTP, SMTP/POP3/IMAP (Mail-Dienst),
Telnet, SSH (vereinfacht, Schlüssel simuliert), SNMP v1/v2c/v3 (GET/SET/Trap, einfache MIB), Syslog, NTP, CDP, LLDP,
STP/RSTP-BPDU, PVST+, VTP, DTP, LACP/PAgP, HSRP/VRRP/GLBP (HSRP Pflicht), RIPv1/v2/ng, OSPFv2/v3, EIGRP, BGP (eBGP/iBGP,
vereinfacht), IPsec/GRE (GRE Pflicht, IPsec vereinfacht), PPP/PAP/CHAP, HDLC, Frame-Relay (optional), 802.11 (Assoc/Auth/Beacon),
RADIUS/TACACS+ (vereinfacht), NetFlow-Grundlage (optional), QoS-Marker (DSCP/CoS), SIP/VoIP-Basis (optional).
Jede PDU: `layers[]`, `describe(): HeaderField[]` (für Inspektor), `size()`, `clone()`.
Inspektor: pro Hop `inbound`/`outbound` Layer-Ansicht (OSI 1–7), erklärende Textschritte wie bei Packet Tracer
(„Layer 2: Ziel-MAC passt zu eigener MAC → Frame wird angenommen“).

### 2.5 Geräteverhalten – Pflichtumfang

**Switch L2**: MAC-Learning (Aging 300 s konfigurierbar), Flooding/Unicast-Forwarding, VLANs 1–4094, Access/Trunk,
802.1Q, Native VLAN, Allowed-VLAN-Liste, DTP (vereinfacht), VTP (v2, Server/Client/Transparent), STP/RSTP/PVST+ (Root-Wahl,
Port-Rollen, Timer, PortFast, BPDU Guard, Root Guard), EtherChannel (LACP/PAgP/static, Hash-Verteilung), Port-Security
(max, sticky, violation protect/restrict/shutdown, err-disabled + Auto-Recovery), SPAN, Storm-Control (einfach),
DHCP-Snooping, Dynamic ARP Inspection (einfach), CDP/LLDP, SVI (nur L3-Switch), Inter-VLAN-Routing am L3-Switch.
**Router**: Routing-Tabelle (C, L, S, R, O, D, B inkl. Administrative Distance + Metrik), Longest-Prefix-Match,
ECMP (Gleichlast, einfach), Floating Static, Default-Route, ARP-Cache + Pending-Queue (Timeout/Retry), TTL/ICMP-Fehler
(Time Exceeded, Dest Unreachable mit Codes, Redirect optional), Fragmentierung/DF/PMTUD, Subinterfaces (dot1Q, Router-on-a-Stick),
ACL (standard, extended, named, `established`, Logging), NAT (static, dynamic, PAT/overload, Inside/Outside, Timeouts),
DHCP-Server + Relay (`ip helper-address`), DNS-Forwarder (optional), HSRP, GRE-Tunnel, IPsec-Site-to-Site (vereinfacht),
PPP/CHAP, Serial (Clock Rate), RIP/OSPF/EIGRP/BGP, Redistribution (Basis), Route-Maps/Prefix-Lists (Basis), IPv6 (Routing,
RA, SLAAC, Link-Local, OSPFv3), Policy-based Routing (optional), QoS (Class-Map/Policy-Map vereinfacht), NTP-Client/Server,
SNMP, Syslog, SSH/Telnet-Server, AAA lokal.
**PC/Laptop/Server**: Voller Host-Stack (ARP, IPv4/IPv6, ICMP, TCP/UDP, DHCP-Client, DNS-Resolver, Default-Gateway),
Desktop-Apps: IP-Konfiguration (statisch/DHCP), Command Prompt (`ping, tracert, ipconfig [/all|/release|/renew], arp -a,
nslookup, netstat, telnet, ssh, ftp, tftp`), Web-Browser (HTTP/HTTPS gegen Server, einfaches HTML-Rendering),
Terminal (Console-Zugriff per Rollover), PC-Wireless, E-Mail-Client, Wi-Fi-Profil, Firewall an/aus, Textedit/Datei-Upload.
Server-Dienste (je an/aus + Konfig im GUI): HTTP/HTTPS (editierbare Seiten), DNS (Records-Tabelle), DHCP (Pools), FTP (Benutzer/Dateien),
TFTP (Config-Backup), Mail (SMTP/POP3 mit Konten), NTP, Syslog, AAA (RADIUS), SNMP, IoT-Registrierung.
**Hub**: Repeater + CSMA/CD-Kollisionen (Kollisionsdomäne sichtbar, Jam-Signal, Backoff).
**AP/WLC**: SSID, Sicherheit (offen/WPA2-PSK/WPA2-Enterprise vereinfacht), Kanal/Band, Assoziationstabelle,
Reichweite als Radius auf Canvas, Roaming (einfach), WLC verwaltet Lightweight-APs (vereinfacht, optional).
**Firewall**: Security-Levels, Zonen (einfach), Stateful-Inspection-Tabelle, ACL, NAT, DMZ.
**Cloud/Modem**: Verbindungen zwischen Serial/DSL/Ethernet-Welten per konfigurierbarer Zuordnungstabelle.

## 3. CLI (`/packages/cli`)

- Deklarative Befehlsdefinition (Typ `CommandNode`: `keyword | param(type) | choice | optional | repeat`, Hilfetext,
  Modus-Sichtbarkeit, Handler). Neue Befehle = nur Daten + Handler, kein Parser-Umbau.
- Modi: User EXEC (`>`), Privileged EXEC (`#`), Global Config, Interface, Subinterface, Interface-Range, Line, Router (RIP/OSPF/EIGRP/BGP),
  VLAN, ACL (std/ext named), DHCP-Pool, Class-Map/Policy-Map, Route-Map, Crypto, Key-Chain, SSH-Keygen-Dialog, ROMMON (`rommon 1 >`, minimal).
- Features: eindeutige Präfix-Abkürzungen, `?` (kontextsensitiv, auch hinter Wortteil), Tab-Completion, Historie (↑/↓, `show history`,
  `terminal history size`), `no`- und `default`-Präfix, `do`, Pipes (`| include|exclude|begin|section|count`), `--More--` mit Leertaste/Enter/q,
  `Ctrl+C/Z/A/E/U/W`, `terminal length 0`, Banner (`banner motd`), Passwörter (`enable secret`, `service password-encryption`, Typ-7 vereinfacht),
  Mehrfach-Sessions (Console, Telnet, SSH, max `line vty 0 15`), Auto-Setup-Dialog beim ersten Start (überspringbar).
- Fehlermeldungen im IOS-Stil: `% Invalid input detected at '^' marker.` (korrekte Caret-Position), `% Incomplete command.`,
  `% Ambiguous command: "..."`, `% Unrecognized command`, Interface-/IP-Konfliktmeldungen (`% 10.0.0.0 overlaps with ...`).
- Konfigurationsmodell: Jede Konfig ist ein typisierter Objektbaum. `running-config` wird deterministisch AUS dem Baum
  gerendert (Reihenfolge wie IOS). `startup-config` = gespeicherter Text; `copy run start`/`write`, `copy tftp`/`copy flash`, `erase startup-config`,
  `reload` (mit Bestätigung, lädt Startup, setzt Laufzeitzustand zurück, simuliert Bootzeit mit Bootmeldungen).
- Pflicht-`show`-Befehle: `version, running-config, startup-config, ip interface brief, interfaces [x], interfaces status, interfaces trunk,
ip route [x], ip protocols, ip arp, mac address-table, vlan [brief], spanning-tree [vlan], etherchannel summary, cdp neighbors [detail],
lldp neighbors, ip ospf neighbor/database/interface, ip eigrp neighbors/topology, ip rip database, ip bgp [summary], ip nat translations/statistics,
access-lists, ip dhcp binding/pool/conflict, standby, ntp status, logging, clock, users, sessions, history, flash, inventory, port-security, ipv6 interface/route/neighbors,
crypto isakmp/ipsec sa, snmp, controllers (serial), vtp status, dot1x (optional)`.
- Debug: `debug ip packet|icmp|arp|ospf|eigrp|rip|nat|dhcp|spanning-tree`, `undebug all`; Ausgabe asynchron in die Session.
- `ping` (Erweitert/Dialog mit Source, Repeat, Size, DF), `traceroute`, `telnet`, `ssh -l`, `terminal monitor`, `clock set`, `configure replace` (optional).

## 4. Protokoll-Details (verbindliche Vereinfachungen dokumentieren in `docs/simplifications.md`)

- ARP: Request/Reply, Gratuitous ARP, Cache-Timeout 4 h (Router), Host 2 min; Proxy-ARP optional.
- IP: Fragmentierung nach MTU, Reassembly am Ziel, DF → ICMP Frag-Needed.
- TCP: 3-Wege-Handshake, FIN/RST, feste Fenstergröße, einfache Retransmission (RTO fest), keine Staukontrolle.
- DHCP: DORA mit Lease-Zeit, Renew bei 50 %, Relay, Conflict-Detection per ARP, Option 3/6/15/66/150.
- STP: IEEE-802.1D-Timer (Hello 2/Forward 15/MaxAge 20), RSTP Proposal/Agreement, PVST+ pro VLAN.
- OSPF: Hello/Dead, DR/BDR-Wahl, DBD-Austausch, LSA 1–5 (Single- und Multi-Area, Stub), SPF mit Cost, Passive-Interface, Default-Info-Originate.
- EIGRP: Hello/Hold, Neighbor-Tabelle, DUAL vereinfacht (Feasible Successor), Metrik nach Bandwidth/Delay-Formel.
- RIPv2: 30-s-Updates, Split Horizon, Poison Reverse, Triggered Updates, Max 15 Hops.
- BGP: TCP/179, Open/Keepalive/Update, Pfadattribute AS-Path/Next-Hop/Local-Pref/MED (Basis), Best-Path in vereinfachter Reihenfolge.
- NAT/PAT: Translationstabelle mit Ports, Timeouts, Fehlverhalten bei Fragmenten dokumentieren.
- Wi-Fi: Kein Funkphysik-Modell, nur Reichweitenradius + Kanal/Band-Kompatibilität + Authentifizierung.

## 5. UI (`/apps/web`)

- **Layout**: Obere Menüleiste (Datei, Bearbeiten, Optionen, Ansicht, Extras, Hilfe, Sprache), Hauptsymbolleiste (Auswahl, Verschieben,
  Notiz, Löschen, Zoom, Palette, Simple/Complex-PDU), Arbeitsfläche, rechte Leiste (Ressourcen: Szenarien, Netzwerkinformationen),
  linke untere Palette (Kategorien → Geräte → Kabel), unten Simulationspanel.
- **Arbeitsfläche**: Logical View (frei positionierbar, Hintergrundbild) und Physical View (Stadt → Gebäude → Raum → Rack, vereinfacht,
  Kabellängen/Dämpfung); Raster/Snap, Zoom (Strg+Mausrad), Pan, Rubberband-Auswahl, Mehrfachverschieben, Gruppieren/Cluster,
  Annotationen, Ausrichten/Verteilen, Mini-Map.
- **Kabel**: Kabelwerkzeug mit Port-Auswahl-Popup an beiden Enden; „Automatisch wählen“-Kabel; Link-Lights; Port-Beschriftungen ein-/ausblendbar;
  Kabel löschen per Klick/Entf.
- **Geräte-Dialog** (Tabs): `Physical` (Module ein-/ausstecken, Power-Taste, Gehäuse-Bild), `Config` (GUI-Formulare pro Funktion: Global,
  Routing, Switching, Interfaces, Dienste, Settings, Zeit), `CLI` (xterm.js), `Attributes` (Seriennr., Lizenz, Notizen), `Desktop` (Hosts: Apps, siehe 2.5).
  Tab-Inhalte spiegeln denselben Config-Zustand wie die CLI (GUI-Änderungen erscheinen in `running-config` und umgekehrt, inkl. „Equivalent IOS Commands“-Panel).
- **PDU-Werkzeuge**: Simple PDU (Klick Quelle → Ziel: ICMP-Echo), Complex PDU (Protokoll, Port, Quell-IP, Payload, Zeit/Wiederholung);
  PDU-Liste mit Status (Successful/Failed), Szenario-Verwaltung (mehrere Szenarien je Topologie), Rerun/Delete.
- **Simulationspanel**: Event-Liste (Zeit, Last Device, At Device, Type, Info, farbig nach Protokoll), Filter (Protokoll-Checkboxen,
  „Show All/None“), Play/Pause/Step Forward/Step Back (via Snapshot)/Reset, Capture-Geschwindigkeit, Realtime↔Simulation-Umschalter,
  Export der Event-Liste (CSV/PCAP-ähnlich JSON; echtes `.pcap` optional mit synthetisch erzeugten Bytes).
- **Animation**: Umschlag-Icons wandern entlang der Links (Dauer proportional zur virtuellen Zeit), Farbe/Symbol je Status
  (grün = akzeptiert, rot = verworfen, Kollisions-Blitz am Hub), Klick auf Umschlag/Eintrag öffnet **PDU-Inspektor** (OSI-Modell-Tab,
  Inbound/Outbound-PDU-Details mit Feldtabellen, Hex-Ansicht optional, „Challenge Me“-Quizmodus: Nutzer wählt richtige Layer-Aktion).
- **Dashboard-Hilfen**: Mouse-over-Tooltips mit Port-Status, IP, VLAN, MAC; Netzwerk-Info-Fenster (Gerät auswählen → Interfaces, Routen, ARP, MAC-Tabelle als Tabelle).
- **Allgemein**: Dark/Light, Tastaturkürzel (Strg+Z/Y/C/V/S/O, Entf, Leertaste = Play/Pause), Kontextmenü, Barrierefreiheit (Tastaturbedienung,
  ARIA-Labels, Farbblind-Modus mit Mustern statt nur Farben), Autosave alle 30 s, Wiederherstellung nach Absturz, Responsive ab 1280 px,
  Touch-Grundbedienung (Tablet).

## 6. Persistenz, Scripting, Aufgaben

- **Dateiformat `.nsim`**: JSON `{ schema: 1, meta, topology, deviceStates, scenarios, physical, assets }`, zlib-komprimiert, Schema-Versionierung + Migrationen,
  Zod-Validierung beim Import (nie ungeprüftes JSON in die Engine).
- **Vorlagen**: Mindestens 10 Beispielnetze (SOHO, VLAN+Trunk, Router-on-a-Stick, OSPF 3 Router, NAT/PAT, DHCP-Relay, STP-Ring, EtherChannel, ACL-Lab, WLAN).
- **Scripting-API** (JS im Sandbox-Worker, optional Python via Pyodide): `network.addDevice/connect/getDevice`, `device.cli.run(line)`,
  `engine.step()/runUntil(cond)`, Events abonnieren (`onPacket`, `onLinkChange`), IoT-Regeln. Keine Netzwerkzugriffe, keine DOM-Zugriffe, CPU-Zeitlimit.
- **Aufgabenmodus** (`.nsact`): Autor legt Startnetz + Antwortnetz fest, definiert Prüfungen (Gerät/Pfad/Config-Zeilen/Ping/Dienst erreichbar),
  Gewichtungen, Hinweise, Schrittanleitung, Zeitlimit; Teilnehmer sehen Fortschrittsprozent und Prüfergebnis; Prüfung vergleicht Zustandsprädikate
  (nicht Textvergleich).
- **Multiuser (Phase 6, optional)**: WebSocket-Relay, Link-Tunnel zwischen zwei Instanzen, nur Topologie-/PDU-Synchronisierung, keine Accounts.

## 7. Nicht-funktionale Anforderungen

- Performance: 100 Geräte/200 Links bei 60 fps UI; Engine ≥ 20.000 Events/s im Worker; keine UI-Blockade; Event-Liste virtualisiert (react-window).
- Determinismus: gleiche Topologie + Seed + Eingaben ⇒ identisches Event-Log (Golden-File-Tests).
- Sicherheit: Import strikt validiert, Scripting sandboxed, keine `eval` im Hauptthread, CSP-Header, keine externen Requests zur Laufzeit.
- Fehlerrobustheit: Engine-Exceptions pro Gerät abfangen, Gerät in „crashed“-Zustand setzen, Rest läuft weiter; sichtbare Fehlermeldung.
- Qualität: Engine/CLI-Testabdeckung ≥ 85 %, Lint ohne Warnungen, Commits klein und konventionell (`feat:`, `fix:`), `docs/` mit Architektur, CLI-Befehlsreferenz,
  Vereinfachungen, Erweiterungsanleitung („Neues Protokoll hinzufügen“, „Neuen Befehl hinzufügen“, „Neues Gerät hinzufügen“).
- Lizenzhinweise: nur eigene/OSS-Assets, `THIRD_PARTY.md` pflegen.

## 8. Phasenplan mit Abnahmetests (nach jeder Phase STOPP, Demo, Freigabe abwarten)

**Phase 1 – Fundament + L2**: Monorepo, Scheduler, Snapshot, Device/Port/Link, Kabelvalidierung, PC/Switch/Hub, Ethernet, ARP (nur Host↔Host),
MAC-Learning, Hub-Kollisionen, Minimal-UI (Platzieren, Verkabeln, Link-Lights, Event-Liste).
Abnahme: (a) 3 PCs an 1 Switch: erster Ping erzeugt ARP-Broadcast-Flooding, danach nur Unicast; MAC-Tabelle hat 3 Einträge. (b) PC↔PC mit Straight = down,
mit Crossover = up. (c) Golden-File-Test deterministisch.
**Phase 2 – L3 + CLI-Grundlage**: IPv4, ICMP, Router, statische Routen, ARP-Queue, TTL, Fragmentierung, CLI-Framework (Modi, `?`, Tab, Abkürzungen, Fehlermeldungen),
Basisbefehle, `running-config`-Renderer, Desktop (IP-Config + Command Prompt), Simulationsmodus mit Animation, PDU-Inspektor.
Abnahme: 2 Subnetze über Router, `ping` und `tracert` OK; falsches Gateway → korrekte ICMP-Fehlermeldung; `show ip route` entspricht Erwartung; CLI-Golden-Tests.
**Phase 3 – L2/L3-Dienste**: VLAN, Trunk, VTP, STP/RSTP, EtherChannel, Port-Security, Router-on-a-Stick, L3-Switch/SVI, DHCP (+Relay), DNS, HTTP, ACL, NAT/PAT.
Abnahme: Inter-VLAN-Routing, DHCP über Relay, PAT mit 3 Clients, ACL blockiert gezielt HTTP, STP-Ring blockiert genau einen Port.
**Phase 4 – Dynamisches Routing**: RIPv2, OSPF (Single+Multi-Area), EIGRP, HSRP, GRE, Redistribution-Basis, IPv6 (Statisch, OSPFv3, SLAAC), BGP (eBGP/iBGP Basis).
Abnahme: OSPF konvergiert in 4-Router-Topologie, Linkausfall führt zu Umschaltung, `debug`-Ausgaben sichtbar.
**Phase 5 – Wireless, Server-Dienste, Weitere Geräte**: AP/WLC, Mail/FTP/TFTP/NTP/Syslog/SNMP/AAA, SSH/Telnet, Firewall, IoT, Cloud/Modem, Physical View.
**Phase 6 – Komfort & Lehre**: `.nsim`-Format, Autosave, Undo/Redo, Vorlagen, Szenarien, Scripting, Aufgabenmodus, Challenge-Me-Modus, Multiuser (optional), PCAP-Export, i18n-Vollständigkeit, A11y-Audit.

## 9. Arbeitsweise für dich (die KI)

1. Lies die Spezifikation. Liste maximal 10 Annahmen/Unklarheiten, stelle KEINE Rückfragen, sondern wähle Defaults und dokumentiere sie in `docs/decisions.md`.
2. Erstelle Repo-Struktur, `README.md`, CI-Skript und einen Aufgabenplan nur für die aktuelle Phase.
3. Implementiere test-first; zuerst Engine, dann CLI, dann UI. Keine Features außerhalb der aktuellen Phase.
4. Halte eine Datei `docs/coverage-matrix.md` aktuell: Feature → Phase → Status (offen/teilweise/fertig) → Testname.
5. Beende jede Phase mit: Demo-Anleitung, bekannte Lücken, Vorschlag für die nächste Phase. Warte dann auf Freigabe.
