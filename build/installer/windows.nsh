; electron-builder keeps user data by default.  This explicit choice is made
; only in the interactive uninstaller; upgrading or repairing never deletes it.
!macro customUnInstall
  MessageBox MB_ICONQUESTION|MB_YESNO "Remove WiiUltraConnect settings and local session history as well?\r\n\r\nChoose No to preserve them for a later reinstall." IDNO keepUserData
  RMDir /r "$APPDATA\WiiUltraConnect"
  keepUserData:
!macroend
