import { useTranslation } from "react-i18next";
import { localizeUiMessage } from "./messages";

/** Keeps retained transient UI messages current without changing their source data. */
export function LocalizedMessage({ children }: { children: string | null | undefined }) {
  useTranslation();
  return children == null ? null : localizeUiMessage(children);
}
