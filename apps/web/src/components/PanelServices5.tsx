import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView, IotRule, ServerSvc5 } from '@netsim/engine';
import { api } from '../engine/client';
import { useCall, fmtClock } from './util5';

type Svc = Required<ServerSvc5>;
const DEFAULTS: Svc = {
  tftp: { enabled: false, files: {} },
  ftp: { enabled: false, users: [], files: {} },
  mail: { enabled: false, domain: 'example.com', accounts: [], boxes: {}, nextId: 1 },
  ntp: { enabled: false },
  syslog: { enabled: false, messages: [] },
  snmp: { enabled: false, communities: [{ name: 'public', rw: false }] },
  aaa: { enabled: false, clients: [], users: [] },
  tacacs: { enabled: false, clients: [], users: [] },
  iot: { enabled: false, devices: {}, rules: [] },
};

/** Server-Dienste der Phase 5 (Services-Tab): TFTP, FTP, Mail, NTP, Syslog, SNMP, AAA, IoT. */
export function Services5Config({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const sv = dev.services;
  if (!sv) return null;
  const get = <K extends keyof Svc>(k: K): Svc[K] => (sv[k] ?? DEFAULTS[k]) as Svc[K];
  const save = <K extends keyof Svc>(k: K, patch: Partial<Svc[K]>): void => {
    void call(api.setServices(dev.id, { [k]: { ...get(k), ...patch } } as Partial<ServerSvc5>));
  };
  const head = (k: keyof Svc, label: string) => (
    <summary>
      <label className="inline-check">
        <input
          type="checkbox"
          aria-label={label}
          checked={get(k).enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => save(k, { enabled: e.target.checked } as never)}
        />
        {label}
      </label>
    </summary>
  );
  return (
    <>
      <h4>{t('svc5.title')}</h4>
      <details className="svc5">
        {head('tftp', 'TFTP')}
        <FileList
          files={get('tftp').files}
          onDelete={(f) => {
            const files = { ...get('tftp').files };
            delete files[f];
            save('tftp', { files });
          }}
        />
      </details>
      <details className="svc5">
        {head('ftp', 'FTP')}
        <UserList
          users={get('ftp').users}
          onChange={(users) => save('ftp', { users })}
          prefix="ftp"
        />
        <FileList
          files={get('ftp').files}
          onDelete={(f) => {
            const files = { ...get('ftp').files };
            delete files[f];
            save('ftp', { files });
          }}
        />
      </details>
      <details className="svc5">
        {head('mail', t('svc5.mail'))}
        <label>
          {t('svc5.mailDomain')}
          <input
            aria-label={t('svc5.mailDomain')}
            defaultValue={get('mail').domain}
            onBlur={(e) => save('mail', { domain: e.target.value.trim() })}
          />
        </label>
        <UserList
          users={get('mail').accounts}
          onChange={(accounts) => save('mail', { accounts })}
          prefix="mail"
        />
        <p className="muted small">
          {Object.entries(get('mail').boxes)
            .map(([u, m]) => `${u}: ${m.length}`)
            .join(' · ')}
        </p>
      </details>
      <details className="svc5">
        {head('ntp', 'NTP')}
        <p className="muted small">
          {t('svc5.clock')}: {fmtClock(dev.p5?.clockMs)}
        </p>
      </details>
      <details className="svc5">
        {head('syslog', 'Syslog')}
        {get('syslog').messages.length === 0 ? (
          <p className="muted small">{t('panel.empty')}</p>
        ) : (
          <table className="grid" aria-label="Syslog">
            <tbody>
              {get('syslog')
                .messages.slice(-30)
                .reverse()
                .map((m, i) => (
                  <tr key={i}>
                    <td>{m.from}</td>
                    <td className="mono">{m.text}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </details>
      <details className="svc5">
        {head('snmp', 'SNMP')}
        <CommunityEditor
          list={get('snmp').communities}
          onChange={(communities) => save('snmp', { communities })}
        />
        <TrapList traps={get('snmp').traps ?? []} />
      </details>
      <details className="svc5">
        {head('aaa', 'AAA / RADIUS')}
        <ClientEditor list={get('aaa').clients} onChange={(clients) => save('aaa', { clients })} />
        <UserList
          users={get('aaa').users}
          onChange={(users) => save('aaa', { users })}
          prefix="aaa"
        />
      </details>
      <details className="svc5">
        {head('tacacs', 'TACACS+')}
        <ClientEditor
          kind="TACACS+"
          list={get('tacacs').clients}
          onChange={(clients) => save('tacacs', { clients })}
        />
        <UserList
          users={get('tacacs').users}
          onChange={(users) => save('tacacs', { users })}
          prefix="tacacs"
        />
      </details>
      <details className="svc5">
        {head('iot', t('svc5.iot'))}
        <IotRules dev={dev} rules={get('iot').rules} onChange={(rules) => save('iot', { rules })} />
      </details>
    </>
  );
}

function FileList({
  files,
  onDelete,
}: {
  files: Record<string, string>;
  onDelete: (f: string) => void;
}) {
  const { t } = useTranslation();
  const names = Object.keys(files).sort();
  if (names.length === 0) return <p className="muted small">{t('svc5.noFiles')}</p>;
  return (
    <ul className="ping-list" aria-label={t('svc5.files')}>
      {names.map((n) => (
        <li key={n}>
          {n} <span className="muted">({(files[n] ?? '').length} B)</span>{' '}
          <button aria-label={`${t('common.remove')} ${n}`} onClick={() => onDelete(n)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function UserList({
  users,
  onChange,
  prefix,
}: {
  users: { user: string; pass: string }[];
  onChange: (u: { user: string; pass: string }[]) => void;
  prefix: string;
}) {
  const { t } = useTranslation();
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  return (
    <>
      <ul className="ping-list" aria-label={t('svc5.users')}>
        {users.map((u) => (
          <li key={u.user}>
            {u.user}{' '}
            <button
              aria-label={`${t('common.remove')} ${u.user}`}
              onClick={() => onChange(users.filter((x) => x.user !== u.user))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="form inline3">
        <input
          aria-label={`${prefix} ${t('svc5.user')}`}
          placeholder={t('svc5.user')}
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
        <input
          aria-label={`${prefix} ${t('svc5.password')}`}
          placeholder={t('svc5.password')}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <span />
        <button
          onClick={() => {
            if (!user) return;
            onChange([...users.filter((x) => x.user !== user), { user: user.trim(), pass }]);
            setUser('');
            setPass('');
          }}
        >
          {t('common.add')}
        </button>
      </div>
    </>
  );
}

function CommunityEditor({
  list,
  onChange,
}: {
  list: { name: string; rw: boolean }[];
  onChange: (l: { name: string; rw: boolean }[]) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [rw, setRw] = useState(false);
  return (
    <>
      <ul className="ping-list">
        {list.map((c) => (
          <li key={c.name}>
            {c.name} ({c.rw ? 'rw' : 'ro'}){' '}
            <button
              aria-label={`${t('common.remove')} ${c.name}`}
              onClick={() => onChange(list.filter((x) => x.name !== c.name))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="form inline3">
        <input
          aria-label="Community"
          placeholder="Community"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="inline-check">
          <input type="checkbox" checked={rw} onChange={(e) => setRw(e.target.checked)} />
          rw
        </label>
        <span />
        <button
          onClick={() => {
            if (!name) return;
            onChange([...list.filter((x) => x.name !== name), { name: name.trim(), rw }]);
            setName('');
          }}
        >
          {t('common.add')}
        </button>
      </div>
    </>
  );
}

function ClientEditor({
  list,
  onChange,
  kind = 'RADIUS',
}: {
  list: { ip: string; secret: string }[];
  onChange: (l: { ip: string; secret: string }[]) => void;
  kind?: 'RADIUS' | 'TACACS+';
}) {
  const { t } = useTranslation();
  const [ip, setIp] = useState('');
  const [secret, setSecret] = useState('');
  return (
    <>
      <p className="small muted">
        {kind === 'RADIUS' ? t('svc5.radiusClients') : t('svc5.tacacsClients')}
      </p>
      <ul className="ping-list">
        {list.map((c) => (
          <li key={c.ip}>
            {c.ip}{' '}
            <button
              aria-label={`${t('common.remove')} ${c.ip}`}
              onClick={() => onChange(list.filter((x) => x.ip !== c.ip))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="form inline3">
        <input
          aria-label={`${kind} client IP`}
          placeholder="10.0.0.1"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
        />
        <input
          aria-label={`${kind} shared secret`}
          placeholder="Shared secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <span />
        <button
          onClick={() => {
            if (!ip) return;
            onChange([...list.filter((x) => x.ip !== ip), { ip: ip.trim(), secret }]);
            setIp('');
            setSecret('');
          }}
        >
          {t('common.add')}
        </button>
      </div>
    </>
  );
}

const OPS: IotRule['op'][] = ['>', '<', '>=', '<=', '=='];

function IotRules({
  dev,
  rules,
  onChange,
}: {
  dev: DeviceView;
  rules: IotRule[];
  onChange: (r: IotRule[]) => void;
}) {
  const { t } = useTranslation();
  const devices = Object.values(dev.services?.iot?.devices ?? {});
  const sensors = devices.filter((d) => d.role !== 'actuator');
  const actuators = devices.filter((d) => d.role !== 'sensor');
  const [sensor, setSensor] = useState('');
  const [op, setOp] = useState<IotRule['op']>('>');
  const [thr, setThr] = useState('25');
  const [act, setAct] = useState('');
  const [action, setAction] = useState<'on' | 'off'>('on');
  const [elseAction, setElse] = useState<'on' | 'off' | 'none'>('off');
  return (
    <>
      <p className="small muted">{t('iot.registered', { n: devices.length })}</p>
      <ul className="ping-list" aria-label={t('iot.rules')}>
        {rules.map((r) => (
          <li key={r.id}>
            {t('iot.ruleText', {
              sensor: r.sensor,
              op: r.op,
              thr: r.threshold,
              actuator: r.actuator,
              action: t(`iot.state.${r.action}`),
            })}{' '}
            <button
              aria-label={`${t('common.remove')} #${r.id}`}
              onClick={() => onChange(rules.filter((x) => x.id !== r.id))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="form">
        <label>
          {t('iot.sensor')}
          <input
            aria-label={t('iot.sensor')}
            list={`sens-${dev.id}`}
            value={sensor}
            onChange={(e) => setSensor(e.target.value)}
          />
          <datalist id={`sens-${dev.id}`}>
            {sensors.map((s) => (
              <option key={s.name} value={s.name} />
            ))}
          </datalist>
        </label>
        <label>
          {t('iot.condition')}
          <select value={op} onChange={(e) => setOp(e.target.value as IotRule['op'])}>
            {OPS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <input
            aria-label={t('iot.threshold')}
            type="number"
            value={thr}
            onChange={(e) => setThr(e.target.value)}
          />
        </label>
        <label>
          {t('iot.actuator')}
          <input
            aria-label={t('iot.actuator')}
            list={`act-${dev.id}`}
            value={act}
            onChange={(e) => setAct(e.target.value)}
          />
          <datalist id={`act-${dev.id}`}>
            {actuators.map((s) => (
              <option key={s.name} value={s.name} />
            ))}
          </datalist>
        </label>
        <label>
          {t('iot.then')}
          <select value={action} onChange={(e) => setAction(e.target.value as 'on' | 'off')}>
            <option value="on">{t('iot.state.on')}</option>
            <option value="off">{t('iot.state.off')}</option>
          </select>
        </label>
        <label>
          {t('iot.else')}
          <select
            value={elseAction}
            onChange={(e) => setElse(e.target.value as 'on' | 'off' | 'none')}
          >
            <option value="none">{t('iot.state.none')}</option>
            <option value="on">{t('iot.state.on')}</option>
            <option value="off">{t('iot.state.off')}</option>
          </select>
        </label>
        <button
          onClick={() => {
            if (!sensor || !act) return;
            onChange([
              ...rules,
              {
                id: Math.max(0, ...rules.map((r) => r.id)) + 1,
                sensor,
                op,
                threshold: Number(thr),
                actuator: act,
                action,
                elseAction,
              },
            ]);
          }}
        >
          {t('iot.addRule')}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Desktop-Apps

/** E-Mail-Client (Desktop-App). */
export function MailClient({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const m = dev.p5?.mail;
  const [server, setServer] = useState(m?.server ?? '');
  const [user, setUser] = useState(m?.user ?? '');
  const [pass, setPass] = useState(m?.pass ?? '');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const setup = () =>
    call(api.setMailAccount(dev.id, { server: server.trim(), user: user.trim(), pass }));
  const status = m?.status;
  return (
    <div className="pad scroll">
      <h4>{t('mail.account')}</h4>
      <div className="form">
        <label>
          {t('mail.server')}
          <input
            aria-label={t('mail.server')}
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </label>
        <label>
          {t('mail.address')}
          <input
            aria-label={t('mail.address')}
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </label>
        <label>
          {t('svc5.password')}
          <input
            aria-label={t('svc5.password')}
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </label>
        <button onClick={() => void setup()}>{t('common.apply')}</button>
      </div>
      <h4>{t('mail.compose')}</h4>
      <div className="form">
        <label>
          {t('mail.to')}
          <input aria-label={t('mail.to')} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          {t('mail.subject')}
          <input
            aria-label={t('mail.subject')}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        <label>
          {t('mail.body')}
          <textarea
            aria-label={t('mail.body')}
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <div className="row">
          <button
            onClick={() =>
              void setup().then((ok) => ok && call(api.mailSend(dev.id, to.trim(), subject, body)))
            }
          >
            {t('mail.send')}
          </button>
          <button onClick={() => void setup().then((ok) => ok && call(api.mailFetch(dev.id)))}>
            {t('mail.receive')}
          </button>
        </div>
      </div>
      {status && (
        <p
          className={status.key === 'mail.sent' || status.key === 'mail.received' ? 'ok' : 'warn'}
          aria-live="polite"
          data-testid="mail-status"
        >
          {t(status.key, status.params)}
        </p>
      )}
      <h4>{t('mail.inbox')}</h4>
      {(m?.inbox.length ?? 0) === 0 ? (
        <p className="muted small">{t('panel.empty')}</p>
      ) : (
        <ul className="ping-list" aria-label={t('mail.inbox')}>
          {m?.inbox.map((x) => (
            <li key={x.id}>
              <button className="link" onClick={() => setOpen(open === x.id ? null : x.id)}>
                {x.from}: {x.subject}
              </button>
              {open === x.id && <pre>{x.body}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Empfangene SNMP-Traps (UDP 162), neueste zuerst. */
function TrapList({ traps }: { traps: NonNullable<Svc['snmp']['traps']> }) {
  const { t } = useTranslation();
  return (
    <>
      <h5>{t('svc5.traps')}</h5>
      {traps.length === 0 ? (
        <p className="muted small">{t('svc5.noTraps')}</p>
      ) : (
        <table className="grid" aria-label={t('svc5.traps')}>
          <thead>
            <tr>
              <th>{t('svc5.trapTime')}</th>
              <th>{t('svc5.trapFrom')}</th>
              <th>Trap</th>
              <th>{t('svc5.trapIface')}</th>
            </tr>
          </thead>
          <tbody>
            {[...traps]
              .slice(-50)
              .reverse()
              .map((x, i) => (
                <tr key={i}>
                  <td>{(x.t / 1e6).toFixed(1)} s</td>
                  <td>
                    {x.host} ({x.from})
                  </td>
                  <td className="mono">{x.trap}</td>
                  <td>{x.ifDescr ?? ''}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** SNMP-/MIB-Browser (Desktop-App). */
export function MibBrowser({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const [dst, setDst] = useState('');
  const [community, setCommunity] = useState('public');
  const [oid, setOid] = useState('sysName.0');
  const [value, setValue] = useState('');
  const [rows, setRows] = useState<[string, string | number][]>([]);
  const [msg, setMsg] = useState('');
  const run = async (op: 'get' | 'getnext' | 'walk' | 'set') => {
    setMsg('');
    const r = await api.snmpQuery(
      dev.id,
      dst.trim(),
      community,
      op,
      oid,
      op === 'set' ? value : undefined,
    );
    if (!r.ok) {
      setRows([]);
      setMsg(t(r.error));
      return;
    }
    setRows(r.value.varbinds);
    setMsg(
      r.value.status === 'ok'
        ? ''
        : t(`mib.status.${r.value.status}`, { defaultValue: r.value.status }),
    );
  };
  return (
    <div className="pad scroll">
      {dev.services?.snmp?.enabled && <TrapList traps={dev.services.snmp.traps ?? []} />}
      <div className="form">
        <label>
          {t('mib.agent')}
          <input
            aria-label={t('mib.agent')}
            value={dst}
            placeholder="10.0.0.1"
            onChange={(e) => setDst(e.target.value)}
          />
        </label>
        <label>
          Community
          <input
            aria-label="Community"
            value={community}
            onChange={(e) => setCommunity(e.target.value)}
          />
        </label>
        <label>
          OID
          <input aria-label="OID" value={oid} onChange={(e) => setOid(e.target.value)} />
        </label>
        <label>
          {t('mib.value')}
          <input
            aria-label={t('mib.value')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="row">
          <button onClick={() => void run('get')}>GET</button>
          <button onClick={() => void run('getnext')}>GETNEXT</button>
          <button onClick={() => void run('walk')}>WALK</button>
          <button onClick={() => void run('set')}>SET</button>
        </div>
      </div>
      {msg && (
        <p className="warn" aria-live="polite">
          {msg}
        </p>
      )}
      {rows.length > 0 && (
        <table className="grid" aria-label={t('mib.result')}>
          <thead>
            <tr>
              <th>OID</th>
              <th>{t('mib.value')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([o, v]) => (
              <tr key={o}>
                <td className="mono">{o}</td>
                <td>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** IoT-Monitor (Desktop-App): registrierte Geräte, Werte, Schaltzustände. */
export function IotMonitor({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const iot = dev.p5?.iot;
  const server = dev.services?.iot;
  const devices = Object.values(server?.devices ?? {});
  return (
    <div className="pad scroll">
      {iot && (
        <>
          <h4>{t('iot.thisDevice')}</h4>
          <IotDeviceForm dev={dev} />
        </>
      )}
      <h4>{t('iot.monitor')}</h4>
      {!server?.enabled ? (
        <p className="muted small">{t('iot.noServer')}</p>
      ) : devices.length === 0 ? (
        <p className="muted small">{t('panel.empty')}</p>
      ) : (
        <table className="grid" aria-label={t('iot.monitor')}>
          <thead>
            <tr>
              <th>{t('port.name')}</th>
              <th>IP</th>
              <th>{t('iot.value')}</th>
              <th>{t('iot.stateLabel')}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.name}>
                <td>{d.name}</td>
                <td>{d.ip}</td>
                <td>{d.value !== undefined ? `${d.value} ${d.unit ?? ''}` : '–'}</td>
                <td>{d.state ? t(`iot.state.${d.state}`) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Konfiguration eines IoT-Geräts (Sensor/Aktor/SBC). */
export function IotDeviceForm({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const iot = dev.p5?.iot;
  const [server, setServer] = useState(iot?.server ?? '');
  const [value, setValue] = useState(String(iot?.value ?? 20));
  if (!iot) return null;
  return (
    <div className="form">
      <label>
        {t('iot.server')}
        <div className="form inline">
          <input
            aria-label={t('iot.server')}
            value={server}
            placeholder="10.0.0.10"
            onChange={(e) => setServer(e.target.value)}
          />
          <button onClick={() => void call(api.setIot(dev.id, { server: server.trim() }))}>
            {t('common.apply')}
          </button>
        </div>
      </label>
      <p className="muted small" data-testid="iot-reg">
        {iot.registered ? t('iot.registeredYes') : t('iot.registeredNo')}
      </p>
      {iot.role !== 'actuator' && (
        <>
          <label>
            {t('iot.pattern')}
            <select
              aria-label={t('iot.pattern')}
              value={iot.pattern}
              onChange={(e) =>
                void call(
                  api.setIot(dev.id, { pattern: e.target.value as 'manual' | 'wave' | 'ramp' }),
                )
              }
            >
              <option value="manual">{t('iot.pattern.manual')}</option>
              <option value="wave">{t('iot.pattern.wave')}</option>
              <option value="ramp">{t('iot.pattern.ramp')}</option>
            </select>
          </label>
          <label>
            {t('iot.value')} ({iot.unit})
            <div className="form inline">
              <input
                aria-label={t('iot.value')}
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <button onClick={() => void call(api.setIot(dev.id, { value: Number(value) }))}>
                {t('common.apply')}
              </button>
            </div>
          </label>
        </>
      )}
      {iot.role !== 'sensor' && (
        <label className="inline-check">
          <input
            type="checkbox"
            checked={iot.state === 'on'}
            onChange={(e) =>
              void call(api.setIot(dev.id, { state: e.target.checked ? 'on' : 'off' }))
            }
          />
          {t('iot.stateLabel')}: {t(`iot.state.${iot.state}`)}
        </label>
      )}
    </div>
  );
}

/** Windows-Firewall an/aus (Desktop-App). */
export function HostFirewall({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const on = dev.p5?.firewallOn === true;
  return (
    <div className="pad">
      <h4>{t('hostfw.title')}</h4>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={on}
          aria-label={t('hostfw.enable')}
          onChange={(e) => void call(api.setHostFirewall(dev.id, e.target.checked))}
        />
        {t('hostfw.enable')}
      </label>
      <p className="muted small">{t('hostfw.hint')}</p>
    </div>
  );
}

/** Uhrzeit/NTP-Server eines Hosts (in der IP-Konfiguration). */
export function HostTime({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const [ntp, setNtp] = useState(dev.p5?.ntpServer ?? '');
  return (
    <>
      <h4>{t('time.title')}</h4>
      <p className="small" data-testid="host-clock">
        {fmtClock(dev.p5?.clockMs)}{' '}
        {dev.p5?.clockSynced ? `(${t('time.synced', { server: dev.p5.clockServer })})` : ''}
      </p>
      <div className="form inline">
        <input
          aria-label={t('time.ntpServer')}
          placeholder="NTP"
          value={ntp}
          onChange={(e) => setNtp(e.target.value)}
        />
        <button onClick={() => void call(api.setHostNtp(dev.id, ntp.trim()))}>
          {t('time.ntpApply')}
        </button>
      </div>
    </>
  );
}

/** Dateien des Hosts (für FTP/TFTP in der Eingabeaufforderung). */
export function HostFiles({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  return (
    <div className="pad scroll">
      <h4>{t('files.title')}</h4>
      <p className="muted small">{t('files.hint')}</p>
      <ul className="ping-list" aria-label={t('files.title')}>
        {Object.entries(dev.p5?.files ?? {}).map(([n, size]) => (
          <li key={n}>
            {n} <span className="muted">({size} B)</span>{' '}
            <button
              aria-label={`${t('common.remove')} ${n}`}
              onClick={() => void call(api.setHostFile(dev.id, n, null))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="form">
        <label>
          {t('files.name')}
          <input
            aria-label={t('files.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t('files.content')}
          <textarea
            aria-label={t('files.content')}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button
          onClick={() =>
            void call(api.setHostFile(dev.id, name.trim(), text)).then((ok) => {
              if (ok) {
                setName('');
                setText('');
              }
            })
          }
        >
          {t('files.save')}
        </button>
      </div>
    </div>
  );
}
