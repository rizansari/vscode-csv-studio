import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ValueCount } from '../../../src/core/profile';
import { isNumericType, type ColumnType } from '../../../src/core/types';
import { FILTER_LABELS, type Filter, type FilterOp } from '../../../src/core/view';
import type { HostMessage } from '../../../src/shared/messages';
import { request } from '../vscode';

interface Props {
  col: number;
  name: string;
  type?: ColumnType;
  anchor: DOMRect;
  filters: Filter[];
  onApply: (filters: Filter[]) => void;
  onClose: () => void;
}

const TEXT_OPS: FilterOp[] = ['contains', 'notContains', 'equals', 'notEquals', 'startsWith', 'endsWith', 'regex', 'empty', 'notEmpty'];
const NUM_OPS: FilterOp[] = ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty', 'invalid'];
const NO_VALUE: FilterOp[] = ['empty', 'notEmpty', 'invalid'];

/** Type-aware condition + Excel-style distinct value list for one column. */
export function FilterPopover({ col, name, type, anchor, filters, onApply, onClose }: Props) {
  const numeric = !!type && isNumericType(type.type) && type.type !== 'boolean';
  const ops = numeric ? NUM_OPS : type && type.type !== 'string' ? [...TEXT_OPS, 'invalid' as FilterOp] : TEXT_OPS;
  const condition = filters.find((f) => f.op !== 'in' && f.op !== 'notIn');
  const list = filters.find((f) => f.op === 'in' || f.op === 'notIn');

  const [op, setOp] = useState<FilterOp>(condition?.op ?? (numeric ? 'gte' : 'contains'));
  const [value, setValue] = useState(condition?.value ?? '');
  const [value2, setValue2] = useState(condition?.value2 ?? '');
  const [caseSensitive, setCaseSensitive] = useState(!!condition?.caseSensitive);
  const [values, setValues] = useState<ValueCount[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void request<Extract<HostMessage, { type: 'distinct' }>>((reqId) => ({ type: 'distinct', reqId, col })).then((m) => {
      setValues(m.values);
      setTotal(m.total);
      if (list) {
        const set = new Set(list.values ?? []);
        setChecked(new Set(m.values.map((v) => v.value).filter((v) => (list.op === 'in' ? set.has(v) : !set.has(v)))));
      } else setChecked(new Set(m.values.map((v) => v.value)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [col]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(anchor.left, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.min(anchor.bottom + 4, Math.max(4, window.innerHeight - r.height - 8))}px`;
  });

  const shown = useMemo(() => (values ?? []).filter((v) => !search || v.value.toLowerCase().includes(search.toLowerCase())), [values, search]);

  const apply = () => {
    const out: Filter[] = [];
    if (NO_VALUE.includes(op) || value.trim() !== '') out.push({ col, op, value, value2: op === 'between' ? value2 : undefined, caseSensitive });
    if (values && checked && checked.size < values.length) {
      // Store the smaller of the two lists. When the list is truncated, only "is one of" is exact.
      const unchecked = values.map((v) => v.value).filter((v) => !checked.has(v));
      out.push(values.length < total || checked.size <= unchecked.length ? { col, op: 'in', values: [...checked] } : { col, op: 'notIn', values: unchecked });
    }
    onApply(out);
  };

  const toggle = (v: string) => {
    const next = new Set(checked);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setChecked(next);
  };

  return (
    <div className="popover filter-popover" ref={ref} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && apply()}>
      <div className="popover-title">
        Filter <b>{name}</b> {type && <span className={`type-badge t-${type.type}`}>{type.type}</span>}
      </div>
      <div className="filter-condition">
        <select value={op} onChange={(e) => setOp(e.target.value as FilterOp)}>
          {ops.map((o) => (
            <option key={o} value={o}>
              {FILTER_LABELS[o]}
            </option>
          ))}
        </select>
        {!NO_VALUE.includes(op) && <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={type?.type === 'date' ? 'YYYY-MM-DD' : 'value'} />}
        {op === 'between' && <input value={value2} onChange={(e) => setValue2(e.target.value)} placeholder="and" />}
        {!numeric && !NO_VALUE.includes(op) && (
          <label className="check" title="Match case">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Aa
          </label>
        )}
      </div>
      <div className="filter-values">
        <div className="filter-values-head">
          <input className="small" placeholder={`Search ${total.toLocaleString()} values…`} value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="link" onClick={() => setChecked(new Set([...(checked ?? []), ...shown.map((v) => v.value)]))}>
            all
          </button>
          <button className="link" onClick={() => setChecked(new Set([...(checked ?? [])].filter((v) => !shown.some((s) => s.value === v))))}>
            none
          </button>
        </div>
        <div className="value-list">
          {!values && <div className="muted">Loading…</div>}
          {shown.slice(0, 500).map((v) => (
            <label key={v.value} className="value-item">
              <input type="checkbox" checked={!!checked?.has(v.value)} onChange={() => toggle(v.value)} />
              <span className={v.value === '' ? 'muted' : ''}>{v.value === '' ? '(empty)' : v.value}</span>
              <span className="count">{v.count.toLocaleString()}</span>
            </label>
          ))}
          {values && total > values.length && <div className="muted">Showing the {values.length.toLocaleString()} most frequent values.</div>}
        </div>
      </div>
      <div className="popover-footer">
        <button className="btn" onClick={() => onApply([])}>
          Clear
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  );
}
