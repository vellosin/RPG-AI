param(
  [int]$WaitSec = 120,
  [string]$ComfyRoot = $env:COMFY_ROOT
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ComfyRoot = if ($ComfyRoot) { $ComfyRoot } else { Join-Path $ProjectRoot "vendor\ComfyUI_windows_portable" }
$ComfyBat = Join-Path $ComfyRoot "run_nvidia_gpu.bat"
$ServerEnv = Join-Path $ProjectRoot "apps\server\.env"
$VoiceGm = Join-Path $ProjectRoot "pt_BR-faber-medium.onnx"
$VoiceNpcGruff = Join-Path $ProjectRoot "pt_BR-edresson-low.onnx"

function Env-FlagEnabled {
  param([string]$Path, [string]$Key, [bool]$Fallback = $false)
  $value = Read-EnvValue $Path $Key
  if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }
  return @("1", "true", "yes", "on") -contains $value.ToLower()
}

function Read-EnvValue {
  param([string]$Path, [string]$Key)
  if (!(Test-Path $Path)) { return "" }
  $match = Get-Content $Path | Where-Object { $_ -match ("^\s*{0}\s*=" -f [regex]::Escape($Key)) } | Select-Object -First 1
  if (!$match) { return "" }
  return (($match -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

function Resolve-PiperBinary {
  $candidates = @()
  $userProfile = $env:USERPROFILE
  $envBinary = Read-EnvValue $ServerEnv "TTS_PIPER_BINARY"
  if ($envBinary) { $candidates += $envBinary }

  $pathBinary = Get-Command piper -ErrorAction SilentlyContinue
  if ($pathBinary) { $candidates += $pathBinary.Source }

  $candidates += @(
    (Join-Path $userProfile ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\Scripts\piper.exe"),
    (Join-Path $userProfile "AppData\Roaming\Python\Python312\Scripts\piper.exe"),
    (Join-Path $userProfile "AppData\Roaming\Python\Python311\Scripts\piper.exe"),
    (Join-Path $userProfile "AppData\Local\Programs\Python\Python312\Scripts\piper.exe"),
    (Join-Path $userProfile "AppData\Local\Programs\Python\Python311\Scripts\piper.exe"),
    (Join-Path $userProfile ".local\bin\piper.exe")
  )

  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $envBinary
}

$PiperBinary = Resolve-PiperBinary
$TtsEnabled = Env-FlagEnabled $ServerEnv "TTS_ENABLED" $false

function Test-Http {
  param([string]$Url, [int]$Timeout = 5)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec $Timeout $Url
    return @{ ok = $true; status = [int]$response.StatusCode; content = $response.Content }
  } catch {
    return @{ ok = $false; status = 0; content = $_.Exception.Message }
  }
}

function Wait-ForHttp {
  param([string]$Name, [string]$Url, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $status = Test-Http $Url 5
    if ($status.ok) {
      Write-Host ("[OK] {0} online: {1}" -f $Name, $Url)
      return $true
    }
    Start-Sleep -Seconds 3
  }
  Write-Host ("[FAIL] {0} did not answer in {1}s: {2}" -f $Name, $Seconds, $Url)
  return $false
}

function Assert-File {
  param([string]$Name, [string]$Path)
  if (!(Test-Path $Path)) {
    throw ("{0} not found: {1}. Do not download again automatically; check OPERACAO_RPG.md." -f $Name, $Path)
  }
  Write-Host ("[OK] {0}: {1}" -f $Name, $Path)
}

Write-Host "Starting RPG local stack"
Write-Host ("Project: {0}" -f $ProjectRoot)
Write-Host ""

if ($TtsEnabled) {
  Assert-File "Piper binary" $PiperBinary
  Assert-File "GM voice" $VoiceGm
  Assert-File "NPC gruff voice" $VoiceNpcGruff
} else {
  Write-Host "[OK] TTS disabled in apps/server/.env; skipping Piper checks."
}

Write-Host ""
Write-Host "JanAI is user-managed. Keep it open at http://127.0.0.1:1337/v1 with model gemma-4-E4B-it-IQ4_XS."

$comfyStatus = Test-Http "http://127.0.0.1:8188/system_stats" 5
if ($comfyStatus.ok) {
  Write-Host "[OK] ComfyUI already online."
} else {
  if (Test-Path $ComfyBat) {
    Write-Host "[START] ComfyUI"
    $comfyOut = Join-Path $ProjectRoot "comfy.out.log"
    $comfyErr = Join-Path $ProjectRoot "comfy.err.log"
    Start-Process -FilePath "cmd.exe" -ArgumentList "/d","/s","/c","run_nvidia_gpu.bat > `"$comfyOut`" 2> `"$comfyErr`"" -WorkingDirectory $ComfyRoot -WindowStyle Hidden
    [void](Wait-ForHttp "ComfyUI" "http://127.0.0.1:8188/system_stats" $WaitSec)
  } else {
    Write-Host "[SKIP] ComfyUI offline and run_nvidia_gpu.bat not found. Start ComfyUI manually or set COMFY_ROOT."
  }
}

$serverStatus = Test-Http "http://127.0.0.1:8787/api/integrations" 5
if ($serverStatus.ok) {
  Write-Host "[OK] RPG server already online."
} else {
  Write-Host "[START] RPG server"
  $serverOut = Join-Path $ProjectRoot "dev-server.out.log"
  $serverErr = Join-Path $ProjectRoot "dev-server.err.log"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/d","/s","/c","npm run dev:server > `"$serverOut`" 2> `"$serverErr`"" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
  [void](Wait-ForHttp "RPG server" "http://127.0.0.1:8787/api/integrations" $WaitSec)
}

Write-Host ""
& (Join-Path $ProjectRoot "scripts\check-rpg-stack.ps1")

Write-Host ""
Write-Host "Open the game at http://127.0.0.1:8787/app/"
