import { useEffect, useRef, useState } from 'react';

interface Props {
  initial: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
  className?: string;
}

/** Single-line editor: Enter commits, Escape cancels, blur commits. */
export function InlineEditor({ initial, onCommit, onCancel, className }: Props) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && text !== initial) onCommit(text);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      className={`inline-editor ${className ?? ''}`}
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

interface DialogProps {
  title: string;
  initial: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
  validate?: (text: string) => string | null;
}

/** Modal textarea for editing larger values as JSON. Ctrl/Cmd+Enter saves. */
export function EditDialog({ title, initial, onCommit, onCancel, validate }: DialogProps) {
  const [text, setText] = useState(initial);
  const error = validate?.(text) ?? null;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <textarea
          ref={ref}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !error) onCommit(text);
          }}
        />
        <div className="dialog-footer">
          <span className="dialog-error">{error}</span>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!error} onClick={() => onCommit(text)}>
            Save <kbd>⌘↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
