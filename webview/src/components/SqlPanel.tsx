import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ColumnMeta, HostMessage, Meta, SavedQuery, SqlFunctionInfo, SqlResultData } from '../../../src/shared/messages';
import { post, request } from '../vscode';
import { Grid, type GridData, type GridLayout } from './Grid';
import { useMenu, type MenuItem } from './Menu';

export interface SqlPanelHandle {
  focus(): void;
  setText(text: string): void;
}

interface Props {
  meta: Meta;
  history: SavedQuery[];
  saved: SavedQuery[];
  functions: SqlFunctionInfo[];
  initialText: string;
  onTextChange: (t: string) => void;
}

const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'JOIN', 'LEFT JOIN', 'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'REGEXP', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION ALL', 'WITH', 'OVER', 'PARTITION BY', 'ROW_NUMBER()', 'strftime', 'date', 'substr', 'lower', 'upper', 'trim', 'round', 'coalesce', 'ifnull', 'cast', 'json_extract', 'group_concat'];

const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !KEYWORDS.includes(n.toUpperCase()) ? n : `"${n.replace(/"/g, '""')}"`);

function examples(cols: ColumnMeta[], tables: string[]): [string, string][] {
  const text = cols.find((c) => c.type === 'string' && !c.virtual)?.name ?? cols[0]?.name ?? 'col';
  const num = cols.find((c) => ['integer', 'decimal', 'currency', 'percent'].includes(c.type))?.name;
  const date = cols.find((c) => c.type === 'date' || c.type === 'datetime')?.name;
  const out: [string, string][] = [
    ['First 100 rows', 'SELECT *\nFROM data\nLIMIT 100'],
    [`Count by ${text}`, `SELECT ${ident(text)}, COUNT(*) AS n\nFROM data\nGROUP BY 1\nORDER BY n DESC`],
    [`Duplicate ${text} values`, `SELECT ${ident(text)}, COUNT(*) AS n\nFROM data\nGROUP BY 1\nHAVING n > 1\nORDER BY n DESC`],
    [`Rows where ${text} matches a regex`, `SELECT *\nFROM data\nWHERE ${ident(text)} REGEXP '^[A-M]'`],
  ];
  if (num) {
    out.push([`Stats of ${num}`, `SELECT COUNT(${ident(num)}) AS n, MIN(${ident(num)}) AS min, MAX(${ident(num)}) AS max, ROUND(AVG(${ident(num)}), 2) AS avg, SUM(${ident(num)}) AS total\nFROM data`]);
    out.push([`Top 3 ${num} per ${text} (window function)`, `SELECT *\nFROM (\n  SELECT *, ROW_NUMBER() OVER (PARTITION BY ${ident(text)} ORDER BY ${ident(num)} DESC) AS rn\n  FROM data\n)\nWHERE rn <= 3`]);
    out.push([`Above-average ${num}`, `SELECT *\nFROM data\nWHERE ${ident(num)} > (SELECT AVG(${ident(num)}) FROM data)`]);
  }
  if (date) out.push([`Rows per month of ${date}`, `SELECT strftime('%Y-%m', ${ident(date)}) AS month, COUNT(*) AS n\nFROM data\nGROUP BY month\nORDER BY month`]);
  out.push([`Decrypt a column (needs a secret)`, `SELECT ${ident(text)}, decrypt(${ident(text)}, 'my-key') AS plain\nFROM data\nLIMIT 50`]);
  out.push(['Mask + hash for sharing', `SELECT mask(${ident(text)}, 0, 4) AS masked, hash(${ident(text)}) AS hashed\nFROM data`]);
  const extra = tables.find((t) => t !== 'data' && t !== tables[1]);
  if (extra) out.push([`Join with ${extra}`, `SELECT d.*, x.*\nFROM data d\nJOIN ${extra} x USING (${ident(cols[0]?.name ?? 'id')})`]);
  return out;
}

export const SqlPanel = forwardRef<SqlPanelHandle, Props>(function SqlPanel({ meta, history, saved, functions, initialText, onTextChange }, ref) {
  const openMenu = useMenu();
  const [text, setTextState] = useState(initialText || 'SELECT *\nFROM data\nLIMIT 100');
  const [result, setResult] = useState<SqlResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [suggest, setSuggest] = useState<{ items: string[]; index: number; word: string } | null>(null);
  const [layout, setLayoutState] = useState<GridLayout>({ widths: {}, hidden: new Set(), order: [], frozen: 0, wrap: false });
  const area = useRef<HTMLTextAreaElement>(null);

  const setText = (t: string) => {
    setTextState(t);
    onTextChange(t);
  };

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    setText: (t) => {
      setText(t);
      area.current?.focus();
    },
  }));

  const run = async (record = true) => {
    const el = area.current;
    const selected = el && el.selectionEnd > el.selectionStart ? text.slice(el.selectionStart, el.selectionEnd) : '';
    const query = selected.trim() ? selected : text;
    setRunning(true);
    setError(null);
    const m = await request<Extract<HostMessage, { type: 'sqlResult' | 'sqlError' }>>((reqId) => ({ type: 'sql', reqId, query, record }));
    setRunning(false);
    if (m.type === 'sqlError') setError(m.error);
    else {
      setResult(m.result);
      setLayoutState((l) => ({ ...l, order: [], hidden: new Set() }));
    }
  };

  const vocabulary = useMemo(
    () => [...meta.tables, ...meta.columns.map((c) => ident(c.name)), ...functions.map((f) => f.name + '('), ...KEYWORDS],
    [meta.tables, meta.columns, functions],
  );

  const updateSuggest = (value: string, caret: number) => {
    const m = /[A-Za-z_"][\w"]*$/.exec(value.slice(0, caret));
    const word = m?.[0] ?? '';
    if (word.length < 1) return setSuggest(null);
    const lw = word.replace(/"/g, '').toLowerCase();
    const items = [...new Set(vocabulary.filter((v) => v.replace(/"/g, '').toLowerCase().startsWith(lw) && v.replace(/"/g, '').toLowerCase() !== lw))].slice(0, 12);
    setSuggest(items.length ? { items, index: 0, word } : null);
  };

  const accept = (item: string) => {
    const el = area.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret - (suggest?.word.length ?? 0));
    const next = before + item + text.slice(caret);
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length + item.length;
    });
  };

  const insert = (s: string) => {
    const el = area.current;
    if (!el) return setText(text + s);
    const next = text.slice(0, el.selectionStart) + s + text.slice(el.selectionEnd);
    const pos = el.selectionStart + s.length;
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = pos;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void run(true);
      return;
    }
    if (suggest) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggest.items.length;
        setSuggest({ ...suggest, index: (suggest.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(suggest.items[suggest.index]);
        return;
      }
      if (e.key === 'Escape') {
        setSuggest(null);
        return;
      }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      insert('  ');
    }
  };

  const historyMenu = (e: MouseEvent<HTMLElement>) => {
    const item = (q: SavedQuery): MenuItem => ({ label: (q.name ?? q.query).replace(/\s+/g, ' ').slice(0, 80), onClick: () => setText(q.query) });
    const items: MenuItem[] = [];
    if (saved.length) {
      items.push({ section: 'Saved' }, ...saved.map(item));
      items.push({ label: 'Delete a saved query…', onClick: () => openMenu(e.currentTarget, saved.map((q) => ({ label: `Delete “${q.name ?? q.query.slice(0, 40)}”`, danger: true, onClick: () => post({ type: 'deleteQuery', query: q }) }))) });
    }
    if (history.length) items.push({ section: 'Recent' }, ...history.map(item));
    if (!items.length) items.push({ section: 'Run a query with ⌘/Ctrl+Enter to build history' });
    openMenu(e.currentTarget, items);
  };

  const exportMenu = (e: MouseEvent<HTMLElement>) => {
    const ex = (target: 'newTab' | 'save' | 'copy' | 'replace', format: 'csv' | 'json' | 'tsv' | 'markdown' | 'yaml' | 'sql' | 'html' | 'ndjson') =>
      post({ type: 'export', request: { source: 'sql', target, format } });
    openMenu(e.currentTarget, [
      { section: `All ${result?.rowCount.toLocaleString()} rows (re-runs the query)` },
      { label: 'Save as CSV…', onClick: () => ex('save', 'csv') },
      { label: 'Save as JSON / YAML / Markdown…', onClick: () => openMenu(e.currentTarget, [
        { label: 'JSON', onClick: () => ex('save', 'json') },
        { label: 'NDJSON', onClick: () => ex('save', 'ndjson') },
        { label: 'YAML', onClick: () => ex('save', 'yaml') },
        { label: 'Markdown', onClick: () => ex('save', 'markdown') },
        { label: 'HTML', onClick: () => ex('save', 'html') },
        { label: 'SQL INSERTs', onClick: () => ex('save', 'sql') },
      ]) },
      { label: 'Open CSV in new tab', onClick: () => ex('newTab', 'csv') },
      { label: 'Open JSON in new tab', onClick: () => ex('newTab', 'json') },
      { label: 'Copy as TSV (Excel / Sheets)', onClick: () => ex('copy', 'tsv') },
      { label: 'Copy as Markdown table', onClick: () => ex('copy', 'markdown') },
      'separator',
      { label: 'Replace file with result…', danger: true, disabled: meta.readOnly, onClick: () => ex('replace', 'csv') },
    ]);
  };

  const gridData: GridData | null = useMemo(() => {
    if (!result) return null;
    const rows = result.rows.map((r, i) => ({ row: i, cells: r.map((v) => (v === null ? '' : String(v))) }));
    return {
      columns: result.columns.map((name, index) => ({ index, name, invalidCheck: false })),
      count: rows.length,
      version: 0,
      getRow: (i) => rows[i],
      ensure: () => undefined,
    };
  }, [result]);

  return (
    <div className="sql-panel">
      <div className="sql-toolbar">
        <button className="btn primary" onClick={() => void run(true)} disabled={running} title="Run (⌘/Ctrl+Enter). Runs the selection if text is selected.">
          ▶ Run
        </button>
        <button className="btn" onClick={historyMenu} title="Saved and recent queries">
          ⏱
        </button>
        <button className="btn" onClick={() => text.trim() && post({ type: 'saveQuery', query: { query: text } })} title="Save this query">
          ☆
        </button>
        <button className="btn" onClick={(e) => openMenu(e.currentTarget, examples(meta.columns, meta.tables).map(([label, q]) => ({ label, onClick: () => setText(q) })))}>
          Examples ▾
        </button>
        <button className="btn" onClick={(e) => openMenu(e.currentTarget, [{ section: 'Click to insert' }, ...functions.map((f) => ({ label: f.signature, hint: f.description.slice(0, 50), onClick: () => insert(f.name + '(') }))])}>
          ƒ Functions ▾
        </button>
        <button className="btn" onClick={() => post({ type: 'buildQuery' })} title="Turn the current filters and sort into SQL">
          From view
        </button>
        <span className="tables">
          {meta.tables.map((t) => (
            <button key={t} className="chip" onClick={() => insert(t)} title="Insert table name">
              {t}
            </button>
          ))}
          <button className="chip add" onClick={() => post({ type: 'command', command: 'addTable' })} title="Add another CSV as a table for JOINs">
            + table
          </button>
        </span>
        <span className="spacer" />
        <span className={`status${error ? ' error' : ''}`} title={error ?? undefined}>
          {running
            ? 'Running…'
            : error
              ? error.split('\n')[0]
              : result
                ? `${result.rowCount.toLocaleString()} row${result.rowCount === 1 ? '' : 's'}${result.truncated ? ` (showing ${result.rows.length.toLocaleString()})` : ''} · ${result.ms} ms${result.changes ? ` · ${result.changes} changed in memory only` : ''}`
                : 'Tables: data (this file) and its file name'}
        </span>
        {result && (
          <button className="btn" onClick={exportMenu}>
            Save / Export ▾
          </button>
        )}
      </div>
      <div className="sql-editor-wrap">
        <textarea
          ref={area}
          className="sql-editor"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            updateSuggest(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setSuggest(null), 150)}
        />
        {suggest && (
          <div className="suggest">
            {suggest.items.map((s, i) => (
              <div key={s} className={`suggest-item${i === suggest.index ? ' on' : ''}`} onMouseDown={(e) => (e.preventDefault(), accept(s))}>
                {s}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sql-result">
        {gridData ? (
          <Grid data={gridData} layout={layout} setLayout={(l) => setLayoutState((x) => ({ ...x, ...l }))} readOnly onCopy={() => post({ type: 'export', request: { source: 'sql', target: 'copy', format: 'tsv' } })} />
        ) : (
          <div className="empty">{error ? <span className="error-text">{error}</span> : 'Write a query and press ⌘/Ctrl+Enter.'}</div>
        )}
      </div>
    </div>
  );
});
