param(
  [string]$Root = $env:USERPROFILE
)

$ErrorActionPreference = "SilentlyContinue"

$candidates = New-Object System.Collections.Generic.List[string]

$pathCommand = Get-Command piper -ErrorAction SilentlyContinue
if ($pathCommand) {
  $candidates.Add($pathCommand.Source)
}

@(
  "$Root\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\Scripts\piper.exe",
  "$Root\AppData\Roaming\Python\Python312\Scripts\piper.exe",
  "$Root\AppData\Roaming\Python\Python311\Scripts\piper.exe",
  "$Root\AppData\Local\Programs\Python\Python312\Scripts\piper.exe",
  "$Root\AppData\Local\Programs\Python\Python311\Scripts\piper.exe",
  "$Root\.local\bin\piper.exe"
) | ForEach-Object {
  if (Test-Path $_) {
    $candidates.Add($_)
  }
}

Get-ChildItem -Path $Root -Recurse -Filter "piper.exe" -ErrorAction SilentlyContinue |
  Select-Object -First 100 -ExpandProperty FullName |
  ForEach-Object { $candidates.Add($_) }

$found = $candidates | Where-Object { $_ } | Select-Object -Unique

if (!$found) {
  Write-Host "Piper binary not found under $Root."
  Write-Host ""
  Write-Host "Reinstall only if this check stays empty:"
  Write-Host "  py -m pip install --user piper-tts"
  Write-Host ""
  Write-Host "Then run again:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\find-piper.ps1"
  exit 1
}

Write-Host "Piper candidates:"
$found | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Use this line in apps/server/.env:"
Write-Host ("TTS_PIPER_BINARY={0}" -f (($found | Select-Object -First 1) -replace "\\", "/"))
