@echo off
REM Builds the portable Zoia .exe.
REM Double-click this file, or run it from a Windows terminal.
REM
REM   make-exe.bat             private build: the token is baked in, so the
REM                            person you send it to configures nothing
REM   make-exe.bat --public    tokenless build: the .exe knows no server and
REM                            no token, and reads a zoia-invite.json at
REM                            runtime. This is what a GitHub release is.
REM
REM Must be run from Windows, NOT WSL: the native audio addon is
REM platform-specific, and a WSL npm install puts Linux binaries in
REM node_modules, which silently breaks application audio.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo === Zoia portable build =========================================
echo.

REM --- mode ---------------------------------------------------------
REM Two kinds of build now exist, and conflating them is how a token ends
REM up inside a binary published on the internet.
set "MODE=private"
if /I "%~1"=="--public" set "MODE=public"

if "%MODE%"=="public" (
  echo Building a PUBLIC, tokenless exe.
  echo It carries no server URL and no pairing token; it pairs from a
  echo zoia-invite.json handed over separately.
  echo.
  set "ZOIA_PAIRING_TOKEN="
  set "ZOIA_SERVER_URL="
  set "ZOIA_TOKENLESS_BUILD=1"
  goto :ffmpeg
)

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
  set /p ZOIA_PAIRING_TOKEN=Paste the token, or press Enter for a tokenless build: 
  if "!ZOIA_PAIRING_TOKEN!"=="" (
    echo.
    echo No token entered - building tokenless. The exe will need a
    echo zoia-invite.json beside it, or dropped on the pairing screen.
    echo.
    set "MODE=public"
    set "ZOIA_TOKENLESS_BUILD=1"
    goto :ffmpeg
  )
  echo !ZOIA_PAIRING_TOKEN!> .pairing-token
  echo Saved to .pairing-token for next time ^(this file is gitignored^).
)

echo Token: %ZOIA_PAIRING_TOKEN:~0,8%... ^(truncated^)
echo.

:ffmpeg
REM --- ffmpeg (GPU encoding) ---------------------------------------
REM Must be a GnuTLS build. An ffmpeg built against Windows SChannel
REM completes the DTLS handshake and then fails with "no SRTP Protection
REM Profile was chosen", because SChannel has no use_srtp extension, so
REM WHIP cannot work with it at all.
REM
REM The version and URL live in ffmpeg.json so this and the release
REM workflow fetch the same build. The old URL was a rolling "latest"
REM pointer, so two builds weeks apart shipped different encoders with
REM no record of which.
if not exist "vendor\ffmpeg-gnutls.exe" (
  echo Downloading ffmpeg with NVENC + GnuTLS ^(~100MB, one time^)...
  powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $pin = Get-Content ffmpeg.json | ConvertFrom-Json; New-Item -ItemType Directory -Force -Path vendor,vendor\tmp | Out-Null; Invoke-WebRequest -Uri $pin.url -OutFile vendor\tmp\ff.zip -UseBasicParsing; Expand-Archive vendor\tmp\ff.zip vendor\tmp -Force; Copy-Item (Get-ChildItem vendor\tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName vendor\ffmpeg-gnutls.exe -Force; Remove-Item -Recurse -Force vendor\tmp" || goto :failed
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

REM --- verify what did, or did not, make it in ----------------------
REM Both directions matter, and the second matters more now. Shipping a
REM private build without its token is inconvenient. Publishing a public
REM build WITH one puts a credential on the internet, which cannot be
REM taken back - only revoked.
if "%MODE%"=="public" (
  if exist ".pairing-token" (
    set /p LEAKCHECK=<.pairing-token
    findstr /C:"!LEAKCHECK!" out\main\index.js >nul 2>&1
    if not errorlevel 1 goto :tokenleaked
  )
) else (
  findstr /C:"%ZOIA_PAIRING_TOKEN%" out\main\index.js >nul 2>&1
  if errorlevel 1 goto :tokenmissing
)

echo.
echo === Done ========================================================
if "%MODE%"=="public" (
  echo Tokenless build confirmed: no pairing token in the bundle.
  echo Send an invite separately. Mint one on the server with:
  echo     node server/bin/keytool.js pair:new --name "friends" --invite zoia-invite.json
) else (
  echo Pairing token verified as embedded.
)
echo.
dir /b release\*portable*.exe 2>nul
echo.
echo Full path: %~dp0release
echo Send the portable .exe to whoever needs it. No install required.
echo.
pause
exit /b 0

:tokenleaked
echo.
echo === DO NOT DISTRIBUTE ===========================================
echo A --public build came out with a pairing token inside it.
echo That exe is a credential. Delete release\ and build again in a
echo clean shell; a stale ZOIA_PAIRING_TOKEN in the environment is the
echo usual cause.
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
