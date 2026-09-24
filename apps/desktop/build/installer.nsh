; ReelTerminal NSIS customizations (docs/DATA-ROOT.md).
;
; Uninstall never deletes user data by default (electron-builder's
; deleteAppDataOnUninstall stays off). This script adds LAYERED prompts so a
; user who wants data gone can say so per layer: projects + app data (the
; material library, project database, media bytes, settings), the Agent
; workspace (generated jobs — often the largest leftover), and caches/logs.
;
; The data root is read from uninstall-info.ini in the machine config dir
; (written by the app on every launch and on every root change). Without it
; the uninstaller only offers the default root under the user's Videos folder.

!macro customUnInstall
  ReadEnvStr $R0 "LOCALAPPDATA"
  ${if} $R0 == ""
    StrCpy $R0 "$PROFILE\AppData\Local"
  ${endif}
  StrCpy $R1 "$R0\ReelTerminal\uninstall-info.ini"
  ReadINIStr $R2 $R1 "DataRoot" "path"
  ${if} $R2 == ""
    StrCpy $R2 "$PROFILE\Videos\ReelTerminal"
  ${endif}

  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete ReelTerminal's projects and app data (project database, media cache, material library, settings)?$\n$\n$R2\app-data$\n$R2\projects$\n$\nChoose NO to keep everything and remove only the program." IDYES 0 IDNO uninstall_ask_workspace
  RMDir /r "$R2\app-data"
  RMDir /r "$R2\projects"

uninstall_ask_workspace:
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the ReelTerminal Agent workspace (generated jobs and deliverables)?$\n$\n$R2\agent-workspace$\n$\nThis can contain large generated files you may still want." IDYES 0 IDNO uninstall_ask_caches
  RMDir /r "$R2\agent-workspace"

uninstall_ask_caches:
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete ReelTerminal caches and logs?$\n$\n$R2\logs$\n$\nChoose NO to keep them." IDYES 0 IDNO uninstall_cleanup_root
  RMDir /r "$R2\logs"

uninstall_cleanup_root:
  ; Remove the data root when every layer is gone; otherwise keep it.
  RMDir "$R2"
  ; The machine config dir only ever holds the root pointer + this info file.
  RMDir /r "$R0\ReelTerminal"
!macroend
