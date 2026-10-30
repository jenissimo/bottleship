import React, { useEffect, useId, useRef, useState } from "react";
import { LANGUAGE_PRESETS } from "./language-presets";
import s from "./LanguagePicker.module.css";

export function LanguagePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = LANGUAGE_PRESETS.filter((p) => (p.label + " " + p.id).toLowerCase().includes(query.trim().toLowerCase()));
  const label = LANGUAGE_PRESETS.find((p) => p.id === value)?.label ?? "(custom code page)";
  useEffect(() => {
    if (open && matches[active]) document.getElementById(id + "-" + matches[active].id)?.scrollIntoView({ block: "nearest" });
  }, [open, active, query, id]);
  const choose = (id: string) => { onChange(id); setOpen(false); setQuery(""); };

  return <div className={s.picker} ref={root} onBlur={(e) => {
    if (!root.current?.contains(e.relatedTarget as Node | null)) { setOpen(false); setQuery(""); }
  }}>
    <input
      role="combobox" aria-label="Language for non-Unicode programs" aria-expanded={open}
      aria-controls={id} aria-autocomplete="list"
      aria-activedescendant={open && matches[active] ? id + "-" + matches[active].id : undefined}
      value={open ? query : label} placeholder="Search languages…" autoComplete="off"
      onFocus={() => { setOpen(true); setQuery(""); setActive(0); }}
      onClick={() => { if (!open) { setOpen(true); setQuery(""); setActive(0); } }}
      onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(""); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!open) { setOpen(true); setActive(0); }
          else setActive((n) => Math.max(0, Math.min(matches.length - 1, n + (e.key === "ArrowDown" ? 1 : -1))));
        } else if (e.key === "Enter" && open) {
          e.preventDefault();
          if (matches[active]) choose(matches[active].id);
        }
      }}
    />
    {open && <div className={s.popup}>
      <div id={id} role="listbox" aria-label="Languages" className={s.list}>
        {matches.map((p, i) => <div id={id + "-" + p.id} key={p.id} role="option"
          aria-selected={p.id === value} className={i === active ? s.active : undefined}
          onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => choose(p.id)}>
          {p.label}
        </div>)}
      </div>
      {matches.length === 0 && <div className={s.empty} role="status">No languages found</div>}
    </div>}
  </div>;
}
