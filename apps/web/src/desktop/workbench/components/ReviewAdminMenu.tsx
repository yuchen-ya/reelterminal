import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@reelterminal/ui";
import { wbButton } from "../wb-button";

export interface ReviewAdminMenuProps {
  hasProject: boolean;
  projectName?: string;
  onImportToBoard?: () => void;
  onOpenLegacyProject?: () => void;
  onOpenLegacyMotion?: () => void;
}

export function ReviewAdminMenu({
  hasProject,
  projectName = "",
  onImportToBoard,
  onOpenLegacyProject,
  onOpenLegacyMotion,
}: ReviewAdminMenuProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={wbButton.ghost}
          data-testid="review-admin-menu-trigger"
          title={t("review.adminMenu", t("review.adminMenu"))}
          aria-label={t("review.adminMenu", t("review.adminMenu"))}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {onImportToBoard && (
          <>
            <DropdownMenuItem
              data-testid="human-board-menu-import"
              onSelect={onImportToBoard}
            >{t("Import files to the board…")}</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {hasProject && (
          <>
            <DropdownMenuSeparator />
            {onOpenLegacyProject && (
              <DropdownMenuItem
                data-testid="review-legacy-project"
                onSelect={onOpenLegacyProject}
              >
                {t("review.legacyProject", { name: projectName })}
              </DropdownMenuItem>
            )}
            {onOpenLegacyMotion && (
              <DropdownMenuItem onSelect={onOpenLegacyMotion}>
                {t("review.legacyMotion")}
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ReviewAdminMenu;
