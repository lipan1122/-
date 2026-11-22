@echo off
chcp 65001 >nul
title PMS 酒店管理系统 - 服务端
cd /d "%~dp0"

rem 本地/内网演示模式：允许 HTTP（否则 Secure Cookie 会被浏览器拒收）、显示演示账号。
rem 公网部署不要设这两项，并改用 DEPLOY.md 的流程（配 SESSION_SECRET + 换初始口令）。
set PMS_ALLOW_HTTP=1
set PMS_SHOW_DEMO_HINT=1
rem 本地不配 SESSION_SECRET：会话用进程随机密钥，重启服务会掉线属正常现象。

echo ============================================
echo   PMS 酒店管理系统
echo ============================================
echo.

echo [1/3] 检查端口 3100 是否被占用...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3100" ^| findstr "LISTENING"') do (
    echo     发现占用进程 PID=%%a，正在停止...
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 >nul

echo [2/3] 启动服务...
if not exist ".next\BUILD_ID" (
    echo     首次运行，正在构建（约 1 分钟）...
    call npm run build
    if errorlevel 1 (
        echo     构建失败，请检查 Node.js 是否已安装
        pause
        exit /b 1
    )
)

echo [3/3] 监听 0.0.0.0:3100
echo.
echo ============================================
echo   本机访问:   http://localhost:3100
echo   局域网访问: http://你的IP:3100
echo ============================================
echo.
echo   账号 / 密码：
echo     admin       / admin123    管理员
echo     front       / 123456      前台
echo     cashier     / 123456      收银
echo     housekeeper / 123456      客房
echo    注意: 仅本地演示口令，公网部署前请执行 npm run reset:passwords
echo.
echo   按 Ctrl+C 停止服务
echo ============================================
echo.

set TEMP=%~dp0.tmp
set TMP=%~dp0.tmp
call node node_modules\next\dist\bin\next start -p 3100 -H 0.0.0.0
pause
