; Uninstall hooks for the NSIS installer.
;
; The inbox and the log live in %LOCALAPPDATA%\vufh, which the installer never
; recorded, so the default uninstaller would leave them behind. The bin folder is
; where versions before vufh HQ staged their Claude Code relay; it goes too.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\vufh\bin"
  RMDir /r "$LOCALAPPDATA\vufh\inbox"
  Delete "$LOCALAPPDATA\vufh\vufh.log"
!macroend
