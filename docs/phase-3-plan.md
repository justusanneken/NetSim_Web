# Phase 3 – Plan und Abnahme

Umfang: VLAN, Trunk, VTP, STP/RSTP, EtherChannel, Port-Security, Router-on-a-Stick, L3-Switch/SVI, DHCP (+Relay), DNS, HTTP, ACL, NAT/PAT.

Reihenfolge (test-first): Protokoll-PDUs → Engine (Switch-Datenebene, STP, L3-Stack mit Ifaces, Dienste, ACL, NAT) →
CLI (Registry, Renderer/Replay, `show`) → Web-GUI (Panels, Browser, Linklicht) → Dokumentation.

Abnahmetests: `engine/test/l3svc.test.ts › Abnahme Phase 3` (Inter-VLAN, DHCP über Relay, PAT mit 3 Clients, ACL blockt HTTP),
`engine/test/stp.test.ts` (Ring blockiert genau einen Port), `web/e2e/phase3.spec.ts`.

Bekannte Lücken: siehe `simplifications.md` (Abschnitt Phase 3) und `coverage-matrix.md`.
