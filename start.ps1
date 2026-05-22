# Inicia servidor de jogo + Vite em dois terminais separados
$ProjectRoot = $PSScriptRoot
$WebRoot = Join-Path $ProjectRoot "apps\web"
$ServerEntry = Join-Path $ProjectRoot "apps\server\src\index.ts"

Start-Process powershell -ArgumentList "-NoExit", "-Command", "npx tsx '$ServerEntry'"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$WebRoot'; npx vite --port 5173 --force"
Write-Host "Servidores iniciados. Acesse http://localhost:5173/"
