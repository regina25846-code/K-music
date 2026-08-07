; ===== 설치 흐름 표준 5단계 중 5번: 완료 화면 "바탕화면에 바로가기 만들기" 체크란 (기본 체크) =====
; addDesktopLink 매크로(electron-builder 내장)가 설치 도중 무조건 바로가기를 만들어버려서,
; 그 자동 생성은 끄고(DO_NOT_CREATE_DESKTOP_SHORTCUT) 완료 화면 체크박스에서 직접 만들도록 이관.
; (K-Memo v1.4.0에서 검증된 패턴을 그대로 이식, 2026-08-02)
!define DO_NOT_CREATE_DESKTOP_SHORTCUT

; BUILD_UNINSTALLER(제거 프로그램 자체를 임시로 빌드하는 내부 단계)는 완료 화면을 따로
; 컴파일하는데, 이 SHOWREADME 정의를 무조건 켜두면 그쪽 완료 화면(uninstall 섹션)에서
; un. 접두어 없는 함수를 못 부른다고 컴파일 자체가 깨짐 — 진짜 설치 프로그램 컴파일 때만 적용.
!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "바탕화면에 바로가기 만들기"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcutAtFinish
  !define MUI_FINISHPAGE_SHOWREADME_CHECKED

  ; common.nsh가 나중에 선언하는 $newDesktopLink/$appExe는 이 시점(내 파일이 먼저 include됨)에
  ; 아직 컴파일러가 몰라서 "unknown variable" 경고(-WX 때문에 빌드 실패)가 나서 별도 변수로 분리
  Var /GLOBAL ktMusicDesktopLink

  Function CreateDesktopShortcutAtFinish
    StrCpy $ktMusicDesktopLink "$DESKTOP\${SHORTCUT_NAME}.lnk"
    CreateShortCut "$ktMusicDesktopLink" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0 "" "" "${APP_DESCRIPTION}"
  FunctionEnd
!endif

!macro preInit
  ; ===== 설치 흐름 표준 1번(제거/유지 선택 프롬프트)은 2026-08-07에 뺌 =====
  ; 전자빌더 기본 동작인 "재설치/업그레이드"(덮어쓰기)가 크롬/VS코드 같은 정상적인
  ; 프로그램들도 쓰는 방식이라 데이터 손실 없이 안전하고, 실제로 필요해서 넣은 기능이
  ; 아니라 문서 기준 맞추려고 넣은 거였음. K-Tube에서 이 프롬프트가 실기 테스트에서
  ; 안 뜨는 버그를 원인 추적하다가 기능 자체가 불필요하다고 판단해서 3앱 전부 제거(형 컨펌).

  ; ===== 설치 흐름 표준 3번: K-Music 실행 중인지 확인 =====
  ; (FindWindow는 트레이 상주 시 창 제목이 없어서 못 잡던 문제가 있어서
  ; tasklist 기반으로 교체 — K-Memo에서 검증된 패턴을 그대로 이식, 2026-07-20)
  nsExec::ExecToStack 'cmd /c tasklist /fi "imagename eq K-Music.exe" | find /i "K-Music.exe"'
  Pop $0
  StrCmp $0 "0" 0 done
    MessageBox MB_YESNO|MB_ICONQUESTION "K-Music이 실행 중입니다.$\n종료하고 설치를 계속하시겠습니까?" IDYES closeit
    Abort
    closeit:
      nsExec::ExecToLog 'taskkill /f /im "K-Music.exe"'
      ; 프로세스 종료 후에도 OS가 파일 핸들을 바로 안 풀어줘서 파일복사 단계에서
      ; "사용 중" 에러가 한 번 더 뜨는 경우가 있어서, 고정 대기 대신 완전히 종료된 게
      ; 확인될 때까지 최대 5초 반복 확인
      StrCpy $1 0
      waitloop:
        Sleep 500
        IntOp $1 $1 + 1
        nsExec::ExecToStack 'cmd /c tasklist /fi "imagename eq K-Music.exe" | find /i "K-Music.exe"'
        Pop $2
        StrCmp $2 "0" checkmax waitdone
        checkmax:
          IntCmp $1 10 waitdone waitloop waitdone
      waitdone:
  done:
!macroend

!macro customUnInstall
  ; 새 버전 설치 중 기존 버전을 자동으로 지우는 내부 단계(silent)에서는 묻지 않고 자동으로
  ; 삭제 안 함 처리, 형이 Windows 설정에서 직접 "제거"할 때만 진짜로 물어봄(K-Tube/K-Memo와 동일 패턴)
  IfSilent keepdata
    ; 제거 시 설정/캐시(가사 캐시, 플레이리스트 등) 삭제 여부를 물어봄 — 기본은 "삭제 안 함"
    ; (IDNO를 기본 포커스로 — 실수로 소중한 플레이리스트가 날아가는 걸 막기 위함)
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "설치 대상과 애플리케이션 데이터(설정, 재생목록, 가사 캐시)도 함께 삭제하시겠습니까?" IDNO keepdata
    RMDir /r "$APPDATA\kris-music"
  keepdata:
!macroend
