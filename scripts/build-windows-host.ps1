param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $projectRoot 'windows-host'
$outputRoot = Join-Path $sourceRoot 'bin'
$outputPath = Join-Path $outputRoot 'JarvisVoiceHost.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'The built-in 64-bit .NET Framework C# compiler was not found.'
}

$sources = @(
    (Join-Path $sourceRoot 'Input.cs'),
    (Join-Path $sourceRoot 'Audio.cs'),
    (Join-Path $sourceRoot 'Host.cs')
)
foreach ($source in $sources) {
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing Windows host source: $source" }
}

$needsBuild = $Force -or -not (Test-Path -LiteralPath $outputPath)
if (-not $needsBuild) {
    $outputTime = (Get-Item -LiteralPath $outputPath).LastWriteTimeUtc
    $needsBuild = $sources | Where-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $outputTime } | Select-Object -First 1
}

if ($needsBuild) {
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    $arguments = @(
        '/nologo',
        '/target:winexe',
        '/platform:anycpu',
        '/optimize+',
        '/warn:4',
        "/out:$outputPath",
        '/reference:System.dll',
        '/reference:System.Core.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Web.Extensions.dll'
    ) + $sources
    & $compiler $arguments
    if ($LASTEXITCODE -ne 0) { throw "Windows host build failed with exit code $LASTEXITCODE." }
    Write-Output 'Windows host built.'
} else {
    Write-Output 'Windows host up to date.'
}
