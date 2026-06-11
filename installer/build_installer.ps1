$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Dist = Join-Path $Root "dist"
$Build = Join-Path $Root "installer\build"
$Payload = Join-Path $Build "payload"
$Runtime = Join-Path $Payload "runtime"
$Bundle = Join-Path $Build "bundle"
$BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python"

if (-not (Test-Path $BundledPython)) {
    throw "No encuentro el runtime de Python incluido en Codex: $BundledPython"
}

if (Test-Path $Build) {
    Remove-Item -LiteralPath $Build -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Payload, $Runtime, $Bundle, $Dist | Out-Null

Copy-Item -LiteralPath (Join-Path $Root "app") -Destination (Join-Path $Payload "app") -Recurse
Copy-Item -LiteralPath (Join-Path $Root "PLANTILLA_FACTURA.docx") -Destination $Payload
Copy-Item -LiteralPath (Join-Path $Root "Facturacion.cmd") -Destination $Payload
Copy-Item -LiteralPath (Join-Path $Root "run_facturacion.pyw") -Destination $Payload
Copy-Item -LiteralPath (Join-Path $Root "README.md") -Destination $Payload

New-Item -ItemType Directory -Force -Path (Join-Path $Payload "data"), (Join-Path $Payload "generated"), (Join-Path $Payload "facturas"), (Join-Path $Payload "backups"), (Join-Path $Payload "assets") | Out-Null

$runtimeFiles = @("python.exe", "pythonw.exe", "python3.dll", "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt")
foreach ($file in $runtimeFiles) {
    $source = Join-Path $BundledPython $file
    if (Test-Path $source) {
        Copy-Item -LiteralPath $source -Destination $Runtime
    }
}
Copy-Item -LiteralPath (Join-Path $BundledPython "DLLs") -Destination (Join-Path $Runtime "DLLs") -Recurse

$libSource = Join-Path $BundledPython "Lib"
$libTarget = Join-Path $Runtime "Lib"
New-Item -ItemType Directory -Force -Path $libTarget | Out-Null
$excludedTopLevelLibDirs = @("site-packages", "__pycache__", "test", "tests", "idlelib", "tkinter", "ensurepip", "venv", "turtledemo", "lib2to3")
Get-ChildItem -LiteralPath $libSource | ForEach-Object {
    if ($_.PSIsContainer -and ($excludedTopLevelLibDirs -contains $_.Name)) {
        return
    }
    Copy-Item -LiteralPath $_.FullName -Destination $libTarget -Recurse
}

Get-ChildItem -LiteralPath $Payload -Recurse -Directory -Force |
    Where-Object { $_.Name -in @("__pycache__", "test", "tests") } |
    Sort-Object FullName -Descending |
    ForEach-Object {
        if ($_.FullName.StartsWith($Payload, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
        }
    }
Get-ChildItem -LiteralPath $Payload -Recurse -File |
    Where-Object { $_.Extension -in @(".pyc", ".pyo") } |
    Remove-Item -Force

$iconPath = Join-Path $Payload "assets\facturacion.ico"
$pythonForIcon = Join-Path $BundledPython "python.exe"
$iconScript = @'
from pathlib import Path
import struct

size = 64
pixels = []
for y in range(size):
    for x in range(size):
        if 10 <= x <= 54 and 8 <= y <= 56:
            r, g, b, a = 17, 100, 102, 255
        else:
            r, g, b, a = 0, 0, 0, 0
        if 18 <= x <= 46 and 16 <= y <= 23:
            r, g, b, a = 255, 255, 255, 255
        if 18 <= x <= 25 and 16 <= y <= 48:
            r, g, b, a = 255, 255, 255, 255
        if 18 <= x <= 42 and 30 <= y <= 37:
            r, g, b, a = 255, 255, 255, 255
        pixels.append((b, g, r, a))

dib = bytearray()
dib += struct.pack("<IIIHHIIIIII", 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0)
for y in range(size - 1, -1, -1):
    for x in range(size):
        dib += bytes(pixels[y * size + x])
mask_stride = ((size + 31) // 32) * 4
dib += bytes(mask_stride * size)
ico = bytearray()
ico += struct.pack("<HHH", 0, 1, 1)
ico += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(dib), 6 + 16)
ico += dib
Path(r"ICON_PATH").write_bytes(ico)
'@.Replace("ICON_PATH", $iconPath.Replace("\", "\\"))
$iconScript | & $pythonForIcon -

$payloadZip = Join-Path $Bundle "payload.zip"
if (Test-Path $payloadZip) {
    Remove-Item -LiteralPath $payloadZip -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($Payload, $payloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$installCmd = Join-Path $Bundle "Install-Facturacion.cmd"
@'
@echo off
setlocal

set "APPDIR=%LOCALAPPDATA%\Programs\Facturacion"
if not exist "%APPDIR%" mkdir "%APPDIR%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%~dp0payload.zip' -DestinationPath '%APPDIR%' -Force"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$desktop=[Environment]::GetFolderPath('Desktop'); $start=[Environment]::GetFolderPath('Programs'); $targets=@((Join-Path $desktop 'Facturacion.lnk'), (Join-Path $start 'Facturacion.lnk')); $shell=New-Object -ComObject WScript.Shell; foreach($path in $targets){ $shortcut=$shell.CreateShortcut($path); $shortcut.TargetPath=(Join-Path $env:LOCALAPPDATA 'Programs\Facturacion\Facturacion.cmd'); $shortcut.WorkingDirectory=(Join-Path $env:LOCALAPPDATA 'Programs\Facturacion'); $shortcut.Description='Abrir Facturacion'; $shortcut.IconLocation=(Join-Path $env:LOCALAPPDATA 'Programs\Facturacion\assets\facturacion.ico'); $shortcut.Save() }"

echo Facturacion instalada correctamente.
exit /b 0
'@ | Set-Content -LiteralPath $installCmd -Encoding ASCII

$targetName = Join-Path $Dist "Facturacion-Setup.exe"
$installerSource = Join-Path $Build "FacturacionInstaller.cs"
@'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

class FacturacionInstaller
{
    static int Main()
    {
        try
        {
            string appDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "Facturacion"
            );
            Directory.CreateDirectory(appDir);

            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string destination = Path.GetFullPath(Path.Combine(appDir, entry.FullName));
                    if (!destination.StartsWith(appDir, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    if (String.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(destination);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    entry.ExtractToFile(destination, true);
                }
            }

            string command = @"
$desktop=[Environment]::GetFolderPath('Desktop');
$start=[Environment]::GetFolderPath('Programs');
$app=Join-Path $env:LOCALAPPDATA 'Programs\Facturacion';
$targets=@((Join-Path $desktop 'Facturacion.lnk'), (Join-Path $start 'Facturacion.lnk'));
$shell=New-Object -ComObject WScript.Shell;
foreach($path in $targets){
  $shortcut=$shell.CreateShortcut($path);
  $shortcut.TargetPath=(Join-Path $app 'Facturacion.cmd');
  $shortcut.WorkingDirectory=$app;
  $shortcut.Description='Abrir Facturacion';
  $shortcut.IconLocation=(Join-Path $app 'assets\facturacion.ico');
  $shortcut.Save();
}";
            ProcessStartInfo info = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command " + Quote(command));
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            using (Process process = Process.Start(info))
            {
                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    throw new Exception("No se pudieron crear los accesos directos.");
                }
            }

            Console.WriteLine("Facturacion instalada correctamente.");
            Console.WriteLine(appDir);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ") + "\"";
    }
}
'@ | Set-Content -LiteralPath $installerSource -Encoding UTF8

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
    throw "No encuentro csc.exe para compilar el instalador."
}

$installerIcon = Join-Path $Payload "assets\facturacion.ico"
& $csc `
    /nologo `
    /target:exe `
    /out:$targetName `
    /win32icon:$installerIcon `
    /resource:$payloadZip,payload.zip `
    /reference:System.IO.Compression.dll `
    /reference:System.IO.Compression.FileSystem.dll `
    $installerSource

if (-not (Test-Path $targetName)) {
    throw "No se genero el instalador: $targetName"
}

Write-Output $targetName
