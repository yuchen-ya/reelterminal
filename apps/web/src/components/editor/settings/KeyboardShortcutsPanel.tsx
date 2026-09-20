import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftCard as Card } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import {
  keyboardShortcuts,
  formatKeyComboDisplay,
  type ShortcutCategory,
  type ShortcutDefinition,
} from "../../../services/keyboard-shortcuts";

/**
 * Read-only view of the editor keyboard shortcuts for the Settings dialog.
 * Data comes from the same keyboardShortcuts service that powers the
 * KeyboardShortcutsOverlay (the "?" toggle), so both surfaces always list the
 * same bindings. Customization lives in the overlay; this panel exists so the
 * bindings are discoverable by mouse alone.
 */
export const KeyboardShortcutsPanel: React.FC = () => {
  const { t } = useTranslation();

  const groupedShortcuts = useMemo(
    () =>
      keyboardShortcuts
        .getCategories()
        .map((category) => ({
          category,
          shortcuts: keyboardShortcuts.getShortcutsByCategory(category),
        }))
        .filter((group) => group.shortcuts.length > 0),
    [],
  );

  return (
    <div className="space-y-6 pb-4">
      <Text type="supporting" color="secondary" className="text-xs">
        {t("settingsDialog.shortcutsDescription")}
      </Text>
      {groupedShortcuts.map(
        ({ category, shortcuts }: { category: ShortcutCategory; shortcuts: ShortcutDefinition[] }) => (
          <div key={category} className="space-y-2">
            <Text
              as="h3"
              type="supporting"
              weight="bold"
              color="secondary"
              display="block"
              className="text-xs uppercase tracking-wider"
            >
              {t(keyboardShortcuts.getCategoryName(category))}
            </Text>
            <div className="overflow-hidden rounded-lg border border-border">
              {shortcuts.map((shortcut, index) => (
                <Card
                  key={shortcut.id}
                  variant="transparent"
                  padding={2}
                  className={`flex items-center justify-between gap-4 ${
                    index > 0 ? "border-t border-border" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <Text type="body" display="block">
                      {t(shortcut.name)}
                    </Text>
                    <Text
                      type="supporting"
                      color="secondary"
                      display="block"
                      className="text-[11px]"
                    >
                      {t(shortcut.description)}
                    </Text>
                  </div>
                  <Text
                    type="supporting"
                    color="secondary"
                    className="shrink-0 font-mono text-xs"
                  >
                    {formatKeyComboDisplay(shortcut.currentKey)}
                  </Text>
                </Card>
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  );
};
