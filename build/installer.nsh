!macro customInit
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-Process -Name Eclipse -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $\"$INSTDIR\Eclipse.exe$\" } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Sleep 500
!macroend

!macro customCheckAppRunning
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-Process -Name Eclipse -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $\"$INSTDIR\Eclipse.exe$\" } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Sleep 500
!macroend

!macro customUnInstallCheck
  ; Bypass false-positive exit code 2 from older uninstaller
!macroend

!macro customUnInstallCheckCurrentUser
  ; Bypass false-positive exit code 2 from older uninstaller
!macroend
