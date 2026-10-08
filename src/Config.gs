/** Public configuration contract for the monitor. Secret values live only in Script Properties. */
var MonitorConfig = (function () {
  var SHEETS = {
    CHANNELS: 'Channels',
    VIDEOS: 'Videos',
    LOG: 'Monitor Log'
  };

  var HEADERS = {};
  HEADERS[SHEETS.CHANNELS] = [
    'Channel Name', 'Channel URL', 'Channel ID', 'Uploads Playlist ID', 'Enabled',
    'Last Success At', 'Last Video ID', 'Status', 'Retry Count', 'Next Retry At',
    'Last Failure At', 'Last Error Code', 'Last Error', 'Incident ID', 'Notification Sent At'
  ];
  HEADERS[SHEETS.VIDEOS] = [
    'Video ID', 'Channel ID', 'Channel Name', 'Title', 'Published At', 'Video URL',
    'Detected At', 'Description'
  ];
  HEADERS[SHEETS.LOG] = [
    'Timestamp', 'Execution ID', 'Level', 'Action', 'Entity', 'Result', 'Error Code', 'Message', 'Details JSON'
  ];

  var PROPERTIES = {
    apiKey: 'YOUTUBE_API_KEY',
    alertRecipients: 'ALERT_RECIPIENTS',
    spreadsheetId: 'SPREADSHEET_ID',
    enabled: 'YOUTUBE_ENABLED',
    initialLookbackDays: 'INITIAL_LOOKBACK_DAYS',
    dailyQuotaGuard: 'DAILY_QUOTA_GUARD',
    regularRunHours: 'REGULAR_RUN_HOURS',
    runState: 'YOUTUBE_MONITOR_RUN_STATE',
    quotaPrefix: 'YOUTUBE_MONITOR_QUOTA_'
  };

  function propertyStore() {
    return PropertiesService.getScriptProperties();
  }

  function booleanValue(value, fallback) {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    return String(value).trim().toLowerCase() === 'true';
  }

  function boundedNumber(value, fallback, minimum, maximum) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
  }

  function parseHours(value) {
    var seen = {};
    var hours = String(value || '8,12,17').split(',').map(function (entry) {
      return Number(String(entry).trim());
    }).filter(function (hour) {
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || seen[hour]) return false;
      seen[hour] = true;
      return true;
    });
    return hours.length ? hours : [8, 12, 17];
  }

  function getSettings() {
    var properties = propertyStore();
    return {
      apiKey: properties.getProperty(PROPERTIES.apiKey) || '',
      alertRecipients: properties.getProperty(PROPERTIES.alertRecipients) || '',
      spreadsheetId: properties.getProperty(PROPERTIES.spreadsheetId) || '',
      enabled: booleanValue(properties.getProperty(PROPERTIES.enabled), false),
      initialLookbackDays: boundedNumber(properties.getProperty(PROPERTIES.initialLookbackDays), 1, 1, 30),
      dailyQuotaGuard: boundedNumber(properties.getProperty(PROPERTIES.dailyQuotaGuard), 1000, 1, 10000),
      regularRunHours: parseHours(properties.getProperty(PROPERTIES.regularRunHours)),
      timeZone: typeof Session !== 'undefined' && Session.getScriptTimeZone
        ? Session.getScriptTimeZone()
        : 'Asia/Seoul'
    };
  }

  return {
    SHEETS: SHEETS,
    HEADERS: HEADERS,
    PROPERTIES: PROPERTIES,
    getSettings: getSettings,
    getPropertyStore: propertyStore,
    parseHours: parseHours
  };
}());
