@echo off
rem Fntv-Plus 开发测试版打包：版号 = 0.9.<git commit 数>，包名 Fntv-Plus-v<commit数>.fpk（小写 v）。
rem 例：192 个提交 → version=0.9.192 → Fntv-Plus-v192.fpk。
rem ⚠ 0.9.x 永远低于正式版(1.0.0 起)——正式版上架可直接覆盖安装；commit 数递增保证测试包互相覆盖。
rem ⚠ 若 NAS 上装过 1.4.6 等旧测试包(高于 0.9.x)，需先卸载一次再装本包(仅此一次)。
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
