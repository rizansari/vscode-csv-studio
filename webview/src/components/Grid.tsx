import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { matches, type ColType, type ColumnType } from '../../../src/core/types';
import type { Sort } from '../../../src/core/view';
import type { RowData } from '../../../src/shared/messages';
import { InlineEditor } from './InlineEditor';

export interface GridColumn {
  /** Index into each row's `cells`. */
  index: number;
  name: string;
  type?: ColumnType;
  virtual?: boolean;
  invalidCheck?: boolean;
}

export interface GridData {
  columns: GridColumn[];
  count: number;
  /** Changes whenever cached rows become stale. */
  version: number;
  getRow(viewIndex: number): RowData | undefined;
  ensure(start: number, end: number): void;
}

export interface GridLayout {
  widths: Record<string, number>;
  hidden: Set<string>;
  order: string[];
  frozen: number;
  wrap: boolean;
}

export interface CellRef {
  viewIndex: number;
  col: number;
}

interface Props {
  data: GridData;
  layout: GridLayout;
  setLayout: (l: Partial<GridLayout>) => void;
  readOnly: boolean;
  sorts?: Sort[];
  filteredCols?: Set<number>;
  onSort?: (col: number, additive: boolean) => void;
  onFilter?: (col: number, anchor: HTMLElement) => void;
  onHeaderMenu?: (col: number, e: MouseEvent) => void;
  onTypeMenu?: (col: number, anchor: HTMLElement) => void;
  onCellMenu?: (cell: CellRef, row: RowData, e: MouseEvent) => void;
  onEdit?: (row: number, col: number, value: string) => void;
  onCursor?: (cell: CellRef, row: RowData | undefined) => void;
  /** Selected file rows (by row number), for row-level actions. */
  selectedRows?: Set<number>;
  setSelectedRows?: (s: Set<number>) => void;
  onCopy?: () => void;
  scrollTo?: { viewIndex: number; col?: number; n: number } | null;
}

const NUMERIC: ColType[] = ['integer', 'decimal', 'percent', 'currency'];
const INDEX_W = 64;

function defaultWidth(c: GridColumn): number {
  if (c.type && (NUMERIC.includes(c.type.type) || c.type.type === 'boolean')) return Math.max(90, c.name.length * 8 + 50);
  if (c.type?.type === 'date') return 120;
  return Math.min(320, Math.max(120, c.name.length * 8 + 60));
}

export function Grid(p: Props) {
  const { data, layout } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<CellRef>({ viewIndex: 0, col: 0 });
  const [editing, setEditing] = useState<CellRef | null>(null);
  const anchorRow = useRef<number | null>(null);
  const dragCol = useRef<string | null>(null);
  const rowHeight = layout.wrap ? 58 : 26;

  const cols = useMemo(() => {
    const byName = new Map(data.columns.map((c) => [c.name, c]));
    const ordered = layout.order.filter((n) => byName.has(n)).map((n) => byName.get(n)!);
    for (const c of data.columns) if (!layout.order.includes(c.name)) ordered.push(c);
    return ordered.filter((c) => !layout.hidden.has(c.name));
  }, [data.columns, layout.order, layout.hidden]);

  const width = (c: GridColumn) => layout.widths[c.name] ?? defaultWidth(c);
  const template = `${INDEX_W}px ${cols.map((c) => `${width(c)}px`).join(' ')}`;
  const totalWidth = INDEX_W + cols.reduce((s, c) => s + width(c), 0);
  const frozen = Math.min(layout.frozen, cols.length);
  const stickyLeft = (i: number) => INDEX_W + cols.slice(0, i).reduce((s, c) => s + width(c), 0);

  const virtualizer = useVirtualizer({ count: data.count, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 20 });
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (data.count) data.ensure(first, last + 1);
  }, [first, last, data]);

  useEffect(() => {
    if (!p.scrollTo || p.scrollTo.viewIndex < 0) return;
    virtualizer.scrollToIndex(p.scrollTo.viewIndex, { align: 'center' });
    const col = p.scrollTo.col !== undefined ? cols.findIndex((c) => c.index === p.scrollTo!.col) : cursor.col;
    setCursor({ viewIndex: p.scrollTo.viewIndex, col: Math.max(0, col) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.scrollTo?.n]);

  const move = (viewIndex: number, col: number) => {
    const next = { viewIndex: Math.max(0, Math.min(data.count - 1, viewIndex)), col: Math.max(0, Math.min(cols.length - 1, col)) };
    setCursor(next);
    virtualizer.scrollToIndex(next.viewIndex, { align: 'auto' });
    p.onCursor?.({ viewIndex: next.viewIndex, col: cols[next.col]?.index ?? 0 }, data.getRow(next.viewIndex));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (editing || (e.target as HTMLElement).tagName === 'INPUT') return;
    const row = data.getRow(cursor.viewIndex);
    const col = cols[cursor.col];
    switch (e.key) {
      case 'ArrowDown': move(cursor.viewIndex + 1, cursor.col); break;
      case 'ArrowUp': move(cursor.viewIndex - 1, cursor.col); break;
      case 'ArrowRight': move(cursor.viewIndex, cursor.col + 1); break;
      case 'ArrowLeft': move(cursor.viewIndex, cursor.col - 1); break;
      case 'Tab': move(cursor.viewIndex, cursor.col + (e.shiftKey ? -1 : 1)); break;
      case 'PageDown': move(cursor.viewIndex + 25, cursor.col); break;
      case 'PageUp': move(cursor.viewIndex - 25, cursor.col); break;
      case 'Home': move(e.metaKey || e.ctrlKey ? 0 : cursor.viewIndex, 0); break;
      case 'End': move(e.metaKey || e.ctrlKey ? data.count - 1 : cursor.viewIndex, cols.length - 1); break;
      case 'Enter':
      case 'F2':
        if (!p.readOnly && row && col && !col.virtual) setEditing({ viewIndex: cursor.viewIndex, col: cursor.col });
        break;
      case 'Delete':
      case 'Backspace':
        if (!p.readOnly && row && col && !col.virtual && row.cells[col.index]) p.onEdit?.(row.row, col.index, '');
        break;
      case 'c':
        if (e.metaKey || e.ctrlKey) {
          if (window.getSelection()?.toString()) return;
          p.onCopy?.();
        } else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const clickRowNumber = (e: MouseEvent, row: RowData, viewIndex: number) => {
    if (!p.setSelectedRows) return;
    const sel = new Set(e.metaKey || e.ctrlKey ? p.selectedRows : []);
    if (e.shiftKey && anchorRow.current !== null) {
      const [a, b] = [anchorRow.current, viewIndex].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) {
        const r = data.getRow(i);
        if (r) sel.add(r.row);
      }
    } else {
      if (sel.has(row.row)) sel.delete(row.row);
      else sel.add(row.row);
      anchorRow.current = viewIndex;
    }
    p.setSelectedRows(sel);
  };

  const startResize = (e: MouseEvent, c: GridColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(c);
    let latest = startW;
    const moveFn = (ev: globalThis.MouseEvent) => {
      latest = Math.max(50, startW + ev.clientX - startX);
      p.setLayout({ widths: { ...layout.widths, [c.name]: latest } });
    };
    const up = () => {
      window.removeEventListener('mousemove', moveFn);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', moveFn);
    window.addEventListener('mouseup', up);
  };

  const drop = (target: GridColumn) => {
    const from = dragCol.current;
    dragCol.current = null;
    if (!from || from === target.name) return;
    const names = cols.map((c) => c.name);
    names.splice(names.indexOf(from), 1);
    names.splice(names.indexOf(target.name), 0, from);
    p.setLayout({ order: [...names, ...layout.order.filter((n) => !names.includes(n))] });
  };

  const sortInfo = (c: GridColumn) => {
    const i = p.sorts?.findIndex((s) => s.col === c.index) ?? -1;
    return i < 0 ? null : { dir: p.sorts![i].dir, n: p.sorts!.length > 1 ? i + 1 : null };
  };

  const stickyStyle = (i: number) => (i < frozen ? { position: 'sticky' as const, left: stickyLeft(i), zIndex: 1 } : undefined);

  return (
    <div className="grid-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="grid" style={{ width: totalWidth }}>
        <div className="grid-head" style={{ gridTemplateColumns: template }}>
          <div className="th index sticky-index">#</div>
          {cols.map((c, i) => {
            const s = sortInfo(c);
            return (
              <div
                key={c.name}
                className={`th${s ? ' sorted' : ''}${c.virtual ? ' virtual' : ''}${i === frozen - 1 ? ' frozen-edge' : ''}`}
                style={stickyStyle(i)}
                draggable
                onDragStart={() => (dragCol.current = c.name)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  p.onHeaderMenu?.(c.index, e);
                }}
              >
                <div className="th-top">
                  <span
                    className="th-label"
                    title={`${c.name}${c.virtual ? ' (virtual column — not saved in the file)' : ''}\nClick: sort · Shift+click: add to sort · drag: reorder · right-click: more`}
                    onClick={(e) => p.onSort?.(c.index, e.shiftKey)}
                  >
                    {c.virtual && <span className="virtual-mark">ƒ </span>}
                    {c.name}
                  </span>
                  {s && (
                    <span className="sort-arrow">
                      {s.dir === 1 ? '▲' : '▼'}
                      {s.n && <sub>{s.n}</sub>}
                    </span>
                  )}
                  {p.onFilter && (
                    <button className={`icon-btn filter-btn${p.filteredCols?.has(c.index) ? ' active' : ''}`} title="Filter" onClick={(e) => p.onFilter!(c.index, e.currentTarget)}>
                      ⏷
                    </button>
                  )}
                </div>
                {c.type && (
                  <button
                    className={`type-badge t-${c.type.type}`}
                    title={p.onTypeMenu ? `Type: ${c.type.type} (${Math.round(c.type.confidence * 100)}% of values match). Click to change.` : c.type.type}
                    onClick={(e) => p.onTypeMenu?.(c.index, e.currentTarget)}
                  >
                    {c.type.type}
                  </button>
                )}
                <span className="resizer" onMouseDown={(e) => startResize(e, c)} />
              </div>
            );
          })}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((vi) => {
            const row = data.getRow(vi.index);
            const selected = row && p.selectedRows?.has(row.row);
            return (
              <div
                key={vi.index}
                className={`grid-row${vi.index % 2 ? ' odd' : ''}${selected ? ' selected' : ''}${layout.wrap ? ' wrap' : ''}`}
                style={{ gridTemplateColumns: template, transform: `translateY(${vi.start}px)`, height: rowHeight }}
              >
                <div
                  className="td index sticky-index"
                  title="Click to select rows (Shift/Cmd for more). Right-click for row actions."
                  onClick={(e) => row && clickRowNumber(e, row, vi.index)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (row) p.onCellMenu?.({ viewIndex: vi.index, col: -1 }, row, e);
                  }}
                >
                  {row ? row.row + 1 : ''}
                </div>
                {cols.map((c, ci) => {
                  const v = row?.cells[c.index] ?? '';
                  const isCursor = cursor.viewIndex === vi.index && cursor.col === ci;
                  const isEditing = editing?.viewIndex === vi.index && editing.col === ci;
                  const invalid = c.invalidCheck !== false && c.type && v.trim() !== '' && c.type.type !== 'string' && !matches(c.type.type, v, c.type);
                  const numeric = c.type && NUMERIC.includes(c.type.type);
                  return (
                    <div
                      key={c.name}
                      className={`td${numeric ? ' num' : ''}${isCursor ? ' cursor' : ''}${invalid ? ' invalid' : ''}${v === '' ? ' empty' : ''}${frozenEdge(ci, frozen)}`}
                      style={stickyStyle(ci)}
                      title={invalid ? `Not a valid ${c.type!.type}` : v.length > 40 ? v : undefined}
                      onClick={() => move(vi.index, ci)}
                      onDoubleClick={() => !p.readOnly && !c.virtual && row && setEditing({ viewIndex: vi.index, col: ci })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        move(vi.index, ci);
                        if (row) p.onCellMenu?.({ viewIndex: vi.index, col: c.index }, row, e);
                      }}
                    >
                      {isEditing && row ? (
                        <InlineEditor
                          initial={v}
                          onCommit={(t) => {
                            setEditing(null);
                            p.onEdit?.(row.row, c.index, t);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : row ? (
                        v
                      ) : (
                        <span className="loading-cell" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {data.count === 0 && <div className="empty">No rows{p.filteredCols?.size ? ' match the filters' : ''}.</div>}
    </div>
  );
}

function frozenEdge(colIndex: number, frozen: number) {
  return colIndex === frozen - 1 ? ' frozen-edge' : '';
}
