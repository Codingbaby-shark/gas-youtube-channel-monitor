/** Spreadsheet-backed state with strict schemas and formula-injection protection. */
var SheetStore = (function () {
  function spreadsheet() {
    var settings = MonitorConfig.getSettings();
    if (settings.spreadsheetId) return SpreadsheetApp.openById(settings.spreadsheetId);
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) {
      var error = new Error('No active spreadsheet. Set the SPREADSHEET_ID Script Property for a standalone project.');
      error.code = 'SPREADSHEET_NOT_CONFIGURED';
      throw error;
    }
    return active;
  }

  function safeCell(value) {
    if (value instanceof Date || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
      return value === null || value === undefined ? '' : value;
    }
    var text = String(value);
    return /^[=+\-@]/.test(text) ? "'" + text : text;
  }

  function sameHeaders(actual, expected) {
    if (actual.length !== expected.length) return false;
    for (var i = 0; i < expected.length; i++) {
      if (String(actual[i] || '') !== expected[i]) return false;
    }
    return true;
  }

  function ensureSheet(name) {
    var target = spreadsheet();
    var headers = MonitorConfig.HEADERS[name];
    if (!headers) throw new Error('Unknown sheet schema: ' + name);
    var sheet = target.getSheetByName(name);
    if (!sheet) sheet = target.insertSheet(name);
    var lastColumn = sheet.getLastColumn();
    var hasContent = sheet.getLastRow() > 0 && lastColumn > 0;
    if (!hasContent) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      return sheet;
    }
    var actual = sheet.getRange(1, 1, 1, Math.max(lastColumn, headers.length)).getValues()[0];
    while (actual.length && actual[actual.length - 1] === '') actual.pop();
    if (!sameHeaders(actual, headers)) {
      var error = new Error('Header mismatch in sheet "' + name + '". Existing data was not changed.');
      error.code = 'SHEET_SCHEMA_MISMATCH';
      throw error;
    }
    return sheet;
  }

  function initialize() {
    Object.keys(MonitorConfig.HEADERS).forEach(ensureSheet);
    return { initialized: true, sheets: Object.keys(MonitorConfig.HEADERS) };
  }

  function rowsAsObjects(name) {
    var sheet = ensureSheet(name);
    var headers = MonitorConfig.HEADERS[name];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    return sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().map(function (row, index) {
      var object = { _rowNumber: index + 2 };
      headers.forEach(function (header, columnIndex) { object[header] = row[columnIndex]; });
      return object;
    }).filter(function (object) {
      return Object.keys(object).some(function (key) { return key !== '_rowNumber' && object[key] !== ''; });
    });
  }

  function updateRow(name, rowNumber, patch) {
    var sheet = ensureSheet(name);
    var headers = MonitorConfig.HEADERS[name];
    var row = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
    Object.keys(patch || {}).forEach(function (header) {
      var index = headers.indexOf(header);
      if (index < 0) throw new Error('Unknown column "' + header + '" for sheet "' + name + '".');
      row[index] = safeCell(patch[header]);
    });
    sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
    var result = { _rowNumber: rowNumber };
    headers.forEach(function (header, index) { result[header] = row[index]; });
    return result;
  }

  function appendRow(name, record) {
    var sheet = ensureSheet(name);
    var headers = MonitorConfig.HEADERS[name];
    sheet.appendRow(headers.map(function (header) { return safeCell(record[header]); }));
    return sheet.getLastRow();
  }

  function isTrue(value) {
    return value === true || String(value || '').trim().toLowerCase() === 'true';
  }

  function readChannels() {
    return rowsAsObjects(MonitorConfig.SHEETS.CHANNELS).map(function (row) {
      return {
        rowNumber: row._rowNumber,
        channelName: String(row['Channel Name'] || ''),
        channelUrl: String(row['Channel URL'] || ''),
        channelId: String(row['Channel ID'] || ''),
        uploadsPlaylistId: String(row['Uploads Playlist ID'] || ''),
        enabled: isTrue(row.Enabled),
        lastSuccessAt: String(row['Last Success At'] || ''),
        lastVideoId: String(row['Last Video ID'] || ''),
        status: String(row.Status || ''),
        retryCount: Number(row['Retry Count'] || 0),
        nextRetryAt: String(row['Next Retry At'] || ''),
        lastFailureAt: String(row['Last Failure At'] || ''),
        lastErrorCode: String(row['Last Error Code'] || ''),
        lastError: String(row['Last Error'] || ''),
        incidentId: String(row['Incident ID'] || ''),
        notificationSentAt: String(row['Notification Sent At'] || '')
      };
    });
  }

  function updateChannel(rowNumber, patch) {
    var mapping = {
      channelName: 'Channel Name', channelUrl: 'Channel URL', channelId: 'Channel ID',
      uploadsPlaylistId: 'Uploads Playlist ID', enabled: 'Enabled', lastSuccessAt: 'Last Success At',
      lastVideoId: 'Last Video ID', status: 'Status', retryCount: 'Retry Count',
      nextRetryAt: 'Next Retry At', lastFailureAt: 'Last Failure At', lastErrorCode: 'Last Error Code',
      lastError: 'Last Error', incidentId: 'Incident ID', notificationSentAt: 'Notification Sent At'
    };
    var sheetPatch = {};
    Object.keys(patch || {}).forEach(function (key) {
      if (!mapping[key]) throw new Error('Unknown channel field: ' + key);
      sheetPatch[mapping[key]] = patch[key];
    });
    return updateRow(MonitorConfig.SHEETS.CHANNELS, rowNumber, sheetPatch);
  }

  function hasVideoId(videoId) {
    if (!videoId) return false;
    var sheet = ensureSheet(MonitorConfig.SHEETS.VIDEOS);
    if (sheet.getLastRow() < 2) return false;
    var match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
      .createTextFinder(String(videoId)).matchEntireCell(true).findNext();
    return Boolean(match);
  }

  function appendVideo(video) {
    if (!video || !video.videoId || hasVideoId(video.videoId)) return null;
    return appendRow(MonitorConfig.SHEETS.VIDEOS, {
      'Video ID': video.videoId,
      'Channel ID': video.channelId,
      'Channel Name': video.channelName,
      Title: video.title,
      'Published At': video.publishedAt,
      'Video URL': video.videoUrl,
      'Detected At': video.detectedAt,
      Description: video.description
    });
  }

  function appendLog(entry) {
    entry = entry || {};
    return appendRow(MonitorConfig.SHEETS.LOG, {
      Timestamp: entry.timestamp || new Date().toISOString(),
      'Execution ID': entry.executionId || '',
      Level: entry.level || 'INFO',
      Action: entry.action || '',
      Entity: entry.entity || '',
      Result: entry.result || '',
      'Error Code': entry.errorCode || '',
      Message: entry.message || '',
      'Details JSON': entry.details ? JSON.stringify(entry.details) : ''
    });
  }

  return {
    initialize: initialize,
    readChannels: readChannels,
    updateChannel: updateChannel,
    hasVideoId: hasVideoId,
    appendVideo: appendVideo,
    appendLog: appendLog,
    safeCell: safeCell
  };
}());
