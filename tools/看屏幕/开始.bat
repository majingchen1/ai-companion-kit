@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

title 看屏幕 - 让她读到你屏幕上的字
set PYTHONIOENCODING=gbk
set PYTHONUTF8=0

echo.
echo ============================================
echo    让她看见你的屏幕  ·  OCR 版
echo ============================================
echo.

:: ---------- 1. 找 Python ----------
set PY=
for %%C in (python py python3) do (
    if not defined PY (
        where %%C >nul 2>&1
        if not errorlevel 1 (
            for /f "delims=" %%V in ('%%C -c "import sys;print(1 if sys.version_info>=(3,10) else 0)" 2^>nul') do (
                if "%%V"=="1" set PY=%%C
            )
        )
    )
)

:: PATH 里没有就翻常见安装位置
if not defined PY (
    for %%P in (
        "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
        "C:\Python313\python.exe"
        "C:\Python312\python.exe"
        "C:\Python311\python.exe"
        "C:\Python310\python.exe"
        "D:\Python312\python.exe"
        "D:\Python311\python.exe"
        "E:\Python312\python.exe"
        "E:\Python311\python.exe"
        "E:\Python310\python.exe"
    ) do (
        if not defined PY if exist %%P set PY=%%P
    )
)

if not defined PY (
    echo [X] 没找到 Python 3.10 或更高版本。
    echo.
    echo     去这里装: https://www.python.org/downloads/
    echo     装的时候【一定勾上 Add Python to PATH】
    echo.
    echo     装完把这个窗口关掉，重新双击本文件。
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%V in ('%PY% -c "import sys;print(sys.version.split()[0])"') do set PYVER=%%V
echo [1/3] Python %PYVER%   OK

:: ---------- 2. 检查依赖 ----------
%PY% -c "import rapidocr_onnxruntime, PIL" >nul 2>&1
if not errorlevel 1 goto hasdeps

echo [2/3] 缺依赖, 正在装 ^(第一次要下约 100 MB^)
echo.
%PY% -m pip install --disable-pip-version-check -q rapidocr_onnxruntime pillow
if not errorlevel 1 goto depsok

echo      默认源不行, 换阿里云...
%PY% -m pip install --disable-pip-version-check -q -i https://mirrors.aliyun.com/pypi/simple/ rapidocr_onnxruntime pillow
if not errorlevel 1 goto depsok

echo      阿里云不行, 换清华...
%PY% -m pip install --disable-pip-version-check -q -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr_onnxruntime pillow
if not errorlevel 1 goto depsok

echo.
echo [X] 三个源都装不上, 通常是网络问题。
echo     挂个梯子再试, 或者手动运行:
echo       %PY% -m pip install rapidocr_onnxruntime pillow
echo.
pause
exit /b 1

:depsok
echo [2/3] 依赖   OK ^(刚装好^)
goto run

:hasdeps
echo [2/3] 依赖   OK ^(已有^)

:: ---------- 3. 跑 ----------
:run
echo [3/3] 开始识别...
echo.
echo   截图存到  latest.jpg
echo   识别结果在 ocr.json
echo.
echo   想停就关掉这个窗口, 或者按 Ctrl+C
echo ============================================
echo.

%PY% -u screen_ocr.py

echo.
echo 已停止。
pause
