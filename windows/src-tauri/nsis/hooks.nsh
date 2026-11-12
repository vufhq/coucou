; Uninstall hooks for the NSIS installer.
;
; The inbox and the log live in %LOCALAPPDATA%\Coucou, which the installer never
; recorded, so the default uninstaller would leave them behind. The bin folder is
; where versions before Coucou HQ staged their Claude Code relay; it goes too.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Coucou\bin"
  RMDir /r "$LOCALAPPDATA\Coucou\inbox"
  Delete "$LOCALAPPDATA\Coucou\coucou.log"
!macroend
