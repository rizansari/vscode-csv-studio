import { useEffect, useRef, useState } from 'react';

interface Props {
  title: string;
  initial: string;
  onOk: (value: string) => void;
  onCancel: () => void;
}

/** Small modal text prompt (webviews cannot use window.prompt). */
export function PromptDialog({ title, initial, onOk, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const ok = () => value.trim() && onOk(value.trim());
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="dialog prompt-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ok();
            if (e.key === 'Escape') onCancel();
          }}
        />
        <div className="dialog-footer">
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={ok}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
