import { useEffect, useMemo, useState } from 'react';
import type { PreviewRow, TransformInfo, TransformSpec } from '../../../src/core/transforms/types';
import type { HostMessage, Meta, UserTransformInfo } from '../../../src/shared/messages';
import { post, request } from '../vscode';

interface Props {
  meta: Meta;
  col: number;
  presets: TransformInfo[];
  user: UserTransformInfo[];
  secrets: string[];
  filtered: boolean;
  onClose: () => void;
}

const USER_PREFIX = 'user:';

export function TransformDialog({ meta, col: initialCol, presets, user, secrets, filtered, onClose }: Props) {
  const [col, setCol] = useState(initialCol);
  const [choice, setChoice] = useState(presets[0]?.id ?? '');
  const [params, setParams] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<TransformSpec['target']>('virtual');
  const [newName, setNewName] = useState('');
  const [onlyView, setOnlyView] = useState(false);
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; errors: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const isUser = choice.startsWith(USER_PREFIX);
  const info = isUser ? null : presets.find((p) => p.id === choice);
  const colName = meta.columns[col]?.name ?? '';

  useEffect(() => {
    setParams(Object.fromEntries((info?.params ?? []).filter((p) => p.default !== undefined).map((p) => [p.name, p.default!])));
  }, [choice]); // eslint-disable-line react-hooks/exhaustive-deps

  const spec: TransformSpec = useMemo(
    () => ({ col, kind: isUser ? 'user' : 'preset', id: isUser ? choice.slice(USER_PREFIX.length) : choice, params, target, newName: newName || undefined, onlyView }),
    [col, isUser, choice, params, target, newName, onlyView],
  );

  const visible = (info?.params ?? []).filter((p) => !p.when || Object.entries(p.when).every(([k, vals]) => vals.includes(params[k] ?? '')));
  const missing = visible.filter((p) => !p.optional && p.type !== 'select' && !(params[p.name] ?? '').trim());

  const runPreview = async () => {
    setLoading(true);
    const m = await request<Extract<HostMessage, { type: 'transformPreview' }>>((reqId) => ({ type: 'transformPreview', reqId, spec }));
    setPreview({ rows: m.rows, errors: m.errors });
    setLoading(false);
  };

  // Live preview, debounced.
  useEffect(() => {
    if (missing.length || !choice) return setPreview(null);
    const t = setTimeout(() => void runPreview(), 350);
    return () => clearTimeout(t);
  }, [spec]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = [...new Set(presets.map((p) => p.group))];
  const suggestedName = `${colName}_${isUser ? choice.slice(USER_PREFIX.length) : choice.replace(/-/g, '_')}`;

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog transform-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Transform column</div>
        <div className="form-grid">
          <label>Column</label>
          <select value={col} onChange={(e) => setCol(Number(e.target.value))}>
            {meta.columns.map((c, i) => (
              <option key={c.name} value={i}>
                {c.name}
                {c.virtual ? ' (virtual)' : ''}
              </option>
            ))}
          </select>

          <label>Transform</label>
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {presets.filter((p) => p.group === g).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Your JavaScript (.vscode/csv-studio/transforms)">
              {user.map((u) => (
                <option key={u.id} value={USER_PREFIX + u.id} disabled={!!u.error && u.error === 'Workspace is not trusted'}>
                  {u.label}
                  {u.error ? ` — ${u.error}` : ''}
                </option>
              ))}
              {user.length === 0 && (
                <option value="" disabled>
                  (none yet)
                </option>
              )}
            </optgroup>
          </select>
          <span />
          <span className="muted small-text">
            {info?.description}
            {isUser && 'Runs your JavaScript in a sandbox. You will be asked to allow it the first time.'}{' '}
            <button className="link" onClick={() => post({ type: 'command', command: 'newTransform' })}>
              New JS transform…
            </button>
          </span>

          {visible.map((p) => (
            <ParamField key={p.name} spec={p} value={params[p.name] ?? ''} onChange={(v) => setParams({ ...params, [p.name]: v })} columns={meta.columns.map((c) => c.name)} secrets={secrets} />
          ))}

          <label>Result</label>
          <div className="radio-row">
            {(
              [
                ['virtual', 'Virtual column', 'Shown and usable in SQL, never written to the file'],
                ['newColumn', 'New column', 'Added to the file next to the source column'],
                ['inPlace', 'Replace values', 'Overwrites the cells in the file (undo with ⌘Z)'],
              ] as const
            ).map(([v, label, title]) => (
              <label key={v} className="check" title={title}>
                <input type="radio" name="target" checked={target === v} disabled={meta.readOnly && v !== 'virtual'} onChange={() => setTarget(v)} /> {label}
              </label>
            ))}
          </div>
          {target !== 'inPlace' && (
            <>
              <label>Column name</label>
              <input value={newName} placeholder={suggestedName} onChange={(e) => setNewName(e.target.value)} />
            </>
          )}
          {filtered && (
            <>
              <span />
              <label className="check">
                <input type="checkbox" checked={onlyView} onChange={(e) => setOnlyView(e.target.checked)} /> Only rows in the current filter ({meta.viewCount.toLocaleString()})
              </label>
            </>
          )}
        </div>

        <div className="preview">
          <div className="preview-head">
            Preview (first {preview?.rows.length ?? 0} rows of the view){preview?.errors ? <span className="error-text"> · {preview.errors} error(s)</span> : null}
            {loading && <span className="muted"> · running…</span>}
            {missing.length > 0 && <span className="muted"> · fill in: {missing.map((m) => m.label).join(', ')}</span>}
          </div>
          <div className="preview-table">
            <div className="preview-row header">
              <span>#</span>
              <span>{colName} (before)</span>
              <span>after</span>
            </div>
            {preview?.rows.map((r) => (
              <div key={r.row} className={`preview-row${r.error ? ' failed' : r.after !== r.before ? ' changed' : ''}`}>
                <span className="muted">{r.row + 1}</span>
                <span title={r.before}>{r.before}</span>
                <span title={r.error ?? r.after}>{r.error ? `⚠ ${r.error}` : r.after}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="dialog-footer">
          {secrets.length === 0 && visible.some((p) => p.type === 'secret') && (
            <span className="muted">
              No secrets yet.{' '}
              <button className="link" onClick={() => post({ type: 'command', command: 'setSecret' })}>
                Add a key…
              </button>
            </span>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!choice || missing.length > 0}
            onClick={() => {
              post({ type: 'transformApply', spec: { ...spec, newName: newName || suggestedName } });
              onClose();
            }}
          >
            Apply to {onlyView ? meta.viewCount.toLocaleString() : meta.rowCount.toLocaleString()} rows
          </button>
        </div>
      </div>
    </div>
  );
}

function ParamField({ spec, value, onChange, columns, secrets }: { spec: TransformInfo['params'][number]; value: string; onChange: (v: string) => void; columns: string[]; secrets: string[] }) {
  let input;
  if (spec.type === 'select') {
    input = (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {spec.options!.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  } else if (spec.type === 'column') {
    input = (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {columns.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    );
  } else if (spec.type === 'secret') {
    input = (
      <span className="row">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{spec.optional ? '(none)' : 'Choose a secret…'}</option>
          {secrets.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button className="link" onClick={() => post({ type: 'command', command: 'setSecret' })}>
          + add
        </button>
      </span>
    );
  } else {
    input = <input value={value} type={spec.type === 'number' ? 'number' : 'text'} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <>
      <label>
        {spec.label}
        {spec.optional ? '' : ' *'}
      </label>
      {input}
    </>
  );
}
