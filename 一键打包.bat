@echo off
rem Fntv-Plus one-click FPK packer for fnOS testing.
rem Requires: Go 1.23+ (optional, reuses existing binary if absent)
rem           node (optional) / fnpack at tools\fnpack.exe or Downloads
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo  Fntv-Plus one-click FPK packer
echo ==============================================
echo.
"%~dp0build-fpk.exe"
echo.
pause
