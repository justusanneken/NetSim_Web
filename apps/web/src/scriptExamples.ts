/** Beispielskripte der Skript-Konsole (reines JavaScript für den Sandbox-Interpreter). */
export interface ScriptExample {
  id: string;
  /** i18n-Schlüssel des Titels. */
  label: string;
  code: string;
}

const OSPF = `// 3-Router-OSPF-Labor aufbauen und prüfen
const ips = [
  ['R1', '10.0.12.1', null, '1.1.1.1'],
  ['R2', '10.0.12.2', '10.0.23.2', '2.2.2.2'],
  ['R3', '10.0.23.3', null, '3.3.3.3'],
];
ips.forEach(function (c, i) { network.addDevice('router', c[0], 120 + i * 220, 140); });
network.connect('R1', 'Gi0/0', 'R2', 'Gi0/0');
network.connect('R2', 'Gi0/1', 'R3', 'Gi0/0');

function setup(name, ip0, ip1, rid) {
  const d = network.getDevice(name);
  d.cli.run('configure terminal');
  d.cli.run('interface gi0/0');
  d.cli.run('ip address ' + ip0 + ' 255.255.255.0');
  d.cli.run('no shutdown');
  if (ip1) {
    d.cli.run('interface gi0/1');
    d.cli.run('ip address ' + ip1 + ' 255.255.255.0');
    d.cli.run('no shutdown');
  }
  d.cli.run('router ospf 1');
  d.cli.run('router-id ' + rid);
  d.cli.run('network 10.0.0.0 0.255.255.255 area 0');
  d.cli.run('end');
}
ips.forEach(function (c) { setup(c[0], c[1], c[2], c[3]); });

const r1 = network.getDevice('R1');
const converged = engine.runUntil(function () {
  return r1.cli.run('show ip route').includes('10.0.23.0');
}, 120000);
log('OSPF konvergiert:', converged, 'nach', Math.round(engine.now() / 1000), 's');
log(r1.cli.run('show ip ospf neighbor'));
log(r1.cli.run('show ip route ospf'));
`;

const SWEEP = `// Ping-Sweep: Switch mit 3 PCs, PC1 prüft 10.0.0.2-10.0.0.6
const sw = network.addDevice('switch-l2', 'SW1', 300, 100);
for (let i = 1; i <= 3; i++) {
  const pc = network.addDevice('pc', 'PC' + i, 120 + i * 120, 260);
  network.connect(pc, 0, sw, i - 1);
  pc.setIp('10.0.0.' + i, '255.255.255.0');
}
engine.runFor(35000); // Spanning Tree abwarten
const scanner = network.getDevice('PC1');
const alive = [];
for (let i = 2; i <= 6; i++) {
  const ip = '10.0.0.' + i;
  const r = scanner.ping(ip);
  log(ip.padEnd(10), r.ok ? 'antwortet (' + r.rttMs + ' ms)' : 'keine Antwort');
  if (r.ok) alive.push(ip);
}
log('Erreichbar:', alive.length, 'von 5 ->', alive.join(', '));
`;

const EVENTS = `// Ereignisse zählen: Pakete je Protokoll und Link-Änderungen
const counts = {};
let linkChanges = 0;
onPacket(function (p) { counts[p.proto] = (counts[p.proto] || 0) + 1; });
onLinkChange(function (l) { linkChanges++; log('Link', l.device, l.port, l.up ? 'up' : 'down'); });
const a = network.addDevice('pc', 'A', 150, 150);
const b = network.addDevice('pc', 'B', 350, 150);
network.connect(a, 0, b, 0, 'crossover');
a.setIp('192.168.1.1', '255.255.255.0');
b.setIp('192.168.1.2', '255.255.255.0');
a.ping('192.168.1.2', 3);
log('Pakete:', counts);
log('Link-Änderungen:', linkChanges);
`;

export const EXAMPLES: ScriptExample[] = [
  { id: 'ospf', label: 'script.ex.ospf', code: OSPF },
  { id: 'sweep', label: 'script.ex.sweep', code: SWEEP },
  { id: 'events', label: 'script.ex.events', code: EVENTS },
];
