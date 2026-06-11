@echo off
setlocal

set "ROOT=%~dp0"
set "URL=http://127.0.0.1:8765"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $client = [Net.Sockets.TcpClient]::new(); $client.Connect('127.0.0.1', 8765); $client.Close(); exit 0 } catch { exit 1 }"

if errorlevel 1 (
    if exist "%ROOT%runtime\pythonw.exe" (
        start "" "%ROOT%runtime\pythonw.exe" "%ROOT%run_facturacion.pyw"
    ) else (
        start "Facturacion servidor" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%ROOT%start_facturacion.ps1"
    )
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2"
)

start "" "%URL%"
exit /b 0
