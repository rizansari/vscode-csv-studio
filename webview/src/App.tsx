import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { delimiterName } from '../../src/core/csv/dialect';
import type { TransformInfo } from '../../src/core/transforms/types';
import { COL_TYPES, type ColType } from '../../src/core/types';
import { FILTER_LABELS, type Filter, type Sort, type ViewSpec } from '../../src/core/view';
import type { HostMessage, Meta, RowData, SavedQuery, SqlFunctionInfo, ToolCommand, UserTransformInfo } from '../../src/shared/messages';
import { ExportDialog } from './components/ExportDialog';
import { FilterPopover } from './components/FilterPopover';
import { Grid, type CellRef, type GridData, type GridLayout } from './components/Grid';
import { useMenu, type MenuItem } from './components/Menu';
import { ProfilePanel } from './components/ProfilePanel';
import { PromptDialog } from './components/PromptDialog';
import { SqlPanel, type SqlPanelHandle } from './components/SqlPanel';
import { TransformDialog } from './components/TransformDialog';
import { loadState, onHostMessage, post, request, saveState } from './vscode';

const BLOCK = 200;
const persisted = loadState();

export function App() {
  const openMenu = useMenu();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [spec, setSpec] = useState<ViewSpec>({ filters: [], sorts: [], search: null });
  const [search, setSearch] = useState('');
  const [tick, setTick] = useState(0);
  const cache = useRef<{ version: number; rows: Map<number, RowData>; pending: Set<number> }>({ version: -1, rows: new Map(), pending: new Set() });
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [layout, setLayoutState] = useState<GridLayout>({
    widths: persisted.widths ?? {},
    hidden: new Set(persisted.hidden ?? []),
    order: persisted.order ?? [],
    frozen: persisted.frozen ?? 0,
    wrap: persisted.wrap ?? false,
  });
  const [sqlOpen, setSqlOpen] = useState(persisted.sqlOpen ?? false);
  const [sqlHeight, setSqlHeight] = useState(persisted.sqlHeight ?? 320);
  const [profileCol, setProfileCol] = useState<number | null>(null);
  const [transformCol, setTransformCol] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [filterAt, setFilterAt] = useState<{ col: number; rect: DOMRect } | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; initial: string; onOk: (v: string) => void } | null>(null);
  const [queries, setQueries] = useState<{ history: SavedQuery[]; saved: SavedQuery[] }>({ history: [], saved: [] });
  const [transforms, setTransforms] = useState<{ presets: TransformInfo[]; user: UserTransformInfo[]; secrets: string[]; sqlFunctions: SqlFunctionInfo[] }>({ presets: [], user: [], secrets: [], sqlFunctions: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ viewIndex: number; col?: number; n: number } | null>(null);
  const cursor = useRef<{ cell: CellRef; row?: RowData }>({ cell: { viewIndex: 0, col: 0 } });
  const sqlRef = useRef<SqlPanelHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const setLayout = (l: Partial<GridLayout>) =>
    setLayoutState((prev) => {
      const next = { ...prev, ...l };
      saveState({ widths: next.widths, hidden: [...next.hidden], order: next.order, frozen: next.frozen, wrap: next.wrap });
      return next;
    });

  const updateSpec = useCallback((next: ViewSpec) => {
    setSpec(next);
    post({ type: 'setView', spec: next });
  }, []);

  useEffect(() => {
    const off = onHostMessage((m: HostMessage) => {
      switch (m.type) {
        case 'meta':
          setMeta(m.meta);
          setBusy(null);
          break;
        case 'queries':
          setQueries({ history: m.history, saved: m.saved });
          break;
        case 'transforms':
          setTransforms({ presets: m.presets, user: m.user, secrets: m.secrets, sqlFunctions: m.sqlFunctions });
          break;
        case 'busy':
          setBusy(m.label);
          break;
        case 'select':
          if (m.viewIndex >= 0) setScrollTo((s) => ({ viewIndex: m.viewIndex, col: m.col, n: (s?.n ?? 0) + 1 }));
          break;
        case 'focusSql':
          setSqlOpen(true);
          setTimeout(() => sqlRef.current?.focus(), 50);
          break;
        case 'sqlText':
          setSqlOpen(true);
          setTimeout(() => sqlRef.current?.setText(m.query), 50);
          break;
      }
    });
    post({ type: 'ready' });
    return off;
  }, []);

  // Global search is debounced; everything else applies immediately.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((spec.search?.text ?? '') !== search) updateSpec({ ...spec, search: search ? { text: search } : null });
    }, 250);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewVersion = meta?.viewVersion ?? 0;
  if (cache.current.version !== viewVersion) cache.current = { version: viewVersion, rows: new Map(), pending: new Set() };

  const data: GridData | null = useMemo(() => {
    if (!meta) return null;
    return {
      columns: meta.columns.map((c, index) => ({ index, name: c.name, virtual: c.virtual, type: { type: c.type, confidence: c.confidence, dateOrder: c.dateOrder } })),
      count: meta.viewCount,
      version: viewVersion + tick / 1e6,
      getRow: (i) => cache.current.rows.get(i),
      ensure: (start, end) => {
        const c = cache.current;
        for (let b = Math.floor(start / BLOCK) * BLOCK; b < end; b += BLOCK) {
          if (c.pending.has(b) || c.rows.has(b)) continue;
          c.pending.add(b);
          const version = c.version;
          void request<Extract<HostMessage, { type: 'rows' }>>((reqId) => ({ type: 'getRows', reqId, start: b, count: BLOCK })).then((m) => {
            if (cache.current.version !== version || m.viewVersion !== version) return;
            m.rows.forEach((r, i) => cache.current.rows.set(m.start + i, r));
            setTick((t) => t + 1);
          });
        }
      },
    };
  }, [meta, viewVersion, tick]);

  if (!meta || !data) return <div className="empty">Loading…</div>;

  const cols = meta.columns;
  const visibleColumns = (() => {
    const byName = new Map(cols.map((c, i) => [c.name, i]));
    const ordered = layout.order.filter((n) => byName.has(n)).map((n) => byName.get(n)!);
    for (let i = 0; i < cols.length; i++) if (!ordered.includes(i)) ordered.push(i);
    return ordered.filter((i) => !layout.hidden.has(cols[i].name));
  })();

  const filtersFor = (col: number) => spec.filters.filter((f) => f.col === col);
  const setColumnFilters = (col: number, fs: Filter[]) => updateSpec({ ...spec, filters: [...spec.filters.filter((f) => f.col !== col), ...fs] });
  const sortBy = (col: number, additive: boolean) => {
    const existing = spec.sorts.find((s) => s.col === col);
    let sorts: Sort[];
    if (!additive) sorts = !existing ? [{ col, dir: 1 }] : existing.dir === 1 ? [{ col, dir: -1 }] : [];
    else if (!existing) sorts = [...spec.sorts, { col, dir: 1 }];
    else sorts = existing.dir === 1 ? spec.sorts.map((s) => (s.col === col ? { col, dir: -1 as const } : s)) : spec.sorts.filter((s) => s.col !== col);
    updateSpec({ ...spec, sorts });
  };
  const edit = (op: Parameters<typeof post>[0] & { type: 'edit' }) => post(op);
  const command = (c: ToolCommand) => post({ type: 'command', command: c });
  const isVirtual = (col: number) => !!cols[col]?.virtual;

  /** Copies rows (all of them, not just the loaded ones) as TSV via the host. */
  const copyRows = (rowNums: number[]) =>
    post({ type: 'export', request: { source: 'rows', rows: [...rowNums].sort((a, b) => a - b), columns: visibleColumns, target: 'copy', format: 'tsv' } });

  const onCopy = () => {
    if (selectedRows.size) return copyRows([...selectedRows]);
    const { cell, row } = cursor.current;
    if (row) post({ type: 'copy', text: row.cells[cell.col] ?? '', label: 'cell' });
  };

  const askColumnName = (title: string, initial: string, onOk: (v: string) => void) => setPrompt({ title, initial, onOk });

  const headerMenu = (col: number, e: MouseEvent) => {
    const c = cols[col];
    const items: MenuItem[] = [
      { section: `${c.name} · ${c.type}${c.virtual ? ' · virtual' : ''}` },
      { label: 'Sort ascending', onClick: () => updateSpec({ ...spec, sorts: [{ col, dir: 1 }] }) },
      { label: 'Sort descending', onClick: () => updateSpec({ ...spec, sorts: [{ col, dir: -1 }] }) },
      { label: 'Add to sort', hint: 'Shift+click', onClick: () => sortBy(col, true) },
      { label: 'Filter…', onClick: () => setFilterAt({ col, rect: (e.target as HTMLElement).getBoundingClientRect() }) },
      { label: 'Profile column', onClick: () => setProfileCol(col) },
      { label: 'Transform…', hint: 'decrypt, mask, regex…', onClick: () => setTransformCol(col) },
      'separator',
      { label: 'Hide column', onClick: () => setLayout({ hidden: new Set([...layout.hidden, c.name]) }) },
      { label: layout.frozen === visibleColumns.indexOf(col) + 1 ? 'Unfreeze columns' : 'Freeze up to this column', onClick: () => setLayout({ frozen: layout.frozen === visibleColumns.indexOf(col) + 1 ? 0 : visibleColumns.indexOf(col) + 1 }) },
      { label: 'Copy column values', onClick: () => post({ type: 'export', request: { source: 'view', columns: [col], target: 'copy', format: 'csv', options: { header: false } } }) },
    ];
    if (c.virtual) {
      items.push('separator', { label: 'Remove virtual column', danger: true, onClick: () => post({ type: 'removeVirtual', name: c.name }) });
    } else if (!meta.readOnly) {
      items.push(
        'separator',
        { label: 'Rename…', disabled: !meta.hasHeader, onClick: () => askColumnName('Rename column', c.name, (name) => edit({ type: 'edit', op: { kind: 'renameColumn', col, name } })) },
        { label: 'Insert column left…', onClick: () => askColumnName('New column name', 'new_column', (name) => edit({ type: 'edit', op: { kind: 'addColumn', name, at: col } })) },
        { label: 'Insert column right…', onClick: () => askColumnName('New column name', 'new_column', (name) => edit({ type: 'edit', op: { kind: 'addColumn', name, at: col + 1 } })) },
        { label: 'Move left in file', disabled: col === 0, onClick: () => edit({ type: 'edit', op: { kind: 'moveColumn', from: col, to: col - 1 } }) },
        { label: 'Move right in file', disabled: col >= cols.filter((x) => !x.virtual).length - 1, onClick: () => edit({ type: 'edit', op: { kind: 'moveColumn', from: col, to: col + 1 } }) },
        { label: 'Delete column', danger: true, onClick: () => edit({ type: 'edit', op: { kind: 'deleteColumn', col } }) },
      );
    }
    openMenu(e, items);
  };

  const typeMenu = (col: number, anchor: HTMLElement) => {
    const c = cols[col];
    if (c.virtual) return;
    openMenu(anchor, [
      { section: `Type of ${c.name}` },
      { label: `${!c.overridden ? '✓ ' : ''}Auto (detected: ${c.inferred}, ${Math.round(c.confidence * 100)}%)`, onClick: () => post({ type: 'setType', col, colType: null }) },
      ...COL_TYPES.map((t: ColType) => ({ label: `${c.overridden && c.type === t ? '✓ ' : ''}${t}`, onClick: () => post({ type: 'setType', col, colType: t }) })),
    ]);
  };

  const cellMenu = (cell: CellRef, row: RowData, e: MouseEvent) => {
    const rowsForAction = selectedRows.has(row.row) && selectedRows.size > 1 ? [...selectedRows] : [row.row];
    const n = rowsForAction.length;
    const items: MenuItem[] = [];
    if (cell.col >= 0) {
      const v = row.cells[cell.col] ?? '';
      const c = cols[cell.col];
      const numeric = ['integer', 'decimal', 'percent', 'currency', 'date', 'datetime'].includes(c.type);
      items.push(
        { section: `${c.name} · row ${row.row + 1}` },
        { label: 'Copy cell', hint: '⌘C', onClick: () => post({ type: 'copy', text: v, label: 'cell' }) },
        { label: `Filter: ${c.name} = “${v.slice(0, 24)}”`, onClick: () => setColumnFilters(cell.col, [...filtersFor(cell.col), { col: cell.col, op: 'in', values: [v] }]) },
        { label: `Exclude “${v.slice(0, 24)}”`, onClick: () => setColumnFilters(cell.col, [...filtersFor(cell.col), { col: cell.col, op: 'notIn', values: [v] }]) },
      );
      if (numeric && v.trim()) {
        items.push({ label: `Filter: ${c.name} ≥ ${v}`, onClick: () => setColumnFilters(cell.col, [{ col: cell.col, op: 'gte', value: v }]) });
        items.push({ label: `Filter: ${c.name} ≤ ${v}`, onClick: () => setColumnFilters(cell.col, [{ col: cell.col, op: 'lte', value: v }]) });
      }
      items.push({ label: 'Transform column…', onClick: () => setTransformCol(cell.col) }, { label: 'Profile column', onClick: () => setProfileCol(cell.col) });
      if (!meta.readOnly && !isVirtual(cell.col)) items.push({ label: 'Clear cell', hint: 'Del', onClick: () => edit({ type: 'edit', op: { kind: 'setCell', row: row.row, col: cell.col, value: '' } }) });
      items.push({ label: 'Show in text editor', onClick: () => post({ type: 'reveal', row: row.row, col: cell.col }) });
    } else items.push({ section: `Row ${row.row + 1}` });
    items.push('separator', { label: n > 1 ? `Copy ${n} rows (TSV)` : 'Copy row (TSV)', onClick: () => copyRows(rowsForAction) });
    if (!meta.readOnly) {
      const blank = cols.filter((c) => !c.virtual).map(() => '');
      items.push(
        { label: 'Insert row above', onClick: () => edit({ type: 'edit', op: { kind: 'insertRows', at: row.row, rows: [blank] } }) },
        { label: 'Insert row below', onClick: () => edit({ type: 'edit', op: { kind: 'insertRows', at: row.row + 1, rows: [blank] } }) },
        { label: 'Duplicate row', onClick: () => edit({ type: 'edit', op: { kind: 'insertRows', at: row.row + 1, rows: [row.cells.slice(0, blank.length)] } }) },
        {
          label: n > 1 ? `Delete ${n} rows` : 'Delete row',
          danger: true,
          onClick: () => {
            edit({ type: 'edit', op: { kind: 'deleteRows', rows: rowsForAction } });
            setSelectedRows(new Set());
          },
        },
      );
    }
    openMenu(e, items);
  };

  const toolsMenu = (e: MouseEvent<HTMLElement>) =>
    openMenu(e.currentTarget, [
      { section: 'View' },
      { label: `${layout.wrap ? '✓ ' : ''}Wrap long text`, onClick: () => setLayout({ wrap: !layout.wrap }) },
      { label: `Show hidden columns (${layout.hidden.size})`, disabled: !layout.hidden.size, onClick: () => setLayout({ hidden: new Set() }) },
      { label: 'Reset column layout', onClick: () => setLayout({ widths: {}, order: [], hidden: new Set(), frozen: 0 }) },
      { label: 'Show only invalid cells…', onClick: () => openMenu(e.currentTarget, cols.filter((c) => c.type !== 'string').map((c) => ({ label: c.name, hint: c.type, onClick: () => setColumnFilters(cols.indexOf(c), [{ col: cols.indexOf(c), op: 'invalid' }]) }))) },
      { section: 'File' },
      { label: 'Apply current sort to file', disabled: meta.readOnly || !spec.sorts.length, onClick: () => post({ type: 'applySort' }) },
      { label: 'Lint & repair…', disabled: meta.readOnly, onClick: () => command('repair') },
      { label: 'Change delimiter / quoting / line endings…', disabled: meta.readOnly, onClick: () => command('changeDialect') },
      { label: 'Split file…', onClick: () => command('splitFile') },
      { label: 'Merge / append CSV files…', onClick: () => command('mergeFiles') },
      { label: 'Compare with another CSV…', onClick: () => command('diffWithFile') },
      { label: 'Convert to JSON / YAML / Markdown…', onClick: () => command('convertTo') },
      { section: 'Transforms & secrets' },
      { label: 'Set secret (key / password)…', onClick: () => command('setSecret') },
      { label: 'New JavaScript transform…', onClick: () => command('newTransform') },
    ]);

  const dialectMenu = (e: MouseEvent<HTMLElement>) =>
    openMenu(e.currentTarget, [
      { section: 'Read the file as…' },
      ...[',', ';', '\t', '|'].map((d) => ({ label: `${meta.dialect.delimiter === d ? '✓ ' : ''}${delimiterName(d)} separated`, onClick: () => post({ type: 'setDialect', dialect: { delimiter: d } }) })),
      'separator',
      { label: `${meta.hasHeader ? '✓ ' : ''}First row is a header`, onClick: () => post({ type: 'setDialect', dialect: { header: !meta.hasHeader } }) },
      { section: 'This changes how the file is read, not the file itself' },
      { label: 'Rewrite file with another delimiter…', disabled: meta.readOnly, onClick: () => command('changeDialect') },
    ]);

  const filterChips = spec.filters.map((f, i) => {
    const c = cols[f.col];
    const value = f.values ? (f.values.length > 3 ? `${f.values.slice(0, 3).join(', ')} +${f.values.length - 3}` : f.values.map((v) => v || '(empty)').join(', ')) : f.op === 'between' ? `${f.value} – ${f.value2}` : (f.value ?? '');
    return (
      <span key={i} className="chip filter-chip" title="Click to edit">
        <button className="chip-body" onClick={(e) => setFilterAt({ col: f.col, rect: e.currentTarget.getBoundingClientRect() })}>
          <b>{c?.name}</b> {FILTER_LABELS[f.op]} {value}
        </button>
        <button className="chip-x" onClick={() => updateSpec({ ...spec, filters: spec.filters.filter((_, j) => j !== i) })} title="Remove filter">
          ✕
        </button>
      </span>
    );
  });

  const filtered = meta.viewCount !== meta.rowCount;

  return (
    <div className="app">
      <div className="toolbar">
        <span className="count" title={meta.fileName}>
          {filtered ? (
            <>
              <b>{meta.viewCount.toLocaleString()}</b> of {meta.rowCount.toLocaleString()} rows
            </>
          ) : (
            <>
              <b>{meta.rowCount.toLocaleString()}</b> rows
            </>
          )}{' '}
          · {cols.length} cols
          {selectedRows.size > 0 && (
            <button className="link" onClick={() => setSelectedRows(new Set())} title="Clear selection">
              {' '}
              · {selectedRows.size} selected ✕
            </button>
          )}
        </span>
        <button className="chip" onClick={dialectMenu} title="How the file is read">
          {delimiterName(meta.dialect.delimiter)} · {meta.hasHeader ? 'header' : 'no header'} · {meta.dialect.eol === '\r\n' ? 'CRLF' : 'LF'}
          {meta.dialect.bom ? ' · BOM' : ''} ▾
        </button>
        <input ref={searchRef} className="search" placeholder="Search all cells…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} />
        <span className="spacer" />
        <button
          className={`btn${sqlOpen ? ' on' : ''}`}
          onClick={() => {
            setSqlOpen(!sqlOpen);
            saveState({ sqlOpen: !sqlOpen });
          }}
          title="SQL query panel (⌘⌥Q)"
        >
          SQL
        </button>
        <button className="btn" onClick={() => setTransformCol(cursor.current.cell.col >= 0 ? cursor.current.cell.col : 0)} title="Decrypt, mask, reformat… a column">
          Transform
        </button>
        <button className={`btn${profileCol !== null ? ' on' : ''}`} onClick={() => setProfileCol(profileCol === null ? Math.max(0, cursor.current.cell.col) : null)} title="Column statistics">
          Profile
        </button>
        <button className="btn" onClick={toolsMenu}>
          Tools ▾
        </button>
        <button className="btn primary" onClick={() => setExportOpen(true)} title="Save the current view or selected rows">
          Export
        </button>
        <button className="btn" onClick={() => command('openText')} title="Open the text editor beside">
          {'{ }'}
        </button>
      </div>

      {(spec.filters.length > 0 || spec.sorts.length > 0) && (
        <div className="chips-bar">
          {filterChips}
          {spec.sorts.length > 0 && (
            <span className="chip sort-chip">
              Sorted by {spec.sorts.map((s) => `${cols[s.col]?.name} ${s.dir === 1 ? '▲' : '▼'}`).join(', ')}
              <button className="chip-x" onClick={() => updateSpec({ ...spec, sorts: [] })}>
                ✕
              </button>
            </span>
          )}
          <button className="link" onClick={() => updateSpec({ filters: [], sorts: [], search: spec.search })}>
            Clear all
          </button>
        </div>
      )}

      {meta.readOnlyReason && <div className="banner info">{meta.readOnlyReason}</div>}
      {meta.issues.errors > 0 && (
        <div className="banner">
          <span>
            ⚠ {meta.issues.errors} problem{meta.issues.errors === 1 ? '' : 's'} in this file — {meta.issues.first}
          </span>
          <span className="spacer" />
          {!meta.readOnly && (
            <button className="btn small primary" onClick={() => command('repair')}>
              Repair…
            </button>
          )}
        </div>
      )}
      {busy && <div className="banner info">{busy}</div>}

      <div className="body">
        <div className="main">
          <Grid
            data={data}
            layout={layout}
            setLayout={setLayout}
            readOnly={meta.readOnly}
            sorts={spec.sorts}
            filteredCols={new Set(spec.filters.map((f) => f.col))}
            onSort={sortBy}
            onFilter={(col, anchor) => setFilterAt({ col, rect: anchor.getBoundingClientRect() })}
            onHeaderMenu={headerMenu}
            onTypeMenu={typeMenu}
            onCellMenu={cellMenu}
            onEdit={(row, col, value) => edit({ type: 'edit', op: { kind: 'setCell', row, col, value } })}
            onCursor={(cell, row) => {
              cursor.current = { cell, row };
              // Mirrors the cell in a visible text editor (the host ignores this when none is open).
              if (row) post({ type: 'reveal', row: row.row, col: cell.col });
              if (profileCol !== null && cell.col !== profileCol) setProfileCol(cell.col);
            }}
            selectedRows={selectedRows}
            setSelectedRows={setSelectedRows}
            onCopy={onCopy}
            scrollTo={scrollTo}
          />
          {sqlOpen && (
            <>
              <div
                className="splitter"
                onMouseDown={(e) => {
                  const startY = e.clientY;
                  const startH = sqlHeight;
                  const move = (ev: globalThis.MouseEvent) => setSqlHeight(Math.max(140, Math.min(window.innerHeight - 160, startH - (ev.clientY - startY))));
                  const up = (ev: globalThis.MouseEvent) => {
                    window.removeEventListener('mousemove', move);
                    window.removeEventListener('mouseup', up);
                    saveState({ sqlHeight: Math.max(140, Math.min(window.innerHeight - 160, startH - (ev.clientY - startY))) });
                  };
                  window.addEventListener('mousemove', move);
                  window.addEventListener('mouseup', up);
                }}
              />
              <div style={{ height: sqlHeight, display: 'flex', minHeight: 0 }}>
                <SqlPanel
                  ref={sqlRef}
                  meta={meta}
                  history={queries.history}
                  saved={queries.saved}
                  functions={transforms.sqlFunctions}
                  initialText={persisted.sqlText ?? ''}
                  onTextChange={(t) => saveState({ sqlText: t })}
                />
              </div>
            </>
          )}
        </div>
        {profileCol !== null && cols[profileCol] && (
          <ProfilePanel
            col={profileCol}
            column={cols[profileCol]}
            version={viewVersion}
            onClose={() => setProfileCol(null)}
            onFilterValue={(v) => setColumnFilters(profileCol, [{ col: profileCol, op: 'in', values: [v] }])}
            onShowInvalid={() => setColumnFilters(profileCol, [{ col: profileCol, op: 'invalid' }])}
          />
        )}
      </div>

      {filterAt && (
        <FilterPopover
          col={filterAt.col}
          name={cols[filterAt.col].name}
          type={{ type: cols[filterAt.col].type, confidence: cols[filterAt.col].confidence, dateOrder: cols[filterAt.col].dateOrder }}
          anchor={filterAt.rect}
          filters={filtersFor(filterAt.col)}
          onApply={(fs) => {
            setColumnFilters(filterAt.col, fs);
            setFilterAt(null);
          }}
          onClose={() => setFilterAt(null)}
        />
      )}
      {transformCol !== null && (
        <TransformDialog meta={meta} col={transformCol} presets={transforms.presets} user={transforms.user} secrets={transforms.secrets} filtered={filtered} onClose={() => setTransformCol(null)} />
      )}
      {exportOpen && <ExportDialog meta={meta} selectedRows={[...selectedRows].sort((a, b) => a - b)} visibleColumns={visibleColumns} onClose={() => setExportOpen(false)} />}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          initial={prompt.initial}
          onCancel={() => setPrompt(null)}
          onOk={(v) => {
            prompt.onOk(v);
            setPrompt(null);
          }}
        />
      )}
    </div>
  );
}
