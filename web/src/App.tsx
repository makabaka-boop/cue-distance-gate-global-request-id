import { useState } from 'react';
import DeviationChecker from './DeviationChecker';
import PerformanceConsole from './PerformanceConsole';

type Tab = 'console' | 'deviation';

const TABS: { id: Tab; label: string }[] = [
  { id: 'console', label: '演出场次控制台' },
  { id: 'deviation', label: 'Cue 序列偏差校验' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('console');

  return (
    <main className="page">
      <header>
        <h1>舞台监督工作台</h1>
        <p className="subtitle">
          演出场次的创建、运行控制与 cue 登记；另附计划/现场 cue 序列偏差校验入口。
        </p>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'console' ? <PerformanceConsole /> : <DeviationChecker />}
    </main>
  );
}
