import { useEffect, useState } from 'react';
import type { ColumnProfile } from '../../../src/core/profile';
import type { ColumnMeta, HostMessage } from '../../../src/shared/messages';
import { request } from '../vscode';

interface Props {
  col: number;
  column: ColumnMeta;
  /** Changes when the data or view changes, so the profile refreshes. */
  version: number;
  onFilterValue: (value: string) => void;
  onShowInvalid: () => void;
  onClose: () => void;
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 }));

function fmtValue(n: number, type: string) {
  return type === 'date' || type === 'datetime' ? new Date(n).toISOString().slice(0, type === 'date' ? 10 : 19).replace('T', ' ') : fmt(n);
}

export function ProfilePanel({ col, column, version, onFilterValue, onShowInvalid, onClose }: Props) {
  const [p, setP] = useState<ColumnProfile | null>(null);
  useEffect(() => {
    let live = true;
    void request<Extract<HostMessage, { type: 'profile' }>>((reqId) => ({ type: 'profile', reqId, col })).then((m) => live && setP(m.profile));
    return () => {
      live = false;
    };
  }, [col, version]);

  const max = p?.top[0]?.count ?? 1;
  return (
    <aside className="profile-panel">
      <div className="panel-head">
        <b title={column.name}>{column.name}</b>
        <span className={`type-badge t-${column.type}`}>{column.type}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      {!p ? (
        <div className="muted pad">Profiling…</div>
      ) : (
        <div className="pad">
          <div className="muted small-text">For rows in the current view</div>
          <dl className="stats">
            <dt>Rows</dt>
            <dd>{fmt(p.count)}</dd>
            <dt>Empty</dt>
            <dd>
              {fmt(p.empty)} {p.count ? <span className="muted">({Math.round((p.empty / p.count) * 100)}%)</span> : null}
            </dd>
            <dt>Distinct</dt>
            <dd>{fmt(p.distinct)}</dd>
            <dt>Type match</dt>
            <dd>
              {Math.round(column.confidence * 100)}%
              {p.invalid > 0 && (
                <button className="link warn" onClick={onShowInvalid}>
                  {' '}
                  {fmt(p.invalid)} invalid → show
                </button>
              )}
            </dd>
            {p.numeric && (
              <>
                <dt>Min</dt>
                <dd>{fmtValue(p.numeric.min, column.type)}</dd>
                <dt>Max</dt>
                <dd>{fmtValue(p.numeric.max, column.type)}</dd>
                {column.type !== 'date' && column.type !== 'datetime' && (
                  <>
                    <dt>Mean</dt>
                    <dd>{fmt(p.numeric.mean)}</dd>
                    <dt>Sum</dt>
                    <dd>{fmt(p.numeric.sum)}</dd>
                  </>
                )}
                <dt>Median</dt>
                <dd>{fmtValue(p.numeric.median, column.type)}</dd>
                <dt>P95</dt>
                <dd>{fmtValue(p.numeric.p95, column.type)}</dd>
              </>
            )}
            <dt>Length</dt>
            <dd>
              {p.length.min}–{p.length.max} <span className="muted">(avg {p.length.mean.toFixed(1)})</span>
            </dd>
          </dl>
          <div className="section-label">Top values</div>
          <div className="bars">
            {p.top.map((t) => (
              <button key={t.value} className="bar-row" onClick={() => onFilterValue(t.value)} title="Filter to this value">
                <span className="bar-label">{t.value}</span>
                <span className="bar" style={{ width: `${(t.count / max) * 100}%` }} />
                <span className="bar-count">{fmt(t.count)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
