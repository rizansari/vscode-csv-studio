/** Transform metadata shared with the webview (no Node imports here). */

export interface ParamSpec {
  name: string;
  label: string;
  type: 'text' | 'secret' | 'select' | 'column' | 'number';
  options?: string[];
  default?: string;
  placeholder?: string;
  /** Show only when another param has one of these values, e.g. { ivSource: ['column'] }. */
  when?: Record<string, string[]>;
  optional?: boolean;
}

export interface TransformInfo {
  id: string;
  label: string;
  group: string;
  description: string;
  params: ParamSpec[];
  /** SQL function name, when the transform can be used in queries. */
  sql?: string;
}

export interface TransformContext {
  /** The whole row, keyed by column name. */
  row: Record<string, string>;
  rowIndex: number;
  /** Secret stored with "CSV Studio: Set Secret…". Throws if missing. */
  secret(name: string): string;
  /** Scratch space that lives for one transform run (e.g. fill down). */
  state: Record<string, unknown>;
}

export interface TransformSpec {
  col: number;
  kind: 'preset' | 'user';
  id: string;
  params: Record<string, string>;
  target: 'inPlace' | 'newColumn' | 'virtual';
  newName?: string;
  /** Only rows visible in the current filtered view. */
  onlyView?: boolean;
}

export interface PreviewRow {
  row: number;
  before: string;
  after: string;
  error?: string;
}
