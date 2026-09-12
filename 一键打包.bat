@echo off
rem Fntv-Plus 开发版打包（测试用）：版号 = git commit 数，包名 Fntv-Plus-v<commit数>.fpk（小写 v）。
rem 例：192 个提交 → version=0.0.192 → Fntv-Plus-v192.fpk
rem 正式发布请用「发布打包.bat」（网页 GUI，版号与显示名可控）。
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo  Fntv-Plus 开发版打包（版号=commit 数）
echo ==============================================
echo.
"%~dp0build-fpk.exe" build
echo.
pause
