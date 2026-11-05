Unicode true
Target amd64-unicode
!include "MUI2.nsh"
!include "x64.nsh"
Name "취재 데스크 Alpha"
OutFile "../releases/NewsDesk-0.2.0-alpha-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\NewsDeskAlpha"
RequestExecutionLevel user
SetCompressor /SOLID zlib
!define MUI_ICON "shell/icon.ico"
!define MUI_UNICON "shell/icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "취재 데스크 Alpha 설치"
!define MUI_WELCOMEPAGE_TEXT "Python 설치 없이 실행하는 취재 작업 공간입니다.$\r$\n$\r$\nWindows 10/11 64비트용입니다. 기존 취재 자료는 변경하지 않습니다.$\r$\n$\r$\n업데이트 시 실행 중인 취재 데스크를 먼저 종료해 주세요."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\NewsDesk.exe"
!define MUI_FINISHPAGE_RUN_TEXT "취재 데스크 실행"
!define MUI_FINISHPAGE_SHOWREADME ""
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"
Function .onInit
    ${IfNot} ${RunningX64}
        MessageBox MB_OK "Windows 10/11 64비트 환경이 필요합니다."
        Abort
    ${EndIf}
FunctionEnd
Section "취재 데스크"
    SetShellVarContext current
    SetOutPath "$INSTDIR"
    File /r "../build/windows/*"
    CreateDirectory "$SMPROGRAMS\취재 데스크 Alpha"
    CreateShortcut "$SMPROGRAMS\취재 데스크 Alpha\취재 데스크.lnk" "$INSTDIR\NewsDesk.exe" "" "$INSTDIR\resources\app\icon.ico"
    CreateShortcut "$DESKTOP\취재 데스크 Alpha.lnk" "$INSTDIR\NewsDesk.exe" "" "$INSTDIR\resources\app\icon.ico"
    WriteUninstaller "$INSTDIR\Uninstall.exe"
    CreateShortcut "$SMPROGRAMS\취재 데스크 Alpha\제거.lnk" "$INSTDIR\Uninstall.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewsDeskAlpha" "DisplayName" "취재 데스크 Alpha"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewsDeskAlpha" "DisplayVersion" "0.2.0-alpha.1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewsDeskAlpha" "DisplayIcon" "$INSTDIR\resources\app\icon.ico"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewsDeskAlpha" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewsDeskAlpha" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewsDeskAlpha" "NoRepair" 1
SectionEnd
Section "Uninstall"
    SetShellVarContext current
    Delete "$DESKTOP\취재 데스크 Alpha.lnk"
    RMDir /r "$SMPROGRAMS\취재 데스크 Alpha"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewsDeskAlpha"
    RMDir /r "$INSTDIR"
    MessageBox MB_OK "앱을 제거했습니다. 취재 자료는 사용자 데이터 폴더에 그대로 보관됩니다."
SectionEnd
