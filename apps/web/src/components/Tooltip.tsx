"use client";

import React, { useState, useRef, useId } from "react";

type Position = "top" | "bottom" | "left" | "right";

export function Tooltip({
  content,
  children,
  position = "top",
  delay = 200,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  position?: Position;
  delay?: number;
}) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), 80);
  };

  const posClass: Record<Position, string> = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  const arrowClass: Record<Position, string> = {
    top: "left-1/2 -translate-x-1/2 top-full border-t-gray-900 border-l-transparent border-r-transparent border-b-transparent",
    bottom:
      "left-1/2 -translate-x-1/2 bottom-full border-b-gray-900 border-l-transparent border-r-transparent border-t-transparent",
    left: "top-1/2 -translate-y-1/2 left-full border-l-gray-900 border-t-transparent border-b-transparent border-r-transparent",
    right:
      "top-1/2 -translate-y-1/2 right-full border-r-gray-900 border-t-transparent border-b-transparent border-l-transparent",
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span aria-describedby={visible ? id : undefined}>{children}</span>
      <span
        id={id}
        role="tooltip"
        className={
          "pointer-events-none absolute z-50 max-w-xs whitespace-normal rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-normal leading-snug text-white shadow-lg transition-opacity duration-150 " +
          posClass[position] +
          " " +
          (visible ? "opacity-100" : "opacity-0")
        }
      >
        {content}
        <span
          aria-hidden="true"
          className={"absolute h-0 w-0 border-4 " + arrowClass[position]}
        />
      </span>
    </span>
  );
}

export function InfoIcon({
  tooltip,
  position = "top",
  className = "",
}: {
  tooltip: React.ReactNode;
  position?: Position;
  className?: string;
}) {
  return (
    <Tooltip content={tooltip} position={position}>
      <button
        type="button"
        aria-label="More info"
        className={
          "ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold text-gray-500 transition hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary " +
          className
        }
        tabIndex={0}
        onClick={(e) => e.preventDefault()}
      >
        i
      </button>
    </Tooltip>
  );
}

export default Tooltip;
