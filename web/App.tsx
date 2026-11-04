import { useCallback, useEffect, useRef, useState } from 'react';
import { IDLE_STOP_MS, IDLE_WARNING_MS } from '@votaciones/shared/verificacion';
import type {
  CaseRecord,
  Identity,
  InstanceMetrics,
  ServerMessage,
  Snapshot,
} from '@votaciones/shared/verificacion';

const labels: Record<string, string> = {
  TAKEN: 'Caso asignado. Puedes comenzar la revisión.',
  RELEASED: 'El caso volvió a la cola.',
  BUSY: 'Otro auditor tomó este caso.',
  STALE_TOKEN: 'Tu asignación ya no está vigente. Consulta el estado actual.',
  ALREADY_WORKING: 'Libera tu caso actual antes de tomar otro.',
  INACTIVE: 'Se detuvo la renovación por inactividad.',
  SESSION_REPLACED: 'Se abrió otra sesión con tu identidad. Esta conexión se cerró.',
  UNAVAILABLE: 'No se pudo confirmar la operación. Comprueba el estado al reconectar.',
  UNAUTHORIZED: 'La credencial no es válida.',
  FORBIDDEN: 'Tu perfil no puede realizar esta operación.',
  PENDING_A: 'Resolución sin aplicar: falta conectar el módulo de A. El caso sigue abierto.',
  APPLIED: 'Resolución aplicada al preconteo. El caso quedó cerrado.',
  INVALID_CASE: 'El caso ya no coincide con el acta registrada. Consulta el estado actual.',
  INVALID_VOTES: 'La corrección debe incluir todas las casillas con números enteros.',
  RESOLUTION_CONFLICT: 'Esta asignación ya se resolvió con otra decisión.',
};
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
const time = (n: number) =>
  new Date(n).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const validCredential = (value: string | null): value is string =>
  value !== null && /^[A-Za-z0-9._~-]{4,256}$/.test(value);
export function App() {
  // La credencial vive solo en memoria: no queda en el almacenamiento del navegador
  // (una recarga pide ingresarla otra vez; el caso propio se reanuda al reconectar).
  const [credential, setCredential] = useState('');
  const [input, setInput] = useState(''),
    [demo, setDemo] = useState(false),
    [identity, setIdentity] = useState<Identity>();
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [status, setStatus] = useState('Sin conexión'),
    [instance, setInstance] = useState('');
  const [tab, setTab] = useState<'cases' | 'team' | 'platform'>('cases'),
    [selected, setSelected] = useState(''),
    [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<{ text: string; kind: string }>(),
    [now, setNow] = useState(Date.now()),
    [lastAction, setLastAction] = useState(Date.now());
  const [metrics, setMetrics] = useState<InstanceMetrics[]>([]),
    [expected, setExpected] = useState(2),
    [metricError, setMetricError] = useState('');
  const socket = useRef<WebSocket | undefined>(undefined),
    active = useRef(false),
    replaced = useRef(false);
  const send = useCallback((data: Record<string, unknown>) => {
    if (socket.current?.readyState !== WebSocket.OPEN) {
      setNotice({ text: 'No hay conexión. Espera a la reconexión para continuar.', kind: 'error' });
      return;
    }
    socket.current.send(JSON.stringify({ ...data, requestId: crypto.randomUUID() }));
  }, []);
  useEffect(() => {
    void fetch('/whoami')
      .then((r) => r.json())
      .then((v) => setDemo(v.demo))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const activity = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-idle-confirm]')) return;
      active.current = true;
      setLastAction(Date.now());
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((event) => window.addEventListener(event, activity, { passive: true }));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      events.forEach((event) => window.removeEventListener(event, activity));
    };
  }, []);
  useEffect(() => {
    if (!credential) return;
    let disposed = false,
      retry = 0,
      reconnect: ReturnType<typeof setTimeout> | undefined,
      syncTimer: ReturnType<typeof setTimeout> | undefined;
    replaced.current = false;
    const connect = () => {
      if (disposed || replaced.current) return;
      setStatus(retry ? 'Reconectando…' : 'Conectando…');
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/auditor`,
      );
      socket.current = ws;
      ws.onopen = () =>
        ws.send(JSON.stringify({ type: 'auth', credential, requestId: crypto.randomUUID() }));
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as ServerMessage;
        setInstance(msg.instance);
        if (msg.type === 'hello') {
          retry = 0;
          setStatus('En línea');
          setIdentity(msg.identity);
        }
        if (msg.snapshot) setSnapshot(msg.snapshot);
        if (msg.type === 'changed' && !syncTimer)
          syncTimer = setTimeout(() => {
            syncTimer = undefined;
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: 'sync', requestId: crypto.randomUUID() }));
          }, 550);
        if (msg.code === 'UNAUTHORIZED' || msg.code === 'SESSION_REPLACED') {
          replaced.current = true;
          setStatus('Sesión cerrada');
        }
        if (msg.code && !['PRESENT', 'RENEWED', 'RESUMED'].includes(msg.code))
          setNotice({
            text: labels[msg.code] || msg.detail || msg.code,
            kind:
              msg.code === 'PENDING_A'
                ? 'pending'
                : msg.type === 'error' ||
                    [
                      'BUSY',
                      'STALE_TOKEN',
                      'INACTIVE',
                      'INVALID_CASE',
                      'INVALID_VOTES',
                      'RESOLUTION_CONFLICT',
                    ].includes(msg.code)
                  ? 'error'
                  : 'ok',
          });
      };
      ws.onclose = () => {
        if (disposed) return;
        if (!replaced.current) {
          setStatus('Sin conexión · reintentando');
          reconnect = setTimeout(connect, Math.random() * Math.min(30000, 1000 * 2 ** retry++));
        }
      };
      ws.onerror = () => ws.close();
    };
    connect();
    const heartbeat = setInterval(() => {
      if (socket.current?.readyState === WebSocket.OPEN) {
        socket.current.send(
          JSON.stringify({
            type: 'heartbeat',
            requestId: crypto.randomUUID(),
            active: active.current,
          }),
        );
        active.current = false;
        socket.current.send(JSON.stringify({ type: 'sync', requestId: crypto.randomUUID() }));
      }
    }, 10000);
    return () => {
      disposed = true;
      clearInterval(heartbeat);
      clearTimeout(reconnect);
      clearTimeout(syncTimer);
      socket.current?.close();
    };
  }, [credential]);
  useEffect(() => {
    if (identity?.role !== 'coordinator' || !credential) return;
    let disposed = false;
    const load = async () => {
      try {
        const res = await fetch('/api/metrics', {
          headers: { Authorization: `Bearer ${credential}` },
        });
        if (!res.ok) throw new Error('No se pudieron consultar las métricas');
        const data = await res.json();
        if (!disposed) {
          setMetrics(data.instances);
          setExpected(data.expectedReplicas);
          setMetricError('');
        }
      } catch {
        if (!disposed) setMetricError('Sin una muestra reciente. Comprueba Redis y la conexión.');
      }
    };
    void load();
    const id = setInterval(() => {
      void load();
    }, 3000);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [credential, identity?.role]);
  const login = (value: string) => {
    const normalized = value.trim();
    if (!validCredential(normalized)) {
      setNotice({ text: 'La credencial contiene caracteres no permitidos.', kind: 'error' });
      return;
    }
    setNotice(undefined);
    setCredential(normalized);
  };
  const logout = () => {
    setCredential('');
    setIdentity(undefined);
    setSnapshot(undefined);
    setNotice(undefined);
  };
  if (!credential)
    return (
      <div className="login-page">
        <div className="login-intro">
          <div className="wordmark">
            <span className="mark">V</span> VOTACIONES <span className="tag">PRECONTEO</span>
          </div>
          <div>
            <span className="eyebrow light">MESA DE VERIFICACIÓN</span>
            <h1>
              Cada acta,
              <br />
              con una revisión
              <br />
              responsable.
            </h1>
            <p>
              Un espacio compartido para revisar inconsistencias, organizar el trabajo y seguir la
              operación.
            </p>
          </div>
          <small>Persona C · Verificación y plataforma</small>
        </div>
        <main className="login-form">
          <span className="eyebrow">ACCESO AL EQUIPO</span>
          <h2>Entra a tu mesa</h2>
          <p>Usa la credencial asignada por coordinación.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              login(input.trim());
            }}
          >
            <label htmlFor="credential">Credencial de acceso</label>
            <input
              id="credential"
              type="password"
              autoComplete="current-password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              required
            />
            <button className="primary" type="submit">
              Entrar a la consola <span>→</span>
            </button>
          </form>
          {demo && (
            <div className="demo-access">
              <span className="badge amber">ENTORNO DE DEMOSTRACIÓN</span>
              <p>Prueba una identidad. Cada pestaña conserva su propia sesión.</p>
              <div className="demo-buttons">
                <button onClick={() => login('demo-ana')}>Ana · auditora</button>
                <button onClick={() => login('demo-luis')}>Luis · auditor</button>
                <button onClick={() => login('demo-coord')}>Coordinación</button>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  const cases = snapshot?.cases || [],
    own = cases.find((c) => c.owner === identity?.id && c.status === 'assigned');
  const current = cases.find((c) => c.id === selected) || own;
  const pending = cases.filter((c) => c.status === 'pending').length,
    assigned = cases.filter((c) => c.status === 'assigned').length;
  const idle = now - lastAction;
  const connected = status === 'En línea';
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="wordmark">
          <span className="mark">V</span> VOTACIONES
        </div>
        <div className="workspace-label">
          PRECONTEO ELECTORAL
          <br />
          <strong>Mesa de verificación</strong>
        </div>
        <nav aria-label="Secciones de la consola">
          <button className={tab === 'cases' ? 'active' : ''} onClick={() => setTab('cases')}>
            <span>▤</span> Verificación <b>{pending}</b>
          </button>
          <button className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')}>
            <span>◎</span> Equipo presente
          </button>
          {identity?.role === 'coordinator' && (
            <button
              className={tab === 'platform' ? 'active' : ''}
              onClick={() => setTab('platform')}
            >
              <span>▥</span> Plataforma
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className={`dot ${connected ? 'green' : ''}`} />
          {status}
          <small>Instancia {instance || '—'}</small>
          <div className="profile">
            <span className="avatar">{identity?.name[0] || '·'}</span>
            <div>
              <strong>{identity?.name || 'Validando acceso'}</strong>
              <small>{identity?.role === 'coordinator' ? 'Coordinación' : 'Auditoría'}</small>
            </div>
            <button onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión">
              ↗
            </button>
          </div>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <span>
            Operación /{' '}
            {tab === 'cases' ? 'Verificación de actas' : tab === 'team' ? 'Equipo' : 'Plataforma'}
          </span>
          <span>
            {snapshot?.demo && <span className="badge amber">DATOS DE PRUEBA</span>}
            <span className="clock">{time(now)}</span>
          </span>
        </header>
        <main className="main">
          <div className="page-title">
            <div>
              <span className="eyebrow">
                {tab === 'platform' ? 'OBSERVABILIDAD' : 'TRABAJO COMPARTIDO'}
              </span>
              <h1>
                {tab === 'cases'
                  ? 'Revisión de actas'
                  : tab === 'team'
                    ? 'Equipo presente'
                    : 'Estado de la plataforma'}
              </h1>
              <p>
                {tab === 'cases'
                  ? 'Revisa las inconsistencias. Cada caso tiene un único responsable.'
                  : tab === 'team'
                    ? 'Presencia compartida entre todas las réplicas.'
                    : 'Muestras del proceso real, publicadas en Redis cada 5 segundos.'}
              </p>
            </div>
            <button onClick={() => send({ type: 'sync' })}>↻ Actualizar</button>
          </div>
          {!connected && (
            <div className="notice error" role="status">
              {status}. Las acciones estarán disponibles al recuperar la conexión.
              {replaced.current && <button onClick={logout}>Volver al acceso</button>}
            </div>
          )}
          {notice && (
            <div className={`notice ${notice.kind}`} role="status">
              <span>{notice.text}</span>
              <button aria-label="Cerrar aviso" onClick={() => setNotice(undefined)}>
                ×
              </button>
            </div>
          )}
          {own && idle >= IDLE_WARNING_MS && (
            <div className="notice pending" role="alert">
              {idle >= IDLE_STOP_MS
                ? 'La renovación se detuvo por inactividad.'
                : 'Llevas 8 minutos sin actividad. La renovación se detendrá a los 10.'}
              <button
                data-idle-confirm
                onClick={() => {
                  active.current = true;
                  setLastAction(Date.now());
                  send({ type: 'heartbeat', active: true });
                }}
              >
                Sigo trabajando
              </button>
            </div>
          )}
          {tab === 'cases' && (
            <>
              <div className="stats">
                <Stat label="EN ESPERA" value={pending} sub="Disponibles para revisión" />
                <Stat label="EN REVISIÓN" value={assigned} sub="Con asignación exclusiva" />
                <Stat
                  label="EQUIPO PRESENTE"
                  value={snapshot?.presence.length || 0}
                  sub="Latido en los últimos 30 s"
                />
                <Stat
                  label="MI ASIGNACIÓN"
                  value={own ? '1' : '0'}
                  sub={own ? own.id : 'Sin caso activo'}
                />
              </div>
              <div className="cases-layout">
                <section className="panel case-list">
                  <div className="panel-heading">
                    <h2>
                      Cola de verificación <span>{cases.length}</span>
                    </h2>
                    <input
                      type="search"
                      aria-label="Buscar acta o municipio"
                      placeholder="Buscar acta o municipio"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </div>
                  <div className="list-labels">
                    <span>ACTA / UBICACIÓN</span>
                    <span>ESTADO</span>
                  </div>
                  {cases
                    .filter((c) =>
                      `${c.id} ${c.municipality}`.toLowerCase().includes(filter.toLowerCase()),
                    )
                    .map((c) => (
                      <button
                        key={c.id}
                        className={`case-row ${current?.id === c.id ? 'selected' : ''}`}
                        onClick={() => setSelected(c.id)}
                      >
                        <div>
                          <strong>{c.id}</strong>
                          <p>
                            {c.municipality} · Mesa {c.mesa}
                          </p>
                          <small>{c.reason}</small>
                        </div>
                        <div>
                          <span className={`badge ${c.status === 'assigned' ? 'teal' : 'neutral'}`}>
                            {c.status === 'assigned'
                              ? 'En revisión'
                              : c.status === 'resolved'
                                ? 'Resuelta'
                                : 'Pendiente'}
                          </span>
                          <small>{c.ownerName || `Prioridad ${c.priority}`}</small>
                        </div>
                      </button>
                    ))}
                  {!cases.length && (
                    <div className="empty">
                      No hay casos en la cola.
                      <p>
                        {snapshot?.demo
                          ? 'Ejecuta npm run demo:seed para cargar la demostración.'
                          : 'Los casos aparecerán cuando A los envíe a verificación.'}
                      </p>
                    </div>
                  )}
                </section>
                <CaseDetail
                  key={current?.id || 'none'}
                  current={current}
                  identity={identity}
                  connected={connected}
                  now={now}
                  own={own}
                  send={send}
                />
              </div>
              <p className="footnote">
                Bloqueo de 30 s · Renovación cada 10 s · Recuperación automática tras expirar
              </p>
            </>
          )}
          {tab === 'team' && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Quién está trabajando</h2>
                <span className="badge teal">{snapshot?.presence.length || 0} presentes</span>
              </div>
              <div className="team-grid">
                {snapshot?.presence.map((p) => (
                  <article className="person" key={p.id}>
                    <span className="avatar">{p.name[0]}</span>
                    <h3>{p.name}</h3>
                    <span className="badge neutral">
                      {p.role === 'coordinator' ? 'Coordinación' : 'Auditoría'}
                    </span>
                    <dl>
                      <dt>Instancia</dt>
                      <dd>{p.instance}</dd>
                      <dt>Caso</dt>
                      <dd>{p.caseId || 'Sin asignación'}</dd>
                      <dt>Último latido</dt>
                      <dd>{time(p.lastSeen)}</dd>
                      <dt>Presente desde</dt>
                      <dd>{time(p.since)}</dd>
                    </dl>
                  </article>
                ))}
              </div>
              <p className="panel-note">
                Una desconexión retira la presencia. Si el cierre no llega al servidor, se elimina
                después de 30 s sin latido.
              </p>
            </section>
          )}
          {tab === 'platform' && (
            <>
              {metricError && <div className="notice error">{metricError}</div>}
              <SimulationPanel credential={credential} />
              <div className="stats">
                <Stat
                  label="RÉPLICAS CON MUESTRA"
                  value={`${metrics.filter((m) => now - m.sampledAt < 15000).length} / ${expected}`}
                  sub="Muestra con menos de 15 s"
                />
                <Stat
                  label="CONEXIONES"
                  value={metrics.reduce((n, m) => n + m.connections, 0)}
                  sub="Auditores, público y banco de carga"
                />
                <Stat
                  label="MENSAJES / SEGUNDO"
                  value={metrics.reduce((n, m) => n + m.messagesPerSecond, 0).toFixed(1)}
                  sub="Entrada + salida observadas"
                />
                <Stat
                  label="MEMORIA RSS"
                  value={`${mb(metrics.reduce((n, m) => n + m.rssBytes, 0))} MB`}
                  sub="Suma de procesos con muestra"
                />
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Detalle por instancia</h2>
                  <span className="badge neutral">Medición real</span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Instancia</th>
                        <th>Conexiones</th>
                        <th>Mensajes/s</th>
                        <th>RSS / heap</th>
                        <th>Loop p50 / p99 / máx.</th>
                        <th>Muestra</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.map((m) => (
                        <tr key={m.instance}>
                          <td>
                            <span className={`dot ${now - m.sampledAt < 15000 ? 'green' : ''}`} />
                            {m.instance}
                          </td>
                          <td
                            title={`Auditores y eco: ${m.verificationConnections}; público: ${m.publicConnections}`}
                          >
                            {m.connections}
                          </td>
                          <td>{m.messagesPerSecond.toFixed(1)}</td>
                          <td>
                            {mb(m.rssBytes)} / {mb(m.heapBytes)} MB
                          </td>
                          <td>
                            {m.eventLoopP50Ms.toFixed(1)} / {m.eventLoopP99Ms.toFixed(1)} /{' '}
                            {m.eventLoopMaxMs.toFixed(1)} ms
                          </td>
                          <td>
                            {now - m.sampledAt < 15000 ? time(m.sampledAt) : 'Sin muestra reciente'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <div className="stats">
                <Stat
                  label="ACTAS / MINUTO"
                  value={
                    metrics.some((m) => m.acceptedActasPerMinute !== null)
                      ? metrics.reduce((n, m) => n + (m.acceptedActasPerMinute ?? 0), 0)
                      : '—'
                  }
                  sub="Aplicadas por primera vez, suma de réplicas (último minuto)"
                />
                <Stat
                  label="LATENCIA ACTA → PÚBLICO"
                  value={(() => {
                    const values = metrics
                      .map((m) => m.publicLatencyP95Ms)
                      .filter((v): v is number => v !== null);
                    return values.length ? `${Math.round(Math.max(...values))} ms` : '—';
                  })()}
                  sub="p95 de la peor réplica (último minuto)"
                />
              </div>
            </>
          )}
        </main>
        <footer>
          VOTACIONES <span>Preconteo electoral · A + B + C</span>
        </footer>
      </div>
    </div>
  );
}
type Simulation =
  | { estado: 'inactiva' }
  | {
      estado: 'en_curso' | 'terminada' | 'detenida' | 'interrumpida';
      instancia: string;
      aceleracion: number;
      solicitudes: number;
      enviadas: number;
      porEstado: Record<string, number>;
    };
const simulationLabels: Record<string, string> = {
  inactiva: 'Sin jornada',
  en_curso: 'En curso',
  terminada: 'Terminada',
  detenida: 'Detenida',
  interrumpida: 'Interrumpida (la réplica que la ejecutaba se detuvo)',
};
// RT-10: la jornada simulada se activa desde aquí, sin depender del grupo.
function SimulationPanel({ credential }: { credential: string }) {
  const [state, setState] = useState<Simulation>();
  const [speed, setSpeed] = useState(60);
  const [reset, setReset] = useState(false);
  const [error, setError] = useState('');
  const call = async (body?: object) => {
    const res = await fetch('/api/demo/jornada', {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${credential}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) throw new Error('Esta instancia no tiene jornada simulada.');
    const data = await res.json();
    if (!res.ok)
      throw new Error(
        data.motivo === 'EN_CURSO' ? 'Ya hay una jornada en curso.' : 'No se pudo completar.',
      );
    return data;
  };
  useEffect(() => {
    let disposed = false;
    const load = () =>
      call()
        .then((data: Simulation) => !disposed && (setState(data), setError('')))
        .catch((e: Error) => !disposed && setError(e.message));
    void load();
    const id = setInterval(load, 2000);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [credential]);
  const running = state?.estado === 'en_curso';
  const progress =
    state && state.estado !== 'inactiva' && state.solicitudes
      ? Math.round((100 * state.enviadas) / state.solicitudes)
      : 0;
  return (
    <section className="panel simulation-panel">
      <div className="panel-heading">
        <h2>Jornada simulada</h2>
        <span className={`badge ${running ? 'amber' : 'neutral'}`}>
          {simulationLabels[state?.estado ?? 'inactiva']}
        </span>
      </div>
      <p className="panel-note">
        6.400 actas por la ingesta real: 55 % en los primeros 40 min, ráfagas de 300/min, reenvíos,
        correcciones y actas dudosas que llegan a la cola de verificación. Repetirla sin borrar
        reenvía las mismas actas: vuelven como YA_REGISTRADA (idempotencia).
      </p>
      {state && state.estado !== 'inactiva' && (
        <p className="panel-note">
          {state.enviadas} / {state.solicitudes} solicitudes ({progress} %) · ×{state.aceleracion} ·
          réplica {state.instancia} ·{' '}
          {Object.entries(state.porEstado)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')}
        </p>
      )}
      {error && <div className="notice error">{error}</div>}
      <div className="simulation-actions">
        <label>
          Velocidad
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            disabled={running}
          >
            <option value={1}>Tiempo real (2 h)</option>
            <option value={12}>×12 (10 min)</option>
            <option value={60}>×60 (2 min)</option>
            <option value={240}>×240 (30 s)</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={reset}
            onChange={(e) => setReset(e.target.checked)}
            disabled={running}
          />
          Borrar resultados antes de empezar
        </label>
        {running ? (
          <button
            className="primary"
            onClick={() =>
              void call({ accion: 'detener' }).catch((e: Error) => setError(e.message))
            }
          >
            Detener
          </button>
        ) : (
          <button
            className="primary"
            onClick={() =>
              void call({ accion: 'iniciar', aceleracion: speed, reiniciar: reset })
                .then(() => call().then(setState))
                .catch((e: Error) => setError(e.message))
            }
          >
            Iniciar jornada
          </button>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <article className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </article>
  );
}
function CaseDetail({
  current: c,
  identity,
  connected,
  now,
  own,
  send,
}: {
  current?: CaseRecord;
  identity?: Identity;
  connected: boolean;
  now: number;
  own?: CaseRecord;
  send: (v: Record<string, unknown>) => void;
}) {
  const [note, setNote] = useState(''),
    [action, setAction] = useState('approve'),
    [votes, setVotes] = useState<Record<string, number>>(c?.votes || {});
  if (!c)
    return (
      <section className="panel detail empty">
        <span className="empty-icon">▤</span>
        <h2>Selecciona un acta</h2>
        <p>Consulta el motivo de revisión y toma el caso para trabajar.</p>
      </section>
    );
  const mine = c.owner === identity?.id && c.status === 'assigned';
  return (
    <section className="panel detail">
      <div className="detail-header">
        <span className="eyebrow">DETALLE DEL CASO</span>
        <h2>{c.id}</h2>
        <p>
          {c.municipality} · Mesa {c.mesa} · Versión {c.version}
        </p>
      </div>
      <div className="detail-body">
        <span className="field-label">MOTIVO DE REVISIÓN</span>
        <p className="reason">{c.reason}</p>
        <div className="vote-heading">
          <h3>Votos reportados</h3>
          <small>
            {action === 'correct' && mine ? 'Propuesta de corrección' : 'Datos recibidos'}
          </small>
        </div>
        <div className="votes">
          {Object.entries(votes).map(([candidate, n]) => (
            <label key={candidate}>
              {candidate}
              {action === 'correct' && mine ? (
                <input
                  type="number"
                  min="0"
                  max="1000000"
                  value={n}
                  onChange={(e) => setVotes({ ...votes, [candidate]: Number(e.target.value) })}
                />
              ) : (
                <strong>{n}</strong>
              )}
            </label>
          ))}
        </div>
        {c.status === 'assigned' && (
          <div className="assignment">
            <span className="dot green" />
            <div>
              <strong>{mine ? 'Estás revisando este caso' : c.ownerName}</strong>
              <small>
                Asignado a las {time(c.assignedAt!)} · token {c.token}
              </small>
              {mine && (
                <small>
                  Concesión: {Math.max(0, Math.ceil(((c.leaseUntil || 0) - now) / 1000))} s en la
                  última fotografía
                </small>
              )}
            </div>
          </div>
        )}
        {identity?.role === 'auditor' && c.status === 'pending' && (
          <button
            className="primary full"
            disabled={!connected || Boolean(own)}
            onClick={() => send({ type: 'take', caseId: c.id })}
          >
            Tomar este caso <span>→</span>
          </button>
        )}
        {mine && (
          <>
            <div className="integration-note">
              <strong>Aplicación de A pendiente</strong>
              <p>Puedes preparar la resolución. Todavía no se aplicará al preconteo.</p>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send({
                  type: 'resolve',
                  caseId: c.id,
                  token: c.token,
                  resolution: { action, note, ...(action === 'correct' ? { votes } : {}) },
                });
              }}
            >
              <label htmlFor="action">Propuesta de resolución</label>
              <select id="action" value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="approve">Aprobar acta</option>
                <option value="correct">Corregir votos</option>
                <option value="reject">Rechazar acta</option>
              </select>
              <label htmlFor="note">Observación de la revisión</label>
              <textarea
                id="note"
                rows={3}
                minLength={5}
                maxLength={1000}
                required
                placeholder="Explica el criterio de revisión…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button className="primary full" disabled={!connected} type="submit">
                Solicitar resolución
              </button>
            </form>
            <button
              className="text-button full"
              disabled={!connected}
              onClick={() => send({ type: 'release', caseId: c.id, token: c.token })}
            >
              Liberar y devolver a la cola
            </button>
          </>
        )}
        {identity?.role === 'coordinator' && (
          <p className="panel-note">
            Vista de coordinación. La revisión la realiza el auditor asignado.
          </p>
        )}
      </div>
    </section>
  );
}
