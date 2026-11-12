!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "Eclipse.exe" /T'
  Sleep 500
!macroend

!macro customCheckAppRunning
  nsExec::ExecToLog 'taskkill /F /IM "Eclipse.exe" /T'
  Sleep 500
!macroend

!macro customUnInstallCheck
  ; Bypass false-positive exit code 2 from older uninstaller
!macroend

!macro customUnInstallCheckCurrentUser
  ; Bypass false-positive exit code 2 from older uninstaller
!macroend
