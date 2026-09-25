# Shared by install.ps1 and start.ps1 (Windows PowerShell 5.1 compatible).

# Portable Node.js downloaded by the installer, or a system Node.js 22+.
function Get-AppNode([string]$Root) {
    $Portable = Join-Path $Root 'node\node.exe'
    if (Test-Path -LiteralPath $Portable) { return $Portable }
    $Command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Command) {
        $Version = & $Command.Source --version 2>$null
        if ($Version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return $Command.Source }
    }
    return $null
}

# The sd.cpp engines are built with MSVC and need the Visual C++ 2015-2022 x64 runtime (includes OpenMP).
function Test-VCRuntime {
    foreach ($Dll in 'msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll','vcomp140.dll') {
        if (!(Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32\$Dll"))) { return $false }
    }
    return $true
}
