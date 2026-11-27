!macro customInit
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=\x27Eclipse.exe\x27\" | Where-Object { $_.ExecutablePath -eq \"$INSTDIR\\Eclipse.exe\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 500
!macroend

!macro customCheckAppRunning
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=\x27Eclipse.exe\x27\" | Where-Object { $_.ExecutablePath -eq \"$INSTDIR\\Eclipse.exe\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 500
!macroend

!macro customUnInstallCheck
  ; Bypass false-positive exit code 2 from older uninstaller
!macroend

!macro customUnInstallCheckCurrentUser
  ; Bypass false-positive exit code 2 from older uninstaller
!macroend
