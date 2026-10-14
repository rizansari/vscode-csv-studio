import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | { label: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean }
  | { section: string }
  | 'separator';

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

type OpenMenu = (at: { clientX: number; clientY: number } | HTMLElement, items: MenuItem[]) => void;

const MenuContext = createContext<OpenMenu>(() => undefined);

export const useMenu = () => useContext(MenuContext);

export function MenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const open = useCallback<OpenMenu>((at, items) => {
    if (at instanceof HTMLElement) {
      const r = at.getBoundingClientRect();
      setMenu({ x: r.left, y: r.bottom + 2, items });
    } else setMenu({ x: at.clientX, y: at.clientY, items });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4));
    const y = r.bottom > window.innerHeight ? Math.max(4, menu.y - r.height - 4) : menu.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [menu]);

  return (
    <MenuContext.Provider value={open}>
      {children}
      {menu && (
        <div className="menu" ref={ref} style={{ left: menu.x, top: menu.y }} role="menu">
          {menu.items.map((item, i) =>
            item === 'separator' ? (
              <div key={i} className="menu-sep" />
            ) : 'section' in item ? (
              <div key={i} className="menu-section">
                {item.section}
              </div>
            ) : (
              <button
                key={i}
                role="menuitem"
                className={`menu-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  setMenu(null);
                  item.onClick();
                }}
              >
                <span>{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </MenuContext.Provider>
  );
}
