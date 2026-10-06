<#
 Builds "SIP Phone.exe": one self-contained file for 64-bit Windows 10/11 (no .NET install needed on the PC).
   powershell -ExecutionPolicy Bypass -File build.ps1            build + unit tests -> dist\SIP Phone.exe
   powershell -ExecutionPolicy Bypass -File build.ps1 -SkipTests build only
 Needs the .NET 8 SDK on the build machine (https://dotnet.microsoft.com/download/dotnet/8.0).
#>
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'The .NET 8 SDK is not installed (dotnet not found).' }

if (-not $SkipTests) {
    Write-Host '== Unit tests'
    dotnet test src\SipPhone.Tests\SipPhone.Tests.csproj --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed: not building.' }
}

Write-Host '== Publishing SIP Phone.exe'
if (Test-Path dist) { Remove-Item dist -Recurse -Force }
dotnet publish src\SipPhone\SipPhone.csproj -c Release -r win-x64 --self-contained `
    -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugType=none -o dist --nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }

$exe = Join-Path $PSScriptRoot 'dist\SIP Phone.exe'
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash
Set-Content -Path (Join-Path $PSScriptRoot 'dist\SIP Phone.exe.sha256') -Value "$hash  SIP Phone.exe" -Encoding ASCII
Write-Host ("== Done: {0} ({1:N1} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))
Write-Host "   SHA-256 $hash"
