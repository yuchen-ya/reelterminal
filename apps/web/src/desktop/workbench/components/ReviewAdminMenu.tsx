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
  contextLoaded?: boolean;
  hasProject: boolean;
  projectName?: string;
  onImportToBoard?: () => void;
  onOpenMigration: () => void;
  onOpenBackup: () => void;
  onOpenRestore: () => void;
  onOpenLegacyProject?: () => void;
  onOpenLegacyMotion?: () => void;
}

export function ReviewAdminMenu({
  contextLoaded = true,
  hasProject,
  projectName = "",
  onImportToBoard,
  onOpenMigration,
  onOpenBackup,
  onOpenRestore,
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
          title={t("review.adminMenu", "管理选项")}
          aria-label={t("review.adminMenu", "管理选项")}
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
            >
              导入文件到画板…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          disabled={!contextLoaded}
          data-testid="review-migration-open"
          onSelect={onOpenMigration}
        >
          {t("review.migration.title")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!contextLoaded}
          data-testid="review-backup-open"
          onSelect={onOpenBackup}
        >
          {t("review.backup.title")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!contextLoaded}
          data-testid="review-restore-open"
          onSelect={onOpenRestore}
        >
          {t("review.restorePackage.title")}
        </DropdownMenuItem>
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
