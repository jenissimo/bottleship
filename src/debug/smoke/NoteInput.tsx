import React, { useEffect, useRef, useState } from "react";

interface NoteInputProps {
  value: string;
  onCommit: (note: string) => void;
  /** Called after Enter / Escape so the caller can hand focus back (e.g. to the game). */
  onDone?: () => void;
  className?: string;
  placeholder?: string;
}

/** A note field that commits on blur / Enter instead of on every keystroke, and follows
 *  an outside change (other tab, the other view) only while it is not being edited. */
export function NoteInput({ value, onCommit, onDone, className, placeholder = "Note…" }: NoteInputProps): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);

  const commit = () => {
    if (cancelled.current) { cancelled.current = false; setDraft(value); return; }
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };

  return (
    <input
      className={className}
      value={draft}
      placeholder={placeholder}
      maxLength={500}
      onFocus={() => { editing.current = true; }}
      onBlur={() => { editing.current = false; commit(); }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); onDone?.(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); onDone?.(); }
      }}
    />
  );
}
