# YouTube Channel Content Monitor

Google Apps Script와 Google Sheets를 이용해 등록한 YouTube 채널의 신규 공개 영상을 자동으로 수집하는 모니터링 도구입니다.

단순히 새 영상을 가져오는 데 그치지 않고, 채널별 마지막 정상 수집 시점을 보존하고 영상 ID 중복을 방지합니다. 일시적인 오류가 발생하면 5분·15분·30분 뒤에 다시 시도하며, 최종 실패로 판단된 경우에만 관리자에게 알림을 보냅니다.

## 주요 기능

- YouTube Data API v3를 이용해 채널과 업로드 재생목록을 조회합니다.
- 채널별 마지막 정상 수집 시점을 저장하며, 수집이 끝까지 성공한 경우에만 시점을 갱신합니다.
- 이미 저장된 영상 ID를 확인해 같은 영상을 두 번 등록하지 않습니다.
- 네트워크 시간 초과, HTTP 429, HTTP 5xx 오류를 일시 오류로 분류합니다.
- 일시 오류는 약 5분·15분·30분 뒤에 각각 한 번씩 다시 시도합니다.
- 전역 잠금과 후속 실행 인계를 이용해 여러 실행이 동시에 같은 데이터를 처리하지 않도록 합니다.
- 재시도를 모두 소진하거나 영구 오류가 발생하면 관리자에게 최종 실패 메일을 한 번만 보냅니다.
- 채널 상태, 수집 영상, 실행 로그를 Google Sheets에서 확인할 수 있습니다.
- 스프레드시트 메뉴의 **실패 채널 다시 시도** 기능으로 복구 작업을 직접 실행할 수 있습니다.
- Script Properties에 기록한 일일 API 사용량을 기준으로 할당량 보호 상한을 적용합니다.

## 폴더 구성

```text
src/                         Apps Script 소스 파일
tests/                       Apps Script 모의 객체를 이용한 Node.js 단위 테스트
scripts/static-check.js      구문·manifest·비밀정보 패턴 검사
examples/                    실제 정보가 없는 익명 설정 예시
appsscript.json              Apps Script manifest
SETUP.md                     설치와 확인 방법
```

## 빠른 시작

1. 빈 Google Spreadsheet와 연결된 Apps Script 프로젝트를 만듭니다.
2. `src/`의 파일과 `appsscript.json`을 Apps Script 프로젝트에 복사합니다. `clasp`를 사용한다면 `.clasp.json.example`을 `.clasp.json`으로 복사하고 `YOUR_SCRIPT_ID`를 실제 Script ID로 바꾼 뒤 `clasp push`를 실행합니다.
3. [SETUP.md](./SETUP.md)를 참고해 Script Properties를 등록합니다.
4. Apps Script 편집기에서 `initializeYouTubeMonitor`를 한 번 실행하고 권한을 승인합니다.
5. `Channels` 시트에 채널 URL 또는 핸들을 입력하고 `Enabled`를 `TRUE`로 설정합니다.
6. `runYouTubeMonitorNow`를 실행해 신규 영상 수집과 중복 방지를 확인합니다.
7. `installYouTubeMonitorTriggers`를 실행해 정규 수집 일정을 설치합니다.

이 저장소에는 실제 API 키, Spreadsheet ID, 이메일 주소, 채널 정보, Apps Script ID 또는 배포 ID가 포함되어 있지 않습니다.

## 로컬 검증

Node.js 20 이상이 필요하며 별도의 production·development 패키지 의존성은 없습니다.

```bash
npm ci
npm run check
```

`npm run check`는 Apps Script 구문, 필수 OAuth 범위, 비밀정보 패턴을 검사한 뒤 전체 단위 테스트를 실행합니다.

## 스프레드시트 구성

초기화 함수는 다음 세 개의 시트를 생성합니다.

- `Channels`에는 채널 정보, 마지막 정상 수집 시점, 재시도 상태와 알림 상태를 저장합니다.
- `Videos`에는 고유한 YouTube 영상 ID별로 한 행을 저장합니다.
- `Monitor Log`에는 API 키나 알림 수신자 주소를 제외한 실행 기록을 저장합니다.

이 도구는 시트의 데이터를 자동으로 삭제하지 않습니다. 채널 수집을 중단하려면 `Channels` 시트에서 해당 행의 `Enabled`를 `FALSE`로 바꿉니다.

## 장애 복구 방식

```text
정규 트리거 실행
  -> 전역 잠금 획득
  -> 마지막 정상 수집 시점이 오래된 채널부터 확인
  -> 아직 저장하지 않은 공개 영상 추가
  -> 정상 처리된 채널의 수집 시점 갱신
  -> 일시 오류의 상태 저장과 가장 이른 재시도 예약
  -> 최종 실패로 확정된 경우에만 관리자 알림 발송
```

다른 실행이 진행 중이라 정규 실행이 잠금을 얻지 못하면 후속 정규 실행을 한 번만 예약합니다. 재시도 실행이 잠금을 얻지 못한 경우에도 채널 상태를 지우지 않고 다음 실행으로 인계합니다.

## 보안 유의사항

- `YOUTUBE_API_KEY`와 알림 수신자는 반드시 Script Properties에 저장합니다.
- Spreadsheet와 Apps Script 프로젝트는 필요한 관리자에게만 공유합니다.
- 권한을 승인하기 전에 `appsscript.json`의 OAuth 범위를 확인합니다.
- `.clasp.json`, 인증 파일, 데이터 내보내기 파일과 실제 설정 예시는 커밋하지 않습니다.
- YouTube API 키에는 사용 API와 호출 환경에 맞는 제한을 적용합니다.

## 제한 사항

- 시간 기반 트리거의 실제 실행 시각은 Google Apps Script 환경에 따라 다소 늦어질 수 있습니다.
- API 사용량은 등록한 채널 수와 조회 횟수에 따라 달라집니다.
- 채널의 업로드 재생목록에서 확인되는 공개 영상만 저장합니다. 비공개·삭제·접근 제한 영상은 저장하지 않습니다.
- 로컬 테스트만으로 특정 Google 계정의 OAuth 승인, 트리거 실행, MailApp 발송과 실제 API 할당량을 보증할 수는 없습니다.

## 라이선스

MIT License를 적용합니다. 자세한 내용은 [LICENSE](./LICENSE)를 확인해 주세요.
