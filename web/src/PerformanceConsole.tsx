import { useRef, useState } from 'react';
import {
  ApiError,
  loadPerformance,
  newRequestId,
  submitPerformanceCommand,
  type Performance,
  type PerformanceStatus,
} from './api';

class ClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface ConsoleError {
  code: string;
  reason?: string;
  message: string;
}

const STATUS_LABELS: Record<PerformanceStatus, string> = {
  pending: '待演',
  running: '运行中',
  paused: '已暂停',
  ended: '已结束',
};

function parseInt32(text: string): number {
  const t = text.trim();
  if (t === '') throw new ClientError('INVALID_CUE', '请输入整数 cue。');
  const n = Number(t);
  if (!Number.isInteger(n)) throw new ClientError('INVALID_CUE', 'cue 必须是整数。');
  if (n < -2147483648 || n > 2147483647) {
    throw new ClientError('INVALID_CUE', 'cue 必须是 32 位有符号整数。');
  }
  return n;
}

export default function PerformanceConsole() {
  const [session, setSession] = useState<Performance | null>(null);
  const [error, setError] = useState<ConsoleError | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [loadBusy, setLoadBusy] = useState(false);
  const [name, setName] = useState('');
  const [loadId, setLoadId] = useState('');
  const [cueText, setCueText] = useState('');

  // Monotonic token of the last user-initiated request. Responses that were
  // superseded by a later action must never touch the view: otherwise a slow
  // load of session B could be overwritten by an even slower response for A,
  // or a stale GET snapshot could roll a freshly committed version backwards.
  const generationRef = useRef(0);
  const sessionRef = useRef<Performance | null>(null);
  const commandInFlightRef = useRef(0);
  const loadInFlightRef = useRef(0);

  function reportError(err: unknown): ConsoleError {
    if (err instanceof ApiError) {
      return { code: err.code, reason: err.reason, message: err.message };
    }
    if (err instanceof ClientError) {
      return { code: err.code, message: err.message };
    }
    return { code: 'NETWORK', message: '无法连接服务，请确认 API 已启动。' };
  }

  /**
   * Merge an arriving snapshot with the one on screen. Loads and commands may
   * be in flight at the same time and may finish in any order. A response
   * belonging to the latest user action may switch the displayed session, but
   * a GET must never downgrade a version a command already committed. A
   * response superseded by a newer action may only catch the same session up
   * in version — it can never switch sessions or surface a stale error.
   */
  function adoptSnapshot(next: Performance, stale: boolean) {
    const current = sessionRef.current;
    if (stale) {
      if (!current || current.id !== next.id || next.version <= current.version) {
        return;
      }
    } else if (current && current.id === next.id && current.version > next.version) {
      return;
    }
    sessionRef.current = next;
    setSession(next);
  }

  function runCommand(action: () => Promise<Performance>) {
    const gen = ++generationRef.current;
    commandInFlightRef.current += 1;
    setCommandBusy(true);
    setError(null);
    void action().then(
      (snapshot) => {
        adoptSnapshot(snapshot, generationRef.current !== gen);
      },
      (err) => {
        if (generationRef.current !== gen) return;
        // A rejected command changes nothing server-side: keep the snapshot.
        setError(reportError(err));
      },
    ).finally(() => {
      commandInFlightRef.current -= 1;
      if (commandInFlightRef.current === 0) setCommandBusy(false);
    });
  }

  // The only write entry: build a command envelope from the current snapshot.
  function dispatch(command: Parameters<typeof submitPerformanceCommand>[0]) {
    runCommand(() => submitPerformanceCommand(command));
  }

  function onCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError({ code: 'INVALID_BODY', message: '请填写场次名称。' });
      return;
    }
    void dispatch({ command: 'create', name: trimmed, requestId: newRequestId() });
  }

  function onLoad() {
    const id = loadId.trim();
    if (!id) {
      setError({ code: 'INVALID_BODY', message: '请输入要载入的场次 ID。' });
      return;
    }
    const gen = ++generationRef.current;
    loadInFlightRef.current += 1;
    setLoadBusy(true);
    setError(null);
    void loadPerformance(id).then(
      (snapshot) => {
        adoptSnapshot(snapshot, generationRef.current !== gen);
      },
      (err) => {
        if (generationRef.current !== gen) return;
        // A failed load (e.g. unknown id) must not wipe the session on screen;
        // the stage manager keeps the previous snapshot for comparison.
        setError(reportError(err));
      },
    ).finally(() => {
      loadInFlightRef.current -= 1;
      if (loadInFlightRef.current === 0) setLoadBusy(false);
    });
  }

  function transition(status: PerformanceStatus) {
    if (!session) return;
    void dispatch({
      command: 'transition',
      performanceId: session.id,
      status,
      expectedVersion: session.version,
      requestId: newRequestId(),
    });
  }

  function onRegisterCue() {
    if (!session) return;
    let cue: number;
    try {
      cue = parseInt32(cueText);
    } catch (err) {
      setError(reportError(err));
      return;
    }
    setCueText('');
    void dispatch({
      command: 'registerCue',
      performanceId: session.id,
      cue,
      expectedVersion: session.version,
      requestId: newRequestId(),
    });
  }

  return (
    <section className="console">
      <div className="console-entry">
        <label className="field">
          <span>创建场次（舞台监督）</span>
          <span className="field-row">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="场次名称，例如：9 月 17 日晚场"
              disabled={commandBusy}
            />
            <button onClick={onCreate} disabled={commandBusy}>
              创建
            </button>
          </span>
        </label>
        <label className="field">
          <span>按 ID 载入快照</span>
          <span className="field-row">
            <input
              type="text"
              value={loadId}
              onChange={(e) => setLoadId(e.target.value)}
              placeholder="场次 ID（UUID）"
              disabled={loadBusy}
              spellCheck={false}
            />
            <button className="secondary" onClick={onLoad} disabled={loadBusy}>
              载入
            </button>
          </span>
        </label>
      </div>

      {error && (
        <div className="verdict error console-error" role="alert">
          <strong>
            <code>{error.code}</code>
            {error.reason ? (
              <>
                {' '}
                / <code>{error.reason}</code>
              </>
            ) : null}
          </strong>
          <span>{error.message}</span>
          <span className="error-hint">当前场次保留在页面上，数据未被改动。</span>
        </div>
      )}

      {!session && (
        <p className="console-empty">尚未打开场次：创建一场新演出，或按 ID 载入已有场次。</p>
      )}

      {session && (
        <article className="session">
          <header className="session-head">
            <div>
              <h2>{session.name}</h2>
              <p className="session-id" title={session.id}>
                ID：<code>{session.id}</code>
              </p>
            </div>
            <span className={`badge badge-${session.status}`}>
              {STATUS_LABELS[session.status]}
            </span>
          </header>

          <dl className="facts">
            <div>
              <dt>版本</dt>
              <dd>{session.version}</dd>
            </div>
            <div>
              <dt>已登记 cue</dt>
              <dd>{session.cues.length}</dd>
            </div>
            <div className="fact-wide">
              <dt>最近提交请求标识</dt>
              <dd>
                <code>{session.requestId ?? '—'}</code>
              </dd>
            </div>
          </dl>

          {session.status === 'pending' && (
            <div className="actions">
              <button onClick={() => transition('running')} disabled={commandBusy}>
                开演（待演 → 运行）
              </button>
            </div>
          )}

          {session.status === 'running' && (
            <>
              <div className="actions">
                <button className="secondary" onClick={() => transition('paused')} disabled={commandBusy}>
                  暂停
                </button>
                <button className="danger" onClick={() => transition('ended')} disabled={commandBusy}>
                  结束
                </button>
              </div>
              <div className="cue-entry">
                <label className="field">
                  <span>逐条登记整数 cue（仅运行态可写入）</span>
                  <span className="field-row">
                    <input
                      type="number"
                      step={1}
                      value={cueText}
                      onChange={(e) => setCueText(e.target.value)}
                      placeholder="整数 cue，如 101"
                      disabled={commandBusy}
                    />
                    <button onClick={onRegisterCue} disabled={commandBusy}>
                      登记
                    </button>
                  </span>
                </label>
              </div>
            </>
          )}

          {session.status === 'paused' && (
            <div className="actions">
              <button onClick={() => transition('running')} disabled={commandBusy}>
                继续（→ 运行）
              </button>
              <button className="danger" onClick={() => transition('ended')} disabled={commandBusy}>
                结束
              </button>
            </div>
          )}

          <Timeline session={session} />
        </article>
      )}
    </section>
  );
}

function Timeline({ session }: { session: Performance }) {
  const sealed = session.status === 'ended';
  return (
    <div className={`timeline${sealed ? ' sealed' : ''}`}>
      <h3>
        {sealed ? '封存时间线（只读）' : '现场时间线'}
        <span className="timeline-count">{session.cues.length} 条</span>
      </h3>
      {session.cues.length === 0 ? (
        <p className="timeline-empty">暂无 cue。</p>
      ) : (
        <ol className="cue-list">
          {session.cues.map((cue, i) => (
            <li key={i}>
              <span className="cue-index">#{i + 1}</span>
              <span className="cue-value">{cue}</span>
            </li>
          ))}
        </ol>
      )}
      {sealed && <p className="sealed-note">场次已结束，时间线封存，不再接受写入。</p>}
    </div>
  );
}
