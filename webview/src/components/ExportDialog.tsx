import { useState } from 'react';
import type { ExportFormat } from '../../../src/core/export';
import type { Encoding, ExportRequest, ExportTarget, Meta } from '../../../src/shared/messages';
import { post } from '../vscode';

interface Props {
  meta: Meta;
  selectedRows: number[];
  visibleColumns: number[];
  onClose: () => void;
}

const FORMATS: [ExportFormat, string][] = [
  ['csv', 'CSV'],
  ['tsv', 'TSV'],
  ['json', 'JSON'],
  ['ndjson', 'NDJSON'],
  ['yaml', 'YAML'],
  ['markdown', 'Markdown'],
  ['html', 'HTML table'],
  ['sql', 'SQL INSERTs'],
];

/** Save the filtered view (or selected rows) with full control over the CSV dialect and encoding. */
export function ExportDialog({ meta, selectedRows, visibleColumns, onClose }: Props) {
  const [scope, setScope] = useState<'view' | 'rows'>(selectedRows.length ? 'rows' : 'view');
  const [onlyVisibleCols, setOnlyVisibleCols] = useState(visibleColumns.length < meta.columns.length);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [delimiter, setDelimiter] = useState(meta.dialect.delimiter);
  const [quoting, setQuoting] = useState<'minimal' | 'all' | 'nonNumeric'>('minimal');
  const [header, setHeader] = useState(true);
  const [eol, setEol] = useState(meta.dialect.eol);
  const [encoding, setEncoding] = useState<Encoding>(meta.dialect.bom ? 'utf8bom' : 'utf8');
  const [nest, setNest] = useState(false);

  const count = scope === 'rows' ? selectedRows.length : meta.viewCount;
  const isCsv = format === 'csv' || format === 'tsv';

  const go = (target: ExportTarget) => {
    const request: ExportRequest = {
      source: scope,
      rows: scope === 'rows' ? selectedRows : undefined,
      columns: onlyVisibleCols ? visibleColumns : undefined,
      target,
      format,
      options: { delimiter: format === 'tsv' ? '\t' : delimiter, quoting, header, eol, encoding, nest },
    };
    post({ type: 'export', request });
    onClose();
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog export-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Save / export rows</div>
        <div className="form-grid">
          <label>Rows</label>
          <div className="radio-row">
            <label className="check">
              <input type="radio" checked={scope === 'view'} onChange={() => setScope('view')} /> Current view ({meta.viewCount.toLocaleString()}
              {meta.viewCount !== meta.rowCount ? ` of ${meta.rowCount.toLocaleString()}, filtered & sorted` : ''})
            </label>
            <label className={`check${selectedRows.length ? '' : ' disabled'}`}>
              <input type="radio" disabled={!selectedRows.length} checked={scope === 'rows'} onChange={() => setScope('rows')} /> Selected rows ({selectedRows.length})
            </label>
          </div>
          <label>Columns</label>
          <label className="check">
            <input type="checkbox" checked={onlyVisibleCols} onChange={(e) => setOnlyVisibleCols(e.target.checked)} /> Only visible columns, in display order ({visibleColumns.length} of {meta.columns.length})
          </label>
          <label>Format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {FORMATS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          {format === 'csv' && (
            <>
              <label>Delimiter</label>
              <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                <option value=",">Comma ,</option>
                <option value=";">Semicolon ;</option>
                <option value={'\t'}>Tab</option>
                <option value="|">Pipe |</option>
              </select>
            </>
          )}
          {isCsv && (
            <>
              <label>Quoting</label>
              <select value={quoting} onChange={(e) => setQuoting(e.target.value as typeof quoting)}>
                <option value="minimal">Only when needed</option>
                <option value="all">All fields</option>
                <option value="nonNumeric">Non-numeric fields</option>
              </select>
              <label>Header row</label>
              <label className="check">
                <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Include column names
              </label>
              <label>Line endings</label>
              <select value={eol} onChange={(e) => setEol(e.target.value as typeof eol)}>
                <option value={'\n'}>LF (macOS / Linux)</option>
                <option value={'\r\n'}>CRLF (Windows / Excel)</option>
              </select>
            </>
          )}
          {(format === 'json' || format === 'ndjson' || format === 'yaml') && (
            <>
              <label>Nesting</label>
              <label className="check">
                <input type="checkbox" checked={nest} onChange={(e) => setNest(e.target.checked)} /> Turn "a.b" columns into nested objects
              </label>
            </>
          )}
          <label>Encoding</label>
          <select value={encoding} onChange={(e) => setEncoding(e.target.value as Encoding)}>
            <option value="utf8">UTF-8</option>
            <option value="utf8bom">UTF-8 with BOM (Excel-friendly)</option>
            <option value="utf16le">UTF-16 LE</option>
            <option value="latin1">Windows-1252 / Latin-1</option>
          </select>
        </div>
        <div className="dialog-footer">
          <span className="muted">{count.toLocaleString()} rows</span>
          <span className="spacer" />
          <button className="btn" onClick={() => go('copy')}>
            Copy
          </button>
          <button className="btn" onClick={() => go('newTab')}>
            Open in new tab
          </button>
          <button className="btn primary" onClick={() => go('save')}>
            Save as…
          </button>
        </div>
      </div>
    </div>
  );
}
