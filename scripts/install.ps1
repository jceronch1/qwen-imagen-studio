[CmdletBinding()]
param([ValidateSet('auto','cpu','cuda','vulkan')][string]$Backend='auto', [switch]$NoMerge)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
. (Join-Path $PSScriptRoot 'common.ps1')
New-Item -ItemType Directory -Force -Path models,logs,.downloads,outputs | Out-Null
$Config = Get-Content -LiteralPath 'model-config.json' -Raw | ConvertFrom-Json
function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
# .NET only: works even when Windows PowerShell inherits another module path.
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Hash([string]$Path) {
    $Stream = [IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    try { $Sha = [Security.Cryptography.SHA256]::Create(); ([BitConverter]::ToString($Sha.ComputeHash($Stream)) -replace '-','').ToLowerInvariant() } finally { $Stream.Dispose() }
}
function Unzip([string]$Zip,[string]$Destination) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $Archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Zip).Path)
    try {
        $Root = (Resolve-Path -LiteralPath $Destination).Path
        foreach ($Entry in $Archive.Entries) {
            $Target = [IO.Path]::GetFullPath((Join-Path $Root $Entry.FullName))
            if (!$Target.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { throw "Ruta no valida en $Zip" }
            if ($Entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $Target | Out-Null; continue }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $Target, $true)
        }
    } finally { $Archive.Dispose() }
}
# Resumable download into <file>.part; it only takes its final name after the SHA256 check.
function Download([string]$Url,[string]$Target,[string]$Sha) {
    if (Test-Path -LiteralPath $Target) {
        Write-Host "Verificando $Target..."
        if ((Hash $Target) -eq $Sha) { return }
        Write-Warning "$Target no coincide con el archivo oficial; se descargara de nuevo."
        Remove-Item -LiteralPath $Target
    }
    $Part = $Target + '.part'
    Write-Host "Descargando $Target..."
    & curl.exe --fail --location --retry 8 --retry-all-errors --continue-at - --output $Part $Url
    $Failed = $LASTEXITCODE -ne 0
    # A finished .part left by an interrupted run cannot be resumed further; its hash decides.
    if ($Failed -and !((Test-Path -LiteralPath $Part) -and (Hash $Part) -eq $Sha)) { throw "Descarga interrumpida. Ejecuta el instalador nuevamente para reanudar $Target." }
    if ((Hash $Part) -ne $Sha) { Remove-Item -LiteralPath $Part; throw "El archivo descargado $Target no coincide con el oficial. Ejecuta el instalador nuevamente." }
    Move-Item -LiteralPath $Part -Destination $Target -Force
}
function Runtime([string]$Folder,[string]$Kind,[string]$Sha) {
    $Path = Join-Path $ProjectRoot $Folder
    if (Test-Path -LiteralPath (Join-Path $Path 'sd-server.exe')) { return }
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $Zip = '.downloads\engine-' + $Kind + '-88411ef.zip'
    Download ('https://github.com/leejet/stable-diffusion.cpp/releases/download/master-908-88411ef/sd-master-88411ef-bin-win-' + $Kind + '-x64.zip') $Zip $Sha
    Unzip $Zip $Path
    Remove-Item -LiteralPath $Zip
}

Write-Host 'Instalador de Qwen Imagen Studio' -ForegroundColor Green
$FreeGB = [math]::Round((Get-Item -LiteralPath $ProjectRoot).PSDrive.Free / 1GB, 1)
if ($FreeGB -lt 25) { Write-Warning "Hay $FreeGB GB libres. La instalacion necesita unos 25 GB durante el proceso y ocupa unos 13 GB al terminar." }

Step 'Node.js'
$Node = Get-AppNode $ProjectRoot
if ($Node) { Write-Host "Usando $Node" }
else {
    $NodeVersion = 'v24.21.0'
    $NodeZip = ".downloads\node-$NodeVersion-win-x64.zip"
    Download "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" $NodeZip '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
    $Extract = '.downloads\node-extract'
    if (Test-Path -LiteralPath $Extract) { Remove-Item -LiteralPath $Extract -Recurse -Force }
    Unzip $NodeZip $Extract
    if (Test-Path -LiteralPath 'node') { Remove-Item -LiteralPath 'node' -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $Extract "node-$NodeVersion-win-x64") -Destination 'node'
    Remove-Item -LiteralPath $Extract -Recurse -Force; Remove-Item -LiteralPath $NodeZip
    $Node = Get-AppNode $ProjectRoot
    Write-Host "Node.js portable instalado en node\ ($NodeVersion)"
}

Step 'Microsoft Visual C++ 2015-2022 (necesario para los motores)'
if (Test-VCRuntime) { Write-Host 'Ya instalado.' }
else {
    $Vc = '.downloads\vc_redist.x64.exe'
    & curl.exe --fail --location --retry 5 --output $Vc 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo descargar Visual C++ 2015-2022.' }
    $Signature = Get-AuthenticodeSignature -LiteralPath $Vc
    if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { Remove-Item -LiteralPath $Vc; throw 'El instalador de Visual C++ no tiene una firma valida de Microsoft.' }
    Write-Host 'Windows pedira permiso de administrador para instalar Visual C++.'
    $Process = Start-Process -FilePath $Vc -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru
    Remove-Item -LiteralPath $Vc
    # 1638: a newer version is already installed; 3010: installed, restart pending.
    if ($Process.ExitCode -notin @(0,1638,3010) -or !(Test-VCRuntime)) { throw "No se pudo instalar Visual C++ (codigo $($Process.ExitCode))." }
}

Step 'Motores stable-diffusion.cpp'
Runtime $Config.runtimeCpu 'cpu' 'f7daf2917b54428b39e8e1211a255d82ad8e48ac42658480826c699fc05ead2f'
if ($Backend -in @('auto','vulkan')) { Runtime $Config.runtimeVulkan 'vulkan' 'e9d089361a00bd30b1e23cc39d2a98745536688acbf5e9e68ce2498a548d07e1' }
$HasNvidia = $false
if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) { $GpuNames = & nvidia-smi.exe --query-gpu=name --format=csv,noheader 2>$null; $HasNvidia = $LASTEXITCODE -eq 0 -and !!$GpuNames }
if ($Backend -eq 'cuda' -or ($Backend -eq 'auto' -and $HasNvidia)) {
    Runtime $Config.runtime 'cuda12' 'f55f8a2c1c873895f7466928fa7da82a5bb39de789af7d7755a65a9799dfccdb'
    $RuntimePath = Join-Path $ProjectRoot $Config.runtime
    if (!(Test-Path -LiteralPath (Join-Path $RuntimePath 'cublas64_12.dll'))) {
        Download 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-908-88411ef/cudart-sd-bin-win-cu12-x64.zip' '.downloads\cuda.zip' 'fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d'
        Unzip '.downloads\cuda.zip' $RuntimePath
        Remove-Item -LiteralPath '.downloads\cuda.zip'
    }
}

Step 'Modelos: codificador de texto, lector de referencias y VAE'
Download 'https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3VL-8B-Instruct-Q4_K_M.gguf' 'models\Qwen3VL-8B-Instruct-Q4_K_M.gguf' '67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2'
Download 'https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-8B-Instruct-F16.gguf' 'models\mmproj-Qwen3VL-8B-Instruct-F16.gguf' 'ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38'
Download 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors' 'models\qwen_image_2.1_vae_bf16.safetensors' 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9'

Step 'Modelo de imagen optimizado (Qwen-Image 2.1 + LoRA Viggle Turbo fusionado)'
# The LoRA is fused once over the official Q8_0 base and stored as Q4_K. Both sources are temporary.
& $Node (Join-Path $PSScriptRoot 'merge-lora.mjs') --verify
$Merged = $LASTEXITCODE -eq 0
$LoraUrl = 'https://huggingface.co/' + $Config.source + '/resolve/' + $Config.revision + '/' + $Config.lora
$DownloadedLora = Join-Path '.downloads' $Config.lora
if (!$Merged -and !$NoMerge) {
    Write-Host 'Descarga unica de 9 GB y varios minutos de calculo en CPU (unos 8 min con 16 hilos).'
    $Precise = Join-Path '.downloads' $Config.preciseBase
    try {
        Download $LoraUrl $DownloadedLora $Config.loraSha256
        Download ('https://huggingface.co/' + $Config.baseSource + '/resolve/' + $Config.baseRevision + '/' + $Config.preciseBase) $Precise $Config.preciseBaseSha256
        & $Node (Join-Path $PSScriptRoot 'merge-lora.mjs') $Precise
        if ($LASTEXITCODE -ne 0) { throw 'La fusion del LoRA no termino.' }
        $Merged = $true
        Remove-Item -LiteralPath $Precise, $DownloadedLora
    } catch {
        Write-Warning ('No se creo el modelo optimizado: ' + $_.Exception.Message + ' Se instalara el modo compatible (LoRA aplicado durante la generacion, mas lento).')
    }
}
if (!$Merged) {
    # Compatible mode: base Q4_K + LoRA converted to the sd.cpp layout and applied at runtime.
    New-Item -ItemType Directory -Force -Path 'models\loras' | Out-Null
    Download ('https://huggingface.co/' + $Config.baseSource + '/resolve/' + $Config.baseRevision + '/qwen_image_2.1-Q4_K.gguf') ('models\' + $Config.base) $Config.baseSha256
    $Lora = Join-Path 'models\loras' $Config.lora
    if ((Test-Path -LiteralPath $DownloadedLora) -and !(Test-Path -LiteralPath $Lora)) { Move-Item -LiteralPath $DownloadedLora -Destination $Lora }
    Download $LoraUrl $Lora $Config.loraSha256
    & $Node (Join-Path $PSScriptRoot 'prepare-lora.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el LoRA para el motor local.' }
}

Write-Host ''
Write-Host ('Instalacion completa' + $(if ($Merged) { ' con el modelo optimizado.' } else { ' en modo compatible. Ejecuta de nuevo el instalador para crear el modelo optimizado.' })) -ForegroundColor Green
Write-Host 'Ejecuta "Iniciar Qwen Imagen Studio.cmd" para abrir el estudio.' -ForegroundColor Green
