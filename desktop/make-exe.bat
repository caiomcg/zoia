@echo off
REM Builds the portable Zoia .exe, with the pairing token baked in.
REM Double-click this file, or run it from a Windows terminal.
REM
REM Must be run from Windows, NOT WSL: the native audio addon is
REM platform-specific, and a WSL npm install puts Linux binaries in
REM node_modules, which silently breaks application audio.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo === Zoia portable build =========================================
echo.

REM --- pairing token -----------------------------------------------
REM Without this the .exe builds fine but dead-ends on the pairing
REM screen with "This build has no pairing token embedded."
if "%ZOIA_PAIRING_TOKEN%"=="" (
  if exist ".pairing-token" (
    set /p ZOIA_PAIRING_TOKEN=<.pairing-token
    echo Using saved pairing token from .pairing-token
  )
)

if "%ZOIA_PAIRING_TOKEN%"=="" (
  echo No pairing token found.
  echo.
  echo Mint one on the server with:
  echo     node server/bin/keytool.js pair:new --name "friends" --max-activations 5
  echo.
  set /p ZOIA_PAIRING_TOKEN=Paste the pairing token here: 
  if "!ZOIA_PAIRING_TOKEN!"=="" goto :notoken
  echo !ZOIA_PAIRING_TOKEN!> .pairing-token
  echo Saved to .pairing-token for next time ^(this file is gitignored^).
)

echo Token: %ZOIA_PAIRING_TOKEN:~0,8%... ^(truncated^)
echo.

REM --- ffmpeg (GPU encoding) ---------------------------------------
REM Must be a GnuTLS build. An ffmpeg built against Windows SChannel
REM completes the DTLS handshake and then fails with "no SRTP Protection
REM Profile was chosen", because SChannel has no use_srtp extension, so
REM WHIP cannot work with it at all.
if not exist "vendor\ffmpeg-gnutls.exe" (
  echo Downloading ffmpeg with NVENC + GnuTLS ^(~100MB, one time^)...
  powershell -NoProfile -Command "$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path vendor,vendor\tmp | Out-Null; Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile vendor\tmp\ff.zip -UseBasicParsing; Expand-Archive vendor\tmp\ff.zip vendor\tmp -Force; Copy-Item (Get-ChildItem vendor\tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName vendor\ffmpeg-gnutls.exe -Force; Remove-Item -Recurse -Force vendor\tmp" || goto :failed
  echo ffmpeg ready.
)

if not exist node_modules (
  echo node_modules missing, installing first...
  call npm install || goto :failed
)

REM Close any running copy, which would otherwise lock release\win-unpacked
REM and make the build fail at the very last step.
taskkill /IM Zoia.exe /F >nul 2>&1

call npm run pack:portable || goto :failed

REM --- verify the token actually made it in -------------------------
REM Belt and braces: a build that silently ships without a token is the
REM exact failure this script exists to prevent.
findstr /C:"%ZOIA_PAIRING_TOKEN%" out\main\index.js >nul 2>&1
if errorlevel 1 goto :tokenmissing

echo.
echo === Done ========================================================
echo Pairing token verified as embedded.
echo.
dir /b release\*portable*.exe 2>nul
echo.
echo Full path: %~dp0release
echo Send the portable .exe to whoever needs it. No install required.
echo.
pause
exit /b 0

:notoken
echo.
echo === ABORTED =====================================================
echo No token entered. A build without one cannot pair with anything.
echo.
pause
exit /b 1

:tokenmissing
echo.
echo === BUILD PROBLEM ===============================================
echo The build completed but the pairing token is NOT embedded.
echo The resulting exe would fail to pair. Do not distribute it.
echo.
pause
exit /b 1

:failed
echo.
echo === BUILD FAILED ================================================
echo Scroll up for the error. Most common causes:
echo   - Run from WSL instead of Windows (wrong native binaries)
echo   - A copy of Zoia.exe still running and locking files
echo.
pause
exit /b 1
