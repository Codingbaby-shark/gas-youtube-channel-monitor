# Installation and verification

## 1. Prerequisites

- A Google account that can create a Spreadsheet and an Apps Script project.
- A Google Cloud project with YouTube Data API v3 enabled.
- A YouTube Data API key restricted according to your security requirements.
- Node.js 20 or newer for local verification.
- Optional: `clasp` for command-line upload.

## 2. Prepare the Apps Script project

Create an empty Google Spreadsheet. Open **Extensions → Apps Script** to create a bound project.

Copy each file from `src/` into the Apps Script editor and replace the generated manifest with `appsscript.json`. If you use `clasp`, copy `.clasp.json.example` to `.clasp.json` and replace `YOUR_SCRIPT_ID` before pushing.

The repository does not include a real Script ID or Spreadsheet ID.

## 3. Configure Script Properties

In **Project Settings → Script Properties**, add these properties.

| Property | Required | Example | Purpose |
|---|---:|---|---|
| `YOUTUBE_API_KEY` | Yes | `YOUR_RESTRICTED_API_KEY` | Calls YouTube Data API v3. |
| `ALERT_RECIPIENTS` | Recommended | `alerts@example.com` | Comma-separated final-failure recipients. |
| `SPREADSHEET_ID` | No | `YOUR_SPREADSHEET_ID` | Needed only for a standalone rather than bound script. |
| `YOUTUBE_ENABLED` | No | `true` | Defaults to `false` for a fail-closed first install. |
| `INITIAL_LOOKBACK_DAYS` | No | `1` | First-scan lookback window, from 1 to 30 days. |
| `DAILY_QUOTA_GUARD` | No | `1000` | Stops new API calls after the configured daily unit count. |
| `REGULAR_RUN_HOURS` | No | `8,12,17` | Local trigger hours, from 0 to 23. |

An anonymous machine-readable example is available at `examples/script-properties.example.json`.

## 4. Initialize sheets

Run `initializeYouTubeMonitor` from the Apps Script editor and approve the requested scopes. The function creates or validates these sheets without deleting existing rows.

- `Channels`.
- `Videos`.
- `Monitor Log`.

Add a channel row to `Channels`. Use either a full `/channel/UC...` URL, an `@handle`, or a raw `UC...` channel ID. Leave resolved IDs and status columns blank. Set `Enabled` to `TRUE` only when the row is ready.

## 5. Verify manually

Set `YOUTUBE_ENABLED` to `true`, then run `runYouTubeMonitorNow`.

Verify the following results.

1. The channel row contains a resolved `Channel ID` and `Uploads Playlist ID`.
2. `Status` is `OK` and `Last Success At` has a value.
3. New public videos appear in `Videos` once.
4. Running the function again does not duplicate existing `Video ID` values.
5. `Monitor Log` contains run events but no API key or recipient address.

## 6. Install triggers

Run `installYouTubeMonitorTriggers` once. It replaces only triggers owned by this project whose handler is `processYouTubeChannelTrigger`.

The default schedule is 08:00, 12:00, and 17:00 in the manifest time zone. Change `REGULAR_RUN_HOURS` before installation if needed.

Retry and deferred triggers are created and removed automatically.

## 7. Recovery operations

Open or reload the Spreadsheet to see the **YouTube Monitor** menu.

- **Run now** starts a regular scan.
- **Retry failed channels** resets enabled `FINAL_FAILURE` rows and immediately retries them.
- **Install regular triggers** replaces the regular schedule using `REGULAR_RUN_HOURS`.

Before a manual retry, fix permanent causes such as an invalid channel URL, missing API key, disabled API, or insufficient quota.

## 8. Local checks

From the repository root, run the commands defined in `package.json`.

```bash
npm install
npm run check
```

The static check validates JavaScript syntax, required manifest scopes, expected files, and common secret or Google asset identifier patterns. Unit tests cover error classification, retry timing, checkpoint preservation, duplicate prevention, lock handoff, final alerts, and manual recovery.

## Uninstall

Delete the Apps Script triggers in **Triggers** and remove the Apps Script project if it is no longer needed. Sheet rows are not deleted automatically.
