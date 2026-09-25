$ErrorActionPreference='Stop'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
$Config=Get-Content -LiteralPath (Join-Path $ProjectRoot 'model-config.json') -Raw | ConvertFrom-Json
$AppRecord=Join-Path $ProjectRoot 'logs\app-process.json'
if(Test-Path -LiteralPath $AppRecord){
    $r=Get-Content -LiteralPath $AppRecord -Raw | ConvertFrom-Json
    $p=Get-Process -Id $r.pid -ErrorAction SilentlyContinue
    if($p -and $p.Path -eq $r.executable -and $p.StartTime.ToUniversalTime() -eq ([datetime]$r.started).ToUniversalTime()){Stop-Process -Id $p.Id}
    Remove-Item -LiteralPath $AppRecord
}
$EnginePidPath=Join-Path $ProjectRoot 'logs\engine.pid'
if(Test-Path -LiteralPath $EnginePidPath){
    $p=Get-Process -Id ([int](Get-Content -LiteralPath $EnginePidPath)) -ErrorAction SilentlyContinue
    $allowed=@($Config.runtime,$Config.runtimeCpu,$Config.runtimeVulkan) | ForEach-Object {Join-Path $ProjectRoot ($_ + '\sd-server.exe')}
    if($p -and $allowed -contains $p.Path){Stop-Process -Id $p.Id}
    Remove-Item -LiteralPath $EnginePidPath
}
$EngineRecord=Join-Path $ProjectRoot 'logs\engine-process.json'
if(Test-Path -LiteralPath $EngineRecord){Remove-Item -LiteralPath $EngineRecord}
Write-Host 'Qwen Imagen Studio detenido. Tus imagenes siguen guardadas en outputs.' -ForegroundColor Green
