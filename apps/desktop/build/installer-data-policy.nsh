!ifndef REELTERMINAL_INSTALLER_DATA_POLICY
!define REELTERMINAL_INSTALLER_DATA_POLICY
!include "LogicLib.nsh"

!macro RT_REQUIRE_SAFE_UPGRADE HIVE
  ReadRegStr $R0 ${HIVE} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $R2 ${HIVE} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
  ${OrIf} $R2 != ""
    ClearErrors
    ReadRegDWORD $R1 ${HIVE} "${INSTALL_REGISTRY_KEY}" DataCleanupPolicyVersion
    ${If} ${Errors}
    ${OrIf} $R1 != 1
      MessageBox MB_OK|MB_ICONSTOP \
        "This existing ReelTerminal installation has an older or unknown data-cleanup policy. Setup stopped before running its uninstaller. Do not uninstall it to bypass this check: that uninstaller may remove shared data-location settings. Keep your installation and data until a supported migration is available." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; No user-data traversal or deletion: cached NSIS RMDir follows nested junctions.
; Keeping everything also avoids enumeration limits and check/delete races.
!macro RT_PRESERVE_DATA MODE NOTICE
  ${If} "${MODE}" == "interactive"
    !insertmacro ${NOTICE}
  ${EndIf}
!macroend
!endif
