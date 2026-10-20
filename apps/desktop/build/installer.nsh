; Shared data-root preferences belong to the user, not an installation.
!include "${BUILD_RESOURCES_DIR}\installer-data-policy.nsh"

; Older uninstallers contain their own cleanup code. --updated and
; KEEP_APP_DATA cannot fix it. Stop before installSection checks/kills apps.
!macro customInit
  !insertmacro RT_REQUIRE_SAFE_UPGRADE HKCU
  !insertmacro RT_REQUIRE_SAFE_UPGRADE HKLM
!macroend

!macro customInstall
  WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DataCleanupPolicyVersion 1
!macroend

!macro RT_DATA_PRESERVED_NOTICE
  MessageBox MB_OK|MB_ICONINFORMATION \
    "By default, uninstall keeps ReelTerminal user data and shared data-location settings. Automatic cleanup of the configured data root is unavailable; review retained data before any manual cleanup. Exception: the explicit --delete-app-data command-line option separately removes the standard Windows AppData profile folders." /SD IDOK
!macroend

!macro customUnInstall
  Var /GLOBAL rtCleanupMode
  StrCpy $rtCleanupMode "interactive"
  ${If} ${Silent}
    StrCpy $rtCleanupMode "silent"
  ${EndIf}
  ${If} ${isUpdated}
    StrCpy $rtCleanupMode "upgrade"
  ${EndIf}
  !insertmacro RT_PRESERVE_DATA "$rtCleanupMode" RT_DATA_PRESERVED_NOTICE
!macroend
