@echo off
REM Automated setup script for Cohere Proxy Server (Windows) with port selection

echo == Cohere Proxy Server Automated Setup ==

REM Check for Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Node.js is not installed. Please install Node.js 16+ and rerun this script.
    exit /b 1
)

REM Install dependencies
echo Installing dependencies...
npm install

REM Check for .env file
if not exist .env (
    echo No .env file found. Creating a template .env file.
    echo COHERE_API_KEY=your_cohere_api_key_here> .env
    echo PORT=3000>> .env
    echo ALLOWED_ORIGINS=http://localhost:3000>> .env
    echo Please edit the .env file to add your Cohere API key.
)

REM Automated port selection
setlocal enabledelayedexpansion
set PORT=
for /f "tokens=2 delims==" %%A in ('findstr /B /C:"PORT=" .env') do set PORT=%%A
if "%PORT%"=="" set PORT=3000

:checkport
netstat -ano | findstr :%PORT% >nul
if %ERRORLEVEL%==0 (
    echo Port %PORT% is in use, trying next...
    set /a PORT=%PORT%+1
    goto checkport
)

REM Update .env with selected port
powershell -Command "(Get-Content .env) -replace '^PORT=.*', 'PORT=%PORT%' | Set-Content .env"

echo Using port %PORT%

REM Start the server
echo Starting the server...
node index.js
endlocal