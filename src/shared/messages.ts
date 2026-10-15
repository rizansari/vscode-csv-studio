import type { Dialect } from '../core/csv/dialect';
import type { WriteOptions } from '../core/csv/serialize';
import type { CsvEditOp } from '../core/edit';
import type { ExportFormat } from '../core/export';
import type { ColumnProfile, ValueCount } from '../core/profile';
import type { PreviewRow, TransformInfo, TransformSpec } from '../core/transforms/types';
import type { ColType, DateOrder } from '../core/types';
import type { ViewSpec } from '../core/view';

export interface ColumnMeta {
  name: string;
  type: ColType;
  inferred: ColType;
  confidence: number;
  overridden: boolean;
  dateOrder?: DateOrder;
  /** Computed by a transform for display/SQL; not stored in the file. */
  virtual?: boolean;
}

export interface Meta {
  fileName: string;
  readOnly: boolean;
  /** Why the document is read-only, e.g. large-file mode. */
  readOnlyReason?: string;
  dialect: Dialect;
  hasHeader: boolean;
  columns: ColumnMeta[];
  rowCount: number;
  viewCount: number;
  /** Bumped whenever rows or the view change, so cached row windows can be dropped. */
  viewVersion: number;
  issues: { errors: number; warnings: number; first?: string };
  tables: string[];
  trusted: boolean;
}

export interface RowData {
  /** Row number in the file (data rows, 0-based). */
  row: number;
  cells: string[];
}

export interface SqlResultData {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
  changes?: number;
}

export interface SavedQuery {
  query: string;
  name?: string;
}

export interface UserTransformInfo {
  id: string;
  label: string;
  error?: string;
}

export interface SqlFunctionInfo {
  name: string;
  signature: string;
  description: string;
}

export type ExportSource = 'view' | 'sql' | 'rows';
export type ExportTarget = 'newTab' | 'save' | 'copy' | 'replace';
export type Encoding = 'utf8' | 'utf8bom' | 'utf16le' | 'latin1';

export interface ExportRequest {
  source: ExportSource;
  rows?: number[];
  /** With source "view": only view positions start..end (inclusive), e.g. a selected cell range. */
  viewRange?: [number, number];
  /** Restrict to these display columns (by index); all when omitted. */
  columns?: number[];
  target: ExportTarget;
  format: ExportFormat;
  options?: Partial<WriteOptions> & { encoding?: Encoding; nest?: boolean };
}

export type ToolCommand = 'repair' | 'changeDialect' | 'splitFile' | 'mergeFiles' | 'diffWithFile' | 'convertTo' | 'addTable' | 'setSecret' | 'newTransform' | 'openText';

export type HostMessage =
  | { type: 'meta'; meta: Meta }
  | { type: 'rows'; reqId: number; viewVersion: number; start: number; rows: RowData[] }
  | { type: 'distinct'; reqId: number; col: number; values: ValueCount[]; total: number }
  | { type: 'profile'; reqId: number; col: number; profile: ColumnProfile }
  | { type: 'sqlResult'; reqId: number; result: SqlResultData }
  | { type: 'sqlError'; reqId: number; error: string }
  | { type: 'queries'; history: SavedQuery[]; saved: SavedQuery[] }
  | { type: 'transforms'; presets: TransformInfo[]; user: UserTransformInfo[]; secrets: string[]; sqlFunctions: SqlFunctionInfo[] }
  | { type: 'sqlText'; query: string }
  | { type: 'transformPreview'; reqId: number; rows: PreviewRow[]; errors: number }
  | { type: 'busy'; label: string | null }
  | { type: 'select'; row: number; col: number; viewIndex: number }
  | { type: 'focusSql' };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'getRows'; reqId: number; start: number; count: number }
  | { type: 'setView'; spec: ViewSpec }
  | { type: 'distinct'; reqId: number; col: number }
  | { type: 'profile'; reqId: number; col: number }
  | { type: 'edit'; op: CsvEditOp }
  /** Sort the file permanently in the current view order (only when nothing is filtered out). */
  | { type: 'applySort' }
  /** Empty the cells of a selected range (view positions start..end, inclusive). */
  | { type: 'clearRange'; start: number; end: number; cols: number[] }
  | { type: 'setType'; col: number; colType: ColType | null }
  | { type: 'setDialect'; dialect: Partial<Dialect> }
  | { type: 'sql'; reqId: number; query: string; record: boolean }
  | { type: 'buildQuery' }
  | { type: 'export'; request: ExportRequest }
  | { type: 'transformPreview'; reqId: number; spec: TransformSpec }
  | { type: 'transformApply'; spec: TransformSpec }
  | { type: 'removeVirtual'; name: string }
  | { type: 'command'; command: ToolCommand }
  | { type: 'reveal'; row: number; col: number }
  | { type: 'copy'; text: string; label?: string }
  | { type: 'saveQuery'; query: SavedQuery }
  | { type: 'deleteQuery'; query: SavedQuery }
  | { type: 'error'; message: string };
