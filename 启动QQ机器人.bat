@echo off
rem QQ Agent launcher (desktop app, no npm window)
rem NOTE: keep this file ASCII-only. cmd parses .bat in GBK on Chinese
rem Windows; UTF-8 Chinese comments swallow the newline and break parsing.
rem
rem History: this used to be
rem   start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
rem which works on a dev checkout where node_modules\electron holds the runtime,
rem but every packaged build keeps the Electron runtime at the INSTALL ROOT
rem (resources\app\node_modules\electron\dist does not exist). So that line was
rem silently broken for exactly the people who received the installer.
rem
rem The app is a desktop shell around a LOCAL console server, so opening the
rem console URL in the default browser is the honest equivalent and needs no
rem Electron runtime path at all. Prefer the real desktop exe when present.
set "PORT=3210"
set "ROOTEXE=%~dp0..\..\..\QQ Agent.exe"
if exist "%ROOTEXE%" (
  start "" "%ROOTEXE%"
  exit /b 0
)
start "" "http://127.0.0.1:%PORT%/"
