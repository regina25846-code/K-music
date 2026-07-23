!macro preInit
  ; K-Music 실행 중인지 확인 (FindWindow는 트레이 상주 시 창 제목이 없어서 못 잡던 문제가 있어서
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
  ; ⚠️ 형이 지적: 새 버전 설치 중 기존 버전을 자동으로 먼저 제거하는 과정에서도 이 매크로가
  ; 실행돼서, "설치중" 화면 위에 삭제 여부 확인창이 갑자기 뜨는 문제가 있었음(2026-07-20).
  ; 이건 형이 직접 "제거하기"를 누른 게 아니라 설치 마법사가 조용히 처리해야 하는 내부 단계라,
  ; 이 경우엔 아예 묻지 않고 삭제 안 함으로 자동 처리(IfSilent로 이 상황 감지).
  ; 형이 Windows 설정 > 앱에서 K-Music을 직접 "제거"할 때만 진짜로 물어봄.
  IfSilent keepdata
    ; 제거 시 설정/캐시(가사 캐시, 플레이리스트 등) 삭제 여부를 물어봄 — 기본은 "삭제 안 함"
    ; (IDNO를 기본 포커스로 — 실수로 소중한 플레이리스트가 날아가는 걸 막기 위함)
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "애플리케이션 데이터(설정, 재생목록, 가사 캐시)도 함께 삭제하시겠습니까?" IDNO keepdata
    RMDir /r "$APPDATA\kris-music"
  keepdata:
!macroend
