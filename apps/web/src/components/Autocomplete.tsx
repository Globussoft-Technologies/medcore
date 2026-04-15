"use client";

import React, { useState, useEffect, useRef, useId } from "react";

export function Autocomplete<T>({
  value,
  onChange,
  fetchOptions,
  renderOption,
  getOptionLabel,
  placeholder,
  debounce = 300,
  minChars = 1,
  className = "",
  inputClassName = "",
  disabled,
  required,
  id: idProp,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (val: string, item?: T) => void;
  fetchOptions: (q: string) => Promise<T[]>;
  renderOption: (item: T) => React.ReactNode;
  getOptionLabel?: (item: T) => string;
  placeholder?: string;
  debounce?: number;
  minChars?: number;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const id = idProp || reactId;

  // Debounced fetch when value changes
  useEffect(() => {
    if (!open) return;
    if (value.length < minChars) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetchOptions(value);
        if (!cancelled) {
          setOptions(res);
          setHighlight(0);
        }
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, debounce);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open]);

  // Click outside to close
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const select = (item: T) => {
    const label = getOptionLabel ? getOptionLabel(item) : String(item);
    onChange(label, item);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown") {
        setOpen(true);
        return;
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (options[highlight]) {
        e.preventDefault();
        select(options[highlight]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={"relative " + className} ref={containerRef}>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        role="combobox"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={
          "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 " +
          inputClassName
        }
      />
      {open && (loading || options.length > 0 || value.length >= minChars) && (
        <ul
          id={`${id}-listbox`}
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {loading && (
            <li className="px-3 py-2 text-xs text-gray-500">Searching...</li>
          )}
          {!loading && options.length === 0 && value.length >= minChars && (
            <li className="px-3 py-2 text-xs text-gray-500">No matches</li>
          )}
          {!loading &&
            options.map((opt, i) => (
              <li
                key={i}
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(opt);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={
                  "cursor-pointer px-3 py-2 text-sm " +
                  (i === highlight
                    ? "bg-primary/10 text-primary"
                    : "text-gray-700 dark:text-gray-200")
                }
              >
                {renderOption(opt)}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

export default Autocomplete;
