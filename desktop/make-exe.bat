@echo off
REM Builds the Zoia Windows installer.
REM Double-click this file, or run it from a Windows terminal.
REM
REM The installer carries nothing secret: people sign in with an account
REM (ADR 0031). Set ZOIA_SERVER_URL first to have the sign-in screen
REM start with your server's address filled in; it is only a default.
REM
REM Must be run from Windows, NOT WSL: the native audio addon is
REM platform-specific, and a WSL npm install puts Linux binaries in
REM node_modules, which silently breaks application audio.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo === Zoia Windows installer build ===============================
echo.
if not "%ZOIA_SERVER_URL%"=="" echo Server address filled in by default: %ZOIA_SERVER_URL%

:ffmpeg
REM --- ffmpeg (GPU encoding) ---------------------------------------
REM Must be a GnuTLS build. An ffmpeg built against Windows SChannel
REM completes the DTLS handshake and then fails with "no SRTP Protection
REM Profile was chosen", because SChannel has no use_srtp extension, so
REM WHIP cannot work with it at all.
REM
REM Built from source in Docker, from ffmpeg\Dockerfile and the patches
REM beside it, exactly as the release workflow builds it: the stock WHIP
REM muxer refuses every NACK LiveKit sends. See ffmpeg.json.
if not exist "vendor\ffmpeg-gnutls.exe" (
  where docker >nul 2>&1 || (
    echo ffmpeg is missing, and Docker is not installed to build it.
    echo Install Docker Desktop, or copy ffmpeg-gnutls.exe from the "ffmpeg"
    echo artifact of a release workflow run into vendor\.
    goto :failed
  )
  echo Building ffmpeg with GnuTLS, AMF, NVENC and Quick Sync ^(the first build takes a while^)...
  docker build --output "type=local,dest=ffmpeg\out" ffmpeg || goto :failed
  if not exist vendor mkdir vendor
  copy /Y "ffmpeg\out\ffmpeg-gnutls.exe" "vendor\ffmpeg-gnutls.exe" >nul || goto :failed
  rmdir /S /Q "ffmpeg\out"
  echo ffmpeg ready.
)

if not exist node_modules (
  echo node_modules missing, installing first...
  call npm install || goto :failed
)

REM Close any running copy, which would otherwise lock release\win-unpacked
REM and make the build fail at the very last step.
taskkill /IM Zoia.exe /F >nul 2>&1

call npm run pack || goto :failed

echo.
echo === Done ========================================================
dir /b release\*Setup*.exe 2>nul
echo.
echo Full path: %~dp0release
echo Send the installer to whoever needs it.
echo.
pause
exit /b 0

:failed
echo.
echo === BUILD FAILED ================================================
echo Scroll up for the error. Most common causes:
echo   - Run from WSL instead of Windows (wrong native binaries)
echo   - A copy of Zoia.exe still running and locking files
echo.
pause
exit /b 1
