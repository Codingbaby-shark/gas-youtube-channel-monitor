# YouTube Channel Content Monitor

YouTube Channel Content Monitor is a Google Apps Script project that records newly published public videos from configured YouTube channels in Google Sheets.

It is designed for unattended operation. The monitor keeps a per-channel checkpoint, prevents duplicate video IDs, retries transient failures after 5, 15, and 30 minutes, hands overlapping runs off safely, and alerts administrators only when an incident reaches a final failure.

## Features

- YouTube Data API v3 channel and uploads-playlist lookup.
- Per-channel checkpoints that advance only after a successful scan.
- Video ID deduplication before any row is appended.
- Retryable error classification for timeouts, HTTP 429, and HTTP 5xx responses.
- One-time retry triggers after approximately 5, 15, and 30 minutes.
- Script-wide locking and a deferred regular-run handoff.
- Final-failure email alerts with duplicate-alert suppression.
- Spreadsheet-backed channel, video, and event-log state.
- A **Retry failed channels** administrator menu action.
- A daily API quota guard stored in Script Properties.

## Project layout

```text
src/                         Apps Script source files
tests/                       Node.js unit tests with Apps Script mocks
scripts/static-check.js      Syntax, manifest, and secret-pattern checks
examples/                    Anonymous configuration examples
appsscript.json              Apps Script manifest
SETUP.md                     Installation and verification guide
```

## Quick start

1. Create an empty Google Spreadsheet and a bound Apps Script project.
2. Copy the files in `src/` and `appsscript.json` into that project. With `clasp`, copy `.clasp.json.example` to `.clasp.json`, replace `YOUR_SCRIPT_ID`, and run `clasp push`.
3. In Apps Script project settings, add the Script Properties described in [SETUP.md](./SETUP.md).
4. Run `initializeYouTubeMonitor` once and authorize the requested scopes.
5. Add channel URLs or handles to the `Channels` sheet, then set `Enabled` to `TRUE`.
6. Run `runYouTubeMonitorNow` for a manual verification.
7. Run `installYouTubeMonitorTriggers` to install the regular schedule.

No API key, spreadsheet ID, email address, channel identity, or deployment ID is included in this repository.

## Local verification

Node.js 20 or newer is required. The project has no runtime or development package dependencies.

```bash
npm install
npm run check
```

`npm install` only validates the package metadata and creates a local lockfile when needed. `npm run check` runs the static audit and all unit tests.

## Data model

The setup function creates three sheets.

- `Channels` stores channel identity, the latest successful checkpoint, retry state, and alert state.
- `Videos` stores one row per unique YouTube video ID.
- `Monitor Log` stores operational events without API keys or recipient addresses.

The monitor never deletes sheet data. Removing a channel from monitoring is done by setting `Enabled` to `FALSE`.

## Reliability model

```text
regular trigger
  -> acquire script lock
  -> scan enabled channels from the oldest checkpoint
  -> append unseen public videos
  -> advance each successful channel checkpoint
  -> persist transient failures and schedule the earliest retry
  -> send one alert when an incident becomes a final failure
```

If a regular run overlaps another run, a single deferred regular trigger is scheduled. A retry run that cannot acquire the lock leaves its channel state intact so the active run can schedule the next due retry.

## Security notes

- Store `YOUTUBE_API_KEY` and alert recipients only in Script Properties.
- Restrict the Spreadsheet and Apps Script project to trusted administrators.
- Review OAuth scopes before authorization.
- Do not commit `.clasp.json`, credentials, exports, or real configuration examples.
- API keys identify a Google Cloud project; use API restrictions and a quota appropriate for your environment.

## Limitations

- Trigger execution timing is controlled by Google Apps Script and is approximate.
- YouTube Data API quota usage depends on the number of channels and API calls.
- The monitor records public uploads returned by a channel's uploads playlist. Private, deleted, or unavailable videos are not recorded.
- Local tests cannot prove OAuth, trigger delivery, MailApp delivery, or quota behavior in a specific Google account.

## License

MIT. See [LICENSE](./LICENSE).
