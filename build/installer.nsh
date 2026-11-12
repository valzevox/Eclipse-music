!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "Eclipse.exe" /T'
  Sleep 500
!macroend
