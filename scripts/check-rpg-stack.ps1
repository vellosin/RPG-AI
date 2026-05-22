param(
  [int]$TimeoutSec = 5,
  [string]$ComfyRoot = $env:COMFY_ROOT
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ComfyRoot = if ($ComfyRoot) { $ComfyRoot } else { Join-Path $ProjectRoot "vendor\ComfyUI_windows_portable" }
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
$CheckpointName = Read-EnvValue $ServerEnv "IMAGE_COMFY_CHECKPOINT"
if ([string]::IsNullOrWhiteSpace($CheckpointName)) {
  $CheckpointName = "first available from ComfyUI"
}
$Checkpoint = if ($CheckpointName -eq "first available from ComfyUI") {
  ""
} else {
  Join-Path $ComfyRoot (Join-Path "ComfyUI\models\checkpoints" $CheckpointName)
}

function Test-Http {
  param([string]$Url, [int]$Timeout = 5)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec $Timeout $Url
    return @{ ok = $true; status = [int]$response.StatusCode; content = $response.Content }
  } catch {
    return @{ ok = $false; status = 0; content = $_.Exception.Message }
  }
}

function Write-Status {
  param([string]$Name, [bool]$Ok, [string]$Details)
  $mark = if ($Ok) { "OK" } else { "FAIL" }
  Write-Host ("[{0}] {1} - {2}" -f $mark, $Name, $Details)
}

Write-Host "RPG stack check"
Write-Host ("Project: {0}" -f $ProjectRoot)
Write-Host ""

if ($TtsEnabled) {
  Write-Status "Piper binary" ($PiperBinary -and (Test-Path $PiperBinary)) ($(if ($PiperBinary) { $PiperBinary } else { "not configured/found" }))
  Write-Status "GM voice" (Test-Path $VoiceGm) $VoiceGm
  Write-Status "NPC gruff voice" (Test-Path $VoiceNpcGruff) $VoiceNpcGruff
} else {
  Write-Status "Piper binary" $true "TTS disabled in apps/server/.env"
  Write-Status "GM voice" $true "TTS disabled in apps/server/.env"
  Write-Status "NPC gruff voice" $true "TTS disabled in apps/server/.env"
}
Write-Status "ComfyUI folder" (Test-Path $ComfyRoot) $ComfyRoot
if ($Checkpoint) {
  Write-Status "ComfyUI checkpoint" (Test-Path $Checkpoint) $Checkpoint
} else {
  Write-Status "ComfyUI checkpoint" $true $CheckpointName
}

$jan = Test-Http "http://127.0.0.1:1337/v1/models" $TimeoutSec
Write-Status "JanAI API" $jan.ok "http://127.0.0.1:1337/v1/models"

$comfy = Test-Http "http://127.0.0.1:8188/system_stats" $TimeoutSec
Write-Status "ComfyUI API" $comfy.ok "http://127.0.0.1:8188/system_stats"

$server = Test-Http "http://127.0.0.1:8787/api/integrations" $TimeoutSec
Write-Status "RPG server" $server.ok "http://127.0.0.1:8787/api/integrations"

if ($server.ok) {
  try {
    $integrations = $server.content | ConvertFrom-Json
    Write-Host ""
    Write-Host "Integration report from RPG server:"
    Write-Status "Jan provider" ([bool]$integrations.jan.ok) ("{0} - {1}" -f $integrations.jan.provider, $integrations.jan.details)
    Write-Status "Image provider" ([bool]$integrations.image.ok) ("{0} - {1}" -f $integrations.image.provider, $integrations.image.details)
    Write-Status "Memory provider" ([bool]$integrations.memory.ok) ("{0} - {1}" -f $integrations.memory.provider, $integrations.memory.details)
    Write-Status "TTS provider" ([bool]$integrations.tts.ok) ("{0} - {1}" -f $integrations.tts.provider, $integrations.tts.details)
  } catch {
    Write-Status "Integration JSON" $false $_.Exception.Message
  }
}

Write-Host ""
Write-Host "Expected no-fallback state:"
Write-Host "- JanAI open manually by user at http://127.0.0.1:1337/v1"
Write-Host "- ComfyUI live at http://127.0.0.1:8188"
if ($TtsEnabled) {
  Write-Host "- Piper binary and .onnx voices found on disk"
} else {
  Write-Host "- TTS optional and currently disabled in apps/server/.env"
}
Write-Host "- Neo4j configured through apps/server/.env and validated by the memory provider"
Write-Host "- LangGraph loaded inside the Node server; no separate process"
