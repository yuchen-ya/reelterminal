/**
 * Shared naming dialog for "save as preset" flows. Mirrors the text-preset
 * save dialog interaction: autofocus + select, Enter confirms, Escape
 * cancels, the confirm button stays disabled while the name is blank.
 */
import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export const PresetNameDialog: React.FC<{
  readonly title: string;
  readonly placeholder: string;
  readonly confirmLabel: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}> = ({ title, placeholder, confirmLabel, value, onChange, onCancel, onConfirm }) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="fixed inset-0 z-50" onClick={onCancel}>
      <div
        className="absolute left-1/2 top-1/2 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-border bg-bg-1 p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 text-[14px] font-bold text-fg">{title}</div>
        <input
          ref={inputRef}
          value={value}
          aria-label={placeholder}
          placeholder={placeholder}
          maxLength={80}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onConfirm();
            if (event.key === "Escape") onCancel();
          }}
          className="w-full rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[12px] font-medium text-fg-2"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            disabled={!value.trim()}
            onClick={onConfirm}
            className="rounded-[9px] bg-accent px-3 py-2 text-[12px] font-semibold text-bg disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
