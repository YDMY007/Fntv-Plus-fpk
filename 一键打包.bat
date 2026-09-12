@echo off
rem Fntv-Plus 网页 GUI 打包器：启动后自动打开浏览器，在网页上改显示名/版号并点「打包」。
rem 产物: Fntv-Plus-v<版号去点>.fpk，版号每次打包完成自动 +1。
rem 旧的一次性 CLI 打包（不打网页，版号自动+1）: build-fpk.exe build
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo  Fntv-Plus 网页打包器 (http://127.0.0.1:8199)
echo ==============================================
echo.
"%~dp0build-fpk.exe" --serve
echo.
pause
