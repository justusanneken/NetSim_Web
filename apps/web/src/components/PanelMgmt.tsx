import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { api } from '../engine/client';
import { useCall, fmtClock } from './util5';

/** Führt IOS-Zeilen im Konfigurationsmodus aus und merkt sich sie für „Equivalent IOS Commands“. */
function useIos(dev: DeviceView) {
  const [last, setLast] = useState<string[]>([]);
  const [out, setOut] = useState('');
  const run = async (lines: string[]): Promise<void> => {
    setLast(lines);
    setOut((await api.cliExec(dev.id, lines)).trim());
  };
  return { last, out, run };
}

function Equivalent({ lines, out }: { lines: string[]; out: string }) {
  const { t } = useTranslation();
  if (lines.length === 0) return null;
  return (
    <details open className="equiv">
      <summary>{t('mgmt.equivalent')}</summary>
      <pre aria-label={t('mgmt.equivalent')}>{lines.join('\n')}</pre>
      {out && <pre className="error">{out}</pre>}
    </details>
  );
}

/** Management-Dienste von Router/Switch/Firewall: Benutzer, SSH/Telnet, NTP, Syslog, SNMP, AAA, Sitzungen. */
export function MgmtPanel({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const ios = useIos(dev);
  const m = dev.p5?.mgmt;
  const [user, setUser] = useState({ name: '', pw: '', priv: 15 });
  const [domain, setDomain] = useState(dev.p5?.domainName ?? '');
  const [ntp, setNtp] = useState('');
  const [log, setLog] = useState('');
  const [comm, setComm] = useState({ name: '', rw: false });
  const [rad, setRad] = useState({ host: '', key: '' });
  const [clock, setClock] = useState('');
  const transport = m?.vty.transport ?? ['ssh', 'telnet'];
  const sec = (lines: string[]) => void ios.run(lines);

  return (
    <>
      <h4>{t('mgmt.title')}</h4>

      <details className="svc5">
        <summary>{t('mgmt.users')}</summary>
        <ul className="ping-list" aria-label={t('mgmt.users')}>
          {m?.users.map((u) => (
            <li key={u.name}>
              {u.name} (priv {u.privilege}){' '}
              <button
                aria-label={`${t('common.remove')} ${u.name}`}
                onClick={() => sec([`no username ${u.name}`])}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="form">
          <label>
            {t('svc5.user')}
            <input
              aria-label={t('mgmt.userName')}
              value={user.name}
              onChange={(e) => setUser({ ...user, name: e.target.value })}
            />
          </label>
          <label>
            {t('svc5.password')}
            <input
              aria-label={t('mgmt.userSecret')}
              type="password"
              value={user.pw}
              onChange={(e) => setUser({ ...user, pw: e.target.value })}
            />
          </label>
          <label>
            Privilege
            <input
              type="number"
              min={0}
              max={15}
              value={user.priv}
              onChange={(e) => setUser({ ...user, priv: Number(e.target.value) })}
            />
          </label>
          <button
            onClick={() => {
              if (!user.name || !user.pw) return;
              sec([`username ${user.name} privilege ${user.priv} secret ${user.pw}`]);
              setUser({ name: '', pw: '', priv: 15 });
            }}
          >
            {t('common.add')}
          </button>
        </div>
      </details>

      <details className="svc5">
        <summary>{t('mgmt.remote')}</summary>
        <div className="form inline">
          <input
            aria-label={t('mgmt.domain')}
            placeholder="lab.local"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <button
            onClick={() =>
              sec([`ip domain-name ${domain.trim()}`, 'crypto key generate rsa modulus 1024'])
            }
          >
            {t('mgmt.genKeys')}
          </button>
        </div>
        <p className="muted small">
          {m?.ssh.keyBits !== undefined
            ? t('mgmt.keysYes', { bits: m.ssh.keyBits })
            : t('mgmt.keysNo')}
        </p>
        {(['ssh', 'telnet'] as const).map((p) => (
          <label className="inline-check" key={p}>
            <input
              type="checkbox"
              aria-label={`transport ${p}`}
              checked={transport.includes(p)}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...new Set([...transport, p])]
                  : transport.filter((x) => x !== p);
                sec([
                  'line vty 0 4',
                  `transport input ${next.length === 0 ? 'none' : next.length === 2 ? 'all' : next[0]}`,
                ]);
              }}
            />
            transport input {p}
          </label>
        ))}
        <label className="inline-check">
          <input
            type="checkbox"
            aria-label="login local"
            checked={m?.vty.loginLocal === true}
            onChange={(e) =>
              sec(['line vty 0 4', e.target.checked ? 'login local' : 'no login local'])
            }
          />
          login local
        </label>
        <h5>{t('mgmt.sessions')}</h5>
        {(m?.sessions.length ?? 0) === 0 ? (
          <p className="muted small">{t('panel.empty')}</p>
        ) : (
          <table className="grid" aria-label={t('mgmt.sessions')}>
            <tbody>
              {m?.sessions.map((s) => (
                <tr key={s.line}>
                  <td>vty {s.line}</td>
                  <td>{s.user || '–'}</td>
                  <td>{s.protocol}</td>
                  <td>{s.from}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

      <details className="svc5">
        <summary>{t('time.title')}</summary>
        <p className="small" data-testid="device-clock">
          {fmtClock(dev.p5?.clockMs)}{' '}
          {dev.p5?.clockSynced
            ? `(${t('time.synced', { server: dev.p5.clockServer })})`
            : `(${t('time.unsynced')})`}
        </p>
        <div className="form inline">
          <input
            aria-label={t('time.set')}
            placeholder="2026-10-08 14:30:00"
            value={clock}
            onChange={(e) => setClock(e.target.value)}
          />
          <button
            onClick={() => {
              const ms = Date.parse(clock.replace(' ', 'T') + 'Z');
              if (Number.isFinite(ms)) void call(api.setClock(dev.id, ms));
            }}
          >
            {t('time.setBtn')}
          </button>
        </div>
        <ul className="ping-list">
          {m?.ntp.servers.map((s) => (
            <li key={s}>
              ntp server {s}{' '}
              <button
                aria-label={`${t('common.remove')} ${s}`}
                onClick={() => sec([`no ntp server ${s}`])}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="form inline">
          <input
            aria-label={t('time.ntpServer')}
            placeholder="10.0.0.10"
            value={ntp}
            onChange={(e) => setNtp(e.target.value)}
          />
          <button
            onClick={() => {
              if (ntp) sec([`ntp server ${ntp.trim()}`]);
              setNtp('');
            }}
          >
            {t('common.add')}
          </button>
        </div>
      </details>

      <details className="svc5">
        <summary>Syslog</summary>
        <ul className="ping-list">
          {m?.syslog.hosts.map((h) => (
            <li key={h}>
              logging host {h}{' '}
              <button
                aria-label={`${t('common.remove')} ${h}`}
                onClick={() => sec([`no logging host ${h}`])}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="form inline">
          <input
            aria-label={t('mgmt.logHost')}
            placeholder="10.0.0.10"
            value={log}
            onChange={(e) => setLog(e.target.value)}
          />
          <button
            onClick={() => {
              if (log) sec([`logging host ${log.trim()}`]);
              setLog('');
            }}
          >
            {t('common.add')}
          </button>
        </div>
        {m && m.logBuffer.length > 0 && (
          <pre className="logbuf" aria-label={t('mgmt.logBuffer')}>
            {m.logBuffer.slice(-12).join('\n')}
          </pre>
        )}
      </details>

      <details className="svc5">
        <summary>SNMP</summary>
        <ul className="ping-list">
          {m?.snmp.communities.map((c) => (
            <li key={c.name}>
              {c.name} ({c.rw ? 'rw' : 'ro'}){' '}
              <button
                aria-label={`${t('common.remove')} ${c.name}`}
                onClick={() => sec([`no snmp-server community ${c.name}`])}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="form inline3">
          <input
            aria-label="SNMP community"
            placeholder="community"
            value={comm.name}
            onChange={(e) => setComm({ ...comm, name: e.target.value })}
          />
          <label className="inline-check">
            <input
              type="checkbox"
              checked={comm.rw}
              onChange={(e) => setComm({ ...comm, rw: e.target.checked })}
            />
            rw
          </label>
          <span />
          <button
            onClick={() => {
              if (comm.name)
                sec([`snmp-server community ${comm.name.trim()} ${comm.rw ? 'rw' : 'ro'}`]);
              setComm({ name: '', rw: false });
            }}
          >
            {t('common.add')}
          </button>
        </div>
      </details>

      <details className="svc5">
        <summary>AAA / RADIUS</summary>
        <label className="inline-check">
          <input
            type="checkbox"
            aria-label="aaa new-model"
            checked={m?.aaa.newModel === true}
            onChange={(e) => sec([e.target.checked ? 'aaa new-model' : 'no aaa new-model'])}
          />
          aaa new-model
        </label>
        <ul className="ping-list">
          {m?.aaa.radius.map((r) => (
            <li key={r.host}>radius-server host {r.host}</li>
          ))}
        </ul>
        <div className="form">
          <input
            aria-label="RADIUS host"
            placeholder="10.0.0.10"
            value={rad.host}
            onChange={(e) => setRad({ ...rad, host: e.target.value })}
          />
          <input
            aria-label="RADIUS key"
            placeholder="key"
            value={rad.key}
            onChange={(e) => setRad({ ...rad, key: e.target.value })}
          />
          <button
            onClick={() => {
              if (!rad.host) return;
              sec([
                'aaa new-model',
                `radius-server host ${rad.host.trim()} key ${rad.key}`,
                'aaa authentication login default group radius local',
              ]);
              setRad({ host: '', key: '' });
            }}
          >
            {t('common.add')}
          </button>
        </div>
      </details>
      <Equivalent lines={ios.last} out={ios.out} />
    </>
  );
}

/** Firewall (ASA-ähnlich): Schnittstellen, ACLs, NAT-Objekte, Verbindungen. */
export function FirewallPanel({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const ios = useIos(dev);
  const fw = dev.p5?.fw;
  const [acl, setAcl] = useState({
    name: 'OUTSIDE_IN',
    rule: 'permit tcp any host 192.168.10.10 eq www',
  });
  const [grp, setGrp] = useState({ name: 'OUTSIDE_IN', nameif: 'outside' });
  const [obj, setObj] = useState({
    name: 'LAN',
    net: '10.0.0.0 255.255.255.0',
    nat: '(inside,outside) dynamic interface',
  });
  if (!fw) return null;
  const run = (lines: string[]) => void ios.run(lines);
  return (
    <>
      <h4>{t('fw.title')}</h4>
      <table className="grid" aria-label={t('fw.interfaces')}>
        <thead>
          <tr>
            <th>{t('port.name')}</th>
            <th>nameif</th>
            <th>{t('fw.level')}</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {dev.ports.map((p) => (
            <FwIfaceRow key={p.id} dev={dev} portId={p.id} name={p.name} run={run} />
          ))}
        </tbody>
      </table>

      <h4>{t('fw.acl')}</h4>
      <div className="form">
        <label>
          {t('fw.aclName')}
          <input
            aria-label={t('fw.aclName')}
            value={acl.name}
            onChange={(e) => setAcl({ ...acl, name: e.target.value })}
          />
        </label>
        <label>
          {t('fw.aclRule')}
          <input
            aria-label={t('fw.aclRule')}
            value={acl.rule}
            onChange={(e) => setAcl({ ...acl, rule: e.target.value })}
          />
        </label>
        <button onClick={() => run([`access-list ${acl.name} extended ${acl.rule}`])}>
          {t('common.add')}
        </button>
      </div>
      <div className="form inline3">
        <input
          aria-label={t('fw.aclName') + ' (group)'}
          value={grp.name}
          onChange={(e) => setGrp({ ...grp, name: e.target.value })}
        />
        <input
          aria-label="nameif (group)"
          value={grp.nameif}
          onChange={(e) => setGrp({ ...grp, nameif: e.target.value })}
        />
        <span />
        <button onClick={() => run([`access-group ${grp.name} in interface ${grp.nameif}`])}>
          {t('fw.bind')}
        </button>
      </div>
      <ul className="ping-list">
        {Object.entries(fw.accessGroups).map(([id, name]) => (
          <li key={id}>
            access-group {name} in interface {fw.ifaces[id]?.nameif ?? id}
          </li>
        ))}
      </ul>

      <h4>{t('fw.nat')}</h4>
      <div className="form">
        <label>
          {t('fw.objName')}
          <input
            aria-label={t('fw.objName')}
            value={obj.name}
            onChange={(e) => setObj({ ...obj, name: e.target.value })}
          />
        </label>
        <label>
          subnet
          <input
            aria-label="subnet"
            value={obj.net}
            onChange={(e) => setObj({ ...obj, net: e.target.value })}
          />
        </label>
        <label>
          nat
          <input
            aria-label="nat"
            value={obj.nat}
            onChange={(e) => setObj({ ...obj, nat: e.target.value })}
          />
        </label>
        <button
          onClick={() =>
            run([
              `object network ${obj.name}`,
              /^\d+\.\d+\.\d+\.\d+\s+\d+\.\d+\.\d+\.\d+$/.test(obj.net)
                ? ` subnet ${obj.net}`
                : ` host ${obj.net}`,
              ` nat ${obj.nat}`,
              'exit',
            ])
          }
        >
          {t('common.add')}
        </button>
      </div>
      <ul className="ping-list">
        {Object.values(fw.objects).map((o) => (
          <li key={o.name}>
            {o.name}: {o.net ? `${o.net.ip}/${o.net.mask}` : '–'}{' '}
            {o.nat ? `nat (${o.nat.from},${o.nat.to}) ${o.nat.kind}` : ''}
          </li>
        ))}
      </ul>

      <h4>
        {t('fw.conns')} ({fw.connCount})
      </h4>
      {fw.conns.length === 0 ? (
        <p className="muted small">{t('panel.empty')}</p>
      ) : (
        <table className="grid" aria-label={t('fw.conns')}>
          <tbody>
            {fw.conns.map((c, i) => (
              <tr key={i}>
                <td>{c.proto.toUpperCase()}</td>
                <td>
                  {c.src}:{c.sport}
                </td>
                <td>
                  {c.dst}:{c.dport}
                </td>
                <td>
                  {fw.ifaces[c.inIface]?.nameif} → {fw.ifaces[c.outIface]?.nameif}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">{t('fw.stats', { built: fw.built, denied: fw.denied })}</p>
      <Equivalent lines={ios.last} out={ios.out} />
    </>
  );
}

function FwIfaceRow(props: {
  dev: DeviceView;
  portId: string;
  name: string;
  run: (l: string[]) => void;
}) {
  const f = props.dev.p5?.fw?.ifaces[props.portId];
  const [nameif, setNameif] = useState(f?.nameif ?? '');
  const [level, setLevel] = useState(f?.level ?? 0);
  const ip = props.dev.ifaces?.[props.portId]?.ip;
  return (
    <tr>
      <td>{props.name}</td>
      <td>
        <input
          aria-label={`nameif ${props.name}`}
          value={nameif}
          onChange={(e) => setNameif(e.target.value)}
          onBlur={() =>
            nameif &&
            nameif !== f?.nameif &&
            props.run([
              `interface ${props.name}`,
              ` nameif ${nameif}`,
              ` security-level ${level}`,
              'exit',
            ])
          }
        />
      </td>
      <td>
        <input
          aria-label={`security-level ${props.name}`}
          type="number"
          min={0}
          max={100}
          className="narrow"
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
          onBlur={() =>
            f &&
            level !== f.level &&
            props.run([`interface ${props.name}`, ` security-level ${level}`, 'exit'])
          }
        />
      </td>
      <td>{ip ?? '–'}</td>
    </tr>
  );
}
