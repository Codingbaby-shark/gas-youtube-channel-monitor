# 설치와 확인 방법

## 1. 준비 사항

다음 항목이 필요합니다.

- Google Spreadsheet와 Apps Script 프로젝트를 만들 수 있는 Google 계정이 필요합니다.
- YouTube Data API v3가 활성화된 Google Cloud 프로젝트가 필요합니다.
- 사용 환경에 맞게 제한한 YouTube Data API 키가 필요합니다.
- 로컬 검증에는 Node.js 20 이상이 필요합니다.
- 명령줄에서 파일을 올리려면 선택 사항으로 `clasp`를 사용할 수 있습니다.

## 2. Apps Script 프로젝트 준비

빈 Google Spreadsheet를 만든 뒤 **확장 프로그램 → Apps Script**를 선택해 연결된 프로젝트를 만듭니다.

`src/`의 각 파일을 Apps Script 편집기에 복사하고, 자동으로 생성된 manifest를 이 저장소의 `appsscript.json`으로 교체합니다. `clasp`를 사용한다면 `.clasp.json.example`을 `.clasp.json`으로 복사하고 `YOUR_SCRIPT_ID`를 실제 Script ID로 바꾼 뒤 파일을 올립니다.

이 저장소에는 실제 Script ID나 Spreadsheet ID가 들어 있지 않습니다.

## 3. Script Properties 설정

Apps Script의 **프로젝트 설정 → 스크립트 속성**에서 다음 값을 등록합니다.

| 속성 | 필수 여부 | 예시 | 용도 |
|---|---:|---|---|
| `YOUTUBE_API_KEY` | 필수 | `YOUR_RESTRICTED_API_KEY` | YouTube Data API v3 호출에 사용합니다. |
| `ALERT_RECIPIENTS` | 권장 | `alerts@example.com` | 최종 실패 알림을 받을 주소를 쉼표로 구분해 입력합니다. |
| `SPREADSHEET_ID` | 선택 | `YOUR_SPREADSHEET_ID` | 연결형이 아닌 독립형 Apps Script를 사용할 때만 입력합니다. |
| `YOUTUBE_ENABLED` | 선택 | `true` | 기본값은 안전을 위해 `false`입니다. |
| `INITIAL_LOOKBACK_DAYS` | 선택 | `1` | 최초 수집 범위를 1일에서 30일 사이로 지정합니다. |
| `DAILY_QUOTA_GUARD` | 선택 | `1000` | 하루 API 사용량이 이 값에 도달하면 추가 호출을 중단합니다. |
| `REGULAR_RUN_HOURS` | 선택 | `8,12,17` | 정규 수집을 시작할 현지 시각을 쉼표로 구분해 입력합니다. |

실제 정보가 없는 예시는 `examples/script-properties.example.json`에서 확인할 수 있습니다.

## 4. 시트 초기화

Apps Script 편집기에서 `initializeYouTubeMonitor`를 실행하고 필요한 권한을 승인합니다. 이 함수는 기존 행을 삭제하지 않으며 다음 시트를 생성하거나 헤더를 확인합니다.

- `Channels`.
- `Videos`.
- `Monitor Log`.

`Channels` 시트에 채널을 추가합니다. `/channel/UC...` 형식의 URL, `@handle` 또는 `UC...` 형식의 채널 ID를 사용할 수 있습니다. 자동으로 채워지는 ID와 상태 열은 비워 두고, 수집할 준비가 끝난 행만 `Enabled`를 `TRUE`로 설정합니다.

## 5. 최초 실행 확인

Script Properties에서 `YOUTUBE_ENABLED`를 `true`로 바꾼 뒤 `runYouTubeMonitorNow`를 실행합니다.

다음 항목을 확인합니다.

1. 채널 행의 `Channel ID`와 `Uploads Playlist ID`가 자동으로 입력됩니다.
2. `Status`가 `OK`로 바뀌고 `Last Success At`에 정상 수집 시각이 기록됩니다.
3. 새 공개 영상이 `Videos` 시트에 한 번씩 저장됩니다.
4. 같은 함수를 다시 실행해도 기존 `Video ID`가 중복으로 추가되지 않습니다.
5. `Monitor Log`에는 실행 결과가 기록되지만 API 키와 알림 수신자 주소는 남지 않습니다.

## 6. 정규 트리거 설치

최초 실행 확인이 끝나면 `installYouTubeMonitorTriggers`를 한 번 실행합니다. 이 함수는 현재 프로젝트에서 `processYouTubeChannelTrigger`를 사용하는 정규 트리거만 교체합니다.

기본 실행 시각은 manifest 시간대를 기준으로 08시, 12시, 17시입니다. 다른 시각을 사용하려면 트리거를 설치하기 전에 `REGULAR_RUN_HOURS`를 변경합니다.

오류 재시도용 트리거와 중복 실행 인계용 트리거는 실행 상태에 따라 자동으로 생성되고 제거됩니다.

## 7. 장애 복구

Spreadsheet를 새로 열면 **YouTube Monitor** 메뉴가 표시됩니다.

- **Run now**는 전체 정규 수집을 바로 시작합니다.
- **Retry failed channels**는 사용 중인 `FINAL_FAILURE` 채널을 재시도 대기 상태로 바꾸고 즉시 다시 확인합니다.
- **Install regular triggers**는 `REGULAR_RUN_HOURS` 설정에 맞춰 정규 트리거를 다시 설치합니다.

수동 재시도를 실행하기 전에 잘못된 채널 URL, 누락된 API 키, 비활성화된 API와 할당량 부족 같은 영구 원인을 먼저 해결합니다.

## 8. 로컬 검사

저장소 루트에서 `package.json`에 정의된 명령을 실행합니다.

```bash
npm ci
npm run check
```

정적 검사는 JavaScript 구문, 필수 OAuth 범위, 필수 파일과 일반적인 비밀정보·Google 자산 식별자 패턴을 확인합니다. 단위 테스트는 오류 분류, 재시도 간격, 체크포인트 보존, 영상 ID 중복 방지, 실행 인계, 최종 실패 알림과 수동 복구를 검증합니다.

## 사용 중단

더 이상 사용하지 않는 경우 Apps Script의 **트리거** 메뉴에서 관련 트리거를 삭제하고 Apps Script 프로젝트를 제거합니다. Spreadsheet에 저장된 행은 자동으로 삭제되지 않습니다.
