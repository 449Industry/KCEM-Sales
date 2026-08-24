@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title KCEM GitHub Pages Auto Deploy

echo ============================================================
echo   KCEM Museum Sales - GitHub Pages Auto Deploy
echo ============================================================
echo.
echo 이 배치파일은 현재 폴더의 웹페이지를 GitHub에 올리고
echo GitHub Pages까지 자동으로 설정합니다.
echo.
echo GitHub는 명령줄 비밀번호 로그인을 지원하지 않습니다.
echo 처음 한 번만 브라우저에서 GitHub 로그인을 승인하면 됩니다.
echo.

REM ------------------------------------------------------------
REM 0. Required files
REM ------------------------------------------------------------
if not exist "index.html" (
    echo [오류] 현재 폴더에 index.html이 없습니다.
    echo 이 BAT 파일을 KCEM 웹 폴더 최상위에 넣고 실행하세요.
    echo.
    pause
    exit /b 1
)

if not exist ".github\workflows\pages.yml" (
    echo [오류] .github\workflows\pages.yml 파일이 없습니다.
    echo KCEM 웹 배포 패키지의 최상위 폴더에서 실행하세요.
    echo.
    pause
    exit /b 1
)

REM ------------------------------------------------------------
REM 1. Git
REM ------------------------------------------------------------
echo [1/8] Git 확인 중...

where git >nul 2>&1
if errorlevel 1 (
    echo Git이 설치되어 있지 않습니다.
    where winget >nul 2>&1
    if errorlevel 1 (
        echo.
        echo [오류] winget도 찾을 수 없습니다.
        echo Git을 먼저 설치한 뒤 다시 실행하세요.
        echo https://git-scm.com/
        pause
        exit /b 1
    )

    echo Git을 자동 설치합니다...
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo [오류] Git 설치에 실패했습니다.
        pause
        exit /b 1
    )

    set "PATH=%PATH%;C:\Program Files\Git\cmd"
)

where git >nul 2>&1
if errorlevel 1 (
    echo [오류] Git 설치 후 명령을 찾을 수 없습니다.
    echo 이 창을 닫고 BAT 파일을 다시 실행해 주세요.
    pause
    exit /b 1
)

echo Git OK
echo.

REM ------------------------------------------------------------
REM 2. GitHub CLI
REM ------------------------------------------------------------
echo [2/8] GitHub CLI 확인 중...

where gh >nul 2>&1
if errorlevel 1 (
    echo GitHub CLI가 설치되어 있지 않습니다.
    where winget >nul 2>&1
    if errorlevel 1 (
        echo [오류] winget을 찾을 수 없습니다.
        pause
        exit /b 1
    )

    echo GitHub CLI를 자동 설치합니다...
    winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo [오류] GitHub CLI 설치에 실패했습니다.
        pause
        exit /b 1
    )

    set "PATH=%PATH%;C:\Program Files\GitHub CLI"
)

where gh >nul 2>&1
if errorlevel 1 (
    echo [오류] GitHub CLI 설치 후 명령을 찾을 수 없습니다.
    echo 이 창을 닫고 BAT 파일을 다시 실행해 주세요.
    pause
    exit /b 1
)

echo GitHub CLI OK
echo.

REM ------------------------------------------------------------
REM 3. GitHub Login
REM ------------------------------------------------------------
echo [3/8] GitHub 로그인 확인 중...

gh auth status -h github.com >nul 2>&1
if errorlevel 1 (
    echo.
    echo GitHub 로그인 창을 브라우저에서 엽니다.
    echo 사용할 GitHub 계정으로 로그인하고 권한을 승인하세요.
    echo.
    gh auth login --hostname github.com --git-protocol https --web --scopes "repo,workflow"

    if errorlevel 1 (
        echo.
        echo [오류] GitHub 로그인에 실패했습니다.
        pause
        exit /b 1
    )
) else (
    echo 기존 GitHub 로그인을 사용합니다.
)

REM GitHub CLI credentials for git
gh auth setup-git >nul 2>&1

for /f "delims=" %%A in ('gh api user --jq ".login" 2^>nul') do set "GH_OWNER=%%A"
for /f "delims=" %%A in ('gh api user --jq ".id" 2^>nul') do set "GH_USER_ID=%%A"

if not defined GH_OWNER (
    echo [오류] 로그인된 GitHub 계정을 확인할 수 없습니다.
    pause
    exit /b 1
)

echo 로그인 계정: !GH_OWNER!
echo.

REM ------------------------------------------------------------
REM 4. Repository settings
REM ------------------------------------------------------------
echo [4/8] 저장소 설정
echo.

set "DEFAULT_REPO=KCEM-Sales"
set /p "REPO_NAME=GitHub 저장소 이름 [%DEFAULT_REPO%]: "
if not defined REPO_NAME set "REPO_NAME=%DEFAULT_REPO%"

echo.
echo GitHub Free에서 Pages를 가장 간단하게 사용하기 위해
echo 기본값은 공개(Public) 저장소입니다.
set /p "PRIVATE_CHOICE=비공개(Private) 저장소로 만들까요? [y/N]: "

set "VISIBILITY=public"
if /I "%PRIVATE_CHOICE%"=="Y" set "VISIBILITY=private"
if /I "%PRIVATE_CHOICE%"=="YES" set "VISIBILITY=private"

echo.
echo 저장소: !GH_OWNER!/!REPO_NAME!
echo 공개설정: !VISIBILITY!
echo.

REM ------------------------------------------------------------
REM 5. Initialize local git
REM ------------------------------------------------------------
echo [5/8] 로컬 Git 준비 중...

if not exist ".git" (
    git init
    if errorlevel 1 goto :git_error
)

git branch -M main

REM Commit identity only if not already configured
set "GIT_NAME="
for /f "delims=" %%A in ('git config user.name 2^>nul') do set "GIT_NAME=%%A"
if not defined GIT_NAME git config user.name "!GH_OWNER!"

set "GIT_EMAIL="
for /f "delims=" %%A in ('git config user.email 2^>nul') do set "GIT_EMAIL=%%A"
if not defined GIT_EMAIL (
    if defined GH_USER_ID (
        git config user.email "!GH_USER_ID!+!GH_OWNER!@users.noreply.github.com"
    ) else (
        git config user.email "!GH_OWNER!@users.noreply.github.com"
    )
)

git add .
if errorlevel 1 goto :git_error

git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Deploy KCEM Museum Sales"
    if errorlevel 1 goto :git_error
) else (
    echo 새로 커밋할 변경사항이 없습니다.
)

echo.

REM ------------------------------------------------------------
REM 6. Create or connect GitHub repository
REM ------------------------------------------------------------
echo [6/8] GitHub 저장소 확인 중...

gh repo view "!GH_OWNER!/!REPO_NAME!" >nul 2>&1
if errorlevel 1 (
    echo 새 GitHub 저장소를 생성합니다...

    if /I "!VISIBILITY!"=="private" (
        gh repo create "!GH_OWNER!/!REPO_NAME!" --private --source=. --remote=origin
    ) else (
        gh repo create "!GH_OWNER!/!REPO_NAME!" --public --source=. --remote=origin
    )

    if errorlevel 1 (
        echo [오류] GitHub 저장소 생성에 실패했습니다.
        pause
        exit /b 1
    )
) else (
    echo 기존 저장소를 사용합니다.

    git remote get-url origin >nul 2>&1
    if errorlevel 1 (
        git remote add origin "https://github.com/!GH_OWNER!/!REPO_NAME!.git"
    ) else (
        git remote set-url origin "https://github.com/!GH_OWNER!/!REPO_NAME!.git"
    )
)

echo GitHub에 업로드합니다...
git push -u origin main

if errorlevel 1 (
    echo.
    echo [오류] GitHub Push에 실패했습니다.
    echo 기존 저장소에 다른 파일이 이미 있거나 권한 문제일 수 있습니다.
    echo.
    echo 저장소 주소:
    echo https://github.com/!GH_OWNER!/!REPO_NAME!
    echo.
    pause
    exit /b 1
)

echo.

REM ------------------------------------------------------------
REM 7. Enable GitHub Pages (Actions workflow)
REM ------------------------------------------------------------
echo [7/8] GitHub Pages 설정 중...

gh api "repos/!GH_OWNER!/!REPO_NAME!/pages" >nul 2>&1

if errorlevel 1 (
    gh api --method POST "repos/!GH_OWNER!/!REPO_NAME!/pages" -f build_type=workflow >nul 2>&1

    if errorlevel 1 (
        echo Pages 자동 활성화가 아직 완료되지 않았습니다.
        echo 한 번 더 시도합니다...
        timeout /t 2 /nobreak >nul
        gh api --method POST "repos/!GH_OWNER!/!REPO_NAME!/pages" -f build_type=workflow >nul 2>&1
    )
) else (
    gh api --method PUT "repos/!GH_OWNER!/!REPO_NAME!/pages" -f build_type=workflow >nul 2>&1
)

REM Push trigger may have happened before Pages activation.
REM Trigger the included workflow again explicitly.
timeout /t 2 /nobreak >nul
gh workflow run pages.yml --ref main -R "!GH_OWNER!/!REPO_NAME!" >nul 2>&1

echo.

REM ------------------------------------------------------------
REM 8. Result
REM ------------------------------------------------------------
echo [8/8] 완료
echo.

set "PAGE_URL="
for /f "delims=" %%A in ('gh api "repos/!GH_OWNER!/!REPO_NAME!/pages" --jq ".html_url" 2^>nul') do set "PAGE_URL=%%A"

echo ============================================================
echo   GitHub 업로드 완료
echo ============================================================
echo.
echo 저장소:
echo https://github.com/!GH_OWNER!/!REPO_NAME!
echo.

if defined PAGE_URL (
    echo 웹페이지:
    echo !PAGE_URL!
) else (
    echo 예상 웹페이지:
    echo https://!GH_OWNER!.github.io/!REPO_NAME!/
)

echo.
echo 첫 배포는 보통 1~3분 정도 걸릴 수 있습니다.
echo GitHub Actions 화면을 열어 배포 상태를 확인합니다.
echo.

start "" "https://github.com/!GH_OWNER!/!REPO_NAME!/actions"

if defined PAGE_URL (
    echo 배포가 끝난 뒤 아래 주소를 열 수 있습니다:
    echo !PAGE_URL!
)

echo.
echo 다음에 웹 파일을 수정한 뒤 이 BAT을 다시 실행해도
echo 같은 저장소에 새 변경사항을 자동으로 Push할 수 있습니다.
echo.
pause
exit /b 0


:git_error
echo.
echo [오류] Git 작업 중 문제가 발생했습니다.
echo.
pause
exit /b 1
