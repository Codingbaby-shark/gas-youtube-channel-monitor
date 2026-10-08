const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function baseContext(overrides = {}) {
  return vm.createContext({
    console,
    Date,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    encodeURIComponent,
    ...overrides
  });
}

function runFile(context, relative) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, relative), 'utf8'), context, { filename: relative });
}

function loadRetryRules(overrides = {}) {
  const context = baseContext({ Utilities: { getUuid: () => 'incident-1' }, ...overrides });
  runFile(context, 'src/YouTubeService.gs');
  return context;
}

function fakeProperties(seed = {}) {
  const values = { ...seed };
  return {
    getProperty: (key) => Object.hasOwn(values, key) ? values[key] : null,
    setProperty: (key, value) => { values[key] = String(value); },
    deleteProperty: (key) => { delete values[key]; },
    values
  };
}

test('classifies only transient network and YouTube responses as retryable', () => {
  const rules = loadRetryRules().YouTubeRetryRules;
  assert.equal(rules.classify({ code: 'YOUTUBE_RATE_LIMIT', message: 'HTTP 429' }).retryable, true);
  assert.equal(rules.classify({ code: 'YOUTUBE_API_SERVER_ERROR', message: 'HTTP 503' }).retryable, true);
  assert.equal(rules.classify({ message: 'Request timed out' }).code, 'NETWORK_TIMEOUT');
  assert.equal(rules.classify({ code: 'YOUTUBE_API_FORBIDDEN', message: 'HTTP 403' }).retryable, false);
  assert.equal(rules.classify({ code: 'YOUTUBE_CHANNEL_URL_INVALID', message: 'bad URL' }).retryable, false);
});

test('schedules 5, 15, and 30 minute retries before final failure', () => {
  const rules = loadRetryRules().YouTubeRetryRules;
  const now = new Date('2026-10-09T00:00:00.000Z');
  const error = { code: 'GOOGLE_SERVER_ERROR', message: 'server error', retryable: true };
  const first = rules.nextFailureState({}, error, now);
  const second = rules.nextFailureState(first, error, now);
  const third = rules.nextFailureState(second, error, now);
  const final = rules.nextFailureState(third, error, now);
  assert.equal(first.nextRetryAt, '2026-10-09T00:05:00.000Z');
  assert.equal(second.nextRetryAt, '2026-10-09T00:15:00.000Z');
  assert.equal(third.nextRetryAt, '2026-10-09T00:30:00.000Z');
  assert.equal(final.status, 'FINAL_FAILURE');
  assert.equal(final.retryCount, 3);
  assert.equal(final.incidentId, first.incidentId);
});

test('redacts API keys from error messages', () => {
  const rules = loadRetryRules().YouTubeRetryRules;
  const syntheticKey = 'AI' + 'za' + 'abcdefghijklmnopqrstuvwxyz123456';
  const sanitized = rules.sanitizeMessage('failed https://example.test?key=' + syntheticKey);
  assert.doesNotMatch(sanitized, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(sanitized, /REDACTED/);
});

test('normalizes supported channel identifiers and rejects video URLs', () => {
  const service = loadRetryRules().YouTubeService;
  assert.deepEqual(JSON.parse(JSON.stringify(service.channelLookupParams('https://www.youtube.com/channel/UCabc-123'))), { id: 'UCabc-123' });
  assert.deepEqual(JSON.parse(JSON.stringify(service.channelLookupParams('@example'))), { forHandle: 'example' });
  assert.throws(() => service.channelLookupParams('https://www.youtube.com/watch?v=abc'), (error) => error.code === 'YOUTUBE_CHANNEL_URL_INVALID');
});

test('successful scan skips duplicate IDs and advances the channel checkpoint', () => {
  const properties = fakeProperties();
  const updates = [];
  const appended = [];
  const responses = [
    { items: [
      { contentDetails: { videoId: 'new-video', videoPublishedAt: '2026-10-08T12:00:00.000Z' } },
      { contentDetails: { videoId: 'known-video', videoPublishedAt: '2026-10-08T11:00:00.000Z' } }
    ] },
    { items: [{ id: 'new-video', status: { privacyStatus: 'public' }, snippet: {
      channelId: 'UCexample', channelTitle: 'Example Channel', title: '=Safe title',
      publishedAt: '2026-10-08T12:00:00.000Z', description: 'Description https://example.com #tag'
    } }] }
  ];
  const context = baseContext({
    Utilities: { formatDate: () => '20261009', getUuid: () => 'incident-1' },
    PropertiesService: { getScriptProperties: () => properties },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(responses.shift()) }) },
    MonitorConfig: {
      PROPERTIES: { quotaPrefix: 'QUOTA_' },
      getPropertyStore: () => properties
    },
    SheetStore: {
      hasVideoId: (id) => id === 'known-video' || appended.some((video) => video.videoId === id),
      appendVideo: (video) => { appended.push(video); return appended.length; },
      updateChannel: (row, patch) => { updates.push({ row, patch }); return patch; }
    }
  });
  runFile(context, 'src/YouTubeService.gs');
  const channel = { rowNumber: 2, channelName: 'Example Channel', channelId: 'UCexample', uploadsPlaylistId: 'UUexample', lastSuccessAt: '' };
  const settings = { apiKey: 'test-key', dailyQuotaGuard: 100, timeZone: 'Asia/Seoul', initialLookbackDays: 1 };
  const result = context.YouTubeService.scanChannel(channel, settings, {
    scanStartedAt: new Date('2026-10-09T00:00:00.000Z'),
    deadline: Date.now() + 10000
  });
  assert.equal(result.created, 1);
  assert.equal(appended[0].videoId, 'new-video');
  assert.equal(appended[0].description, 'Description');
  assert.equal(updates.at(-1).patch.status, 'OK');
  assert.equal(updates.at(-1).patch.lastSuccessAt, '2026-10-09T00:00:00.000Z');
});

test('playlist pagination continues until the stored checkpoint is reached', () => {
  const properties = fakeProperties();
  const urls = [];
  const responses = [
    { nextPageToken: 'next-page', items: [
      { contentDetails: { videoId: 'new-video', videoPublishedAt: '2026-10-08T12:00:00.000Z' } }
    ] },
    { items: [
      { contentDetails: { videoId: 'old-video', videoPublishedAt: '2026-10-07T12:00:00.000Z' } }
    ] },
    { items: [{ id: 'new-video', status: { privacyStatus: 'public' }, snippet: {
      channelId: 'UCexample', channelTitle: 'Example Channel', title: 'New video',
      publishedAt: '2026-10-08T12:00:00.000Z', description: ''
    } }] }
  ];
  const appended = [];
  const context = baseContext({
    Utilities: { formatDate: () => '20261009', getUuid: () => 'incident-1' },
    PropertiesService: { getScriptProperties: () => properties },
    UrlFetchApp: { fetch: (url) => {
      urls.push(url);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(responses.shift()) };
    } },
    MonitorConfig: { PROPERTIES: { quotaPrefix: 'QUOTA_' }, getPropertyStore: () => properties },
    SheetStore: {
      hasVideoId: () => false,
      appendVideo: (video) => { appended.push(video); return appended.length; },
      updateChannel: (_row, patch) => patch
    }
  });
  runFile(context, 'src/YouTubeService.gs');
  const result = context.YouTubeService.scanChannel({
    rowNumber: 2,
    channelName: 'Example Channel',
    channelId: 'UCexample',
    uploadsPlaylistId: 'UUexample',
    lastSuccessAt: '2026-10-08T00:00:00.000Z'
  }, { apiKey: 'test-key', dailyQuotaGuard: 100, timeZone: 'Asia/Seoul', initialLookbackDays: 1 }, {
    scanStartedAt: new Date('2026-10-09T00:00:00.000Z'),
    deadline: Date.now() + 10000
  });
  assert.equal(result.created, 1);
  assert.equal(urls.length, 3);
  assert.match(urls[1], /pageToken=next-page/);
});

test('channel failure preserves the last successful checkpoint', () => {
  const properties = fakeProperties({ YOUTUBE_ENABLED: 'true', YOUTUBE_API_KEY: 'test-key' });
  const updates = [];
  const channel = {
    rowNumber: 2, channelName: 'Example Channel', channelId: 'UCexample', uploadsPlaylistId: 'UUexample',
    enabled: true, lastSuccessAt: '2026-10-08T00:00:00.000Z', status: 'OK', retryCount: 0
  };
  const context = baseContext({
    Utilities: { formatDate: () => '20261009', getUuid: () => 'incident-1' },
    PropertiesService: { getScriptProperties: () => properties },
    UrlFetchApp: { fetch: () => { throw new Error('Request timed out'); } },
    MonitorConfig: {
      PROPERTIES: { quotaPrefix: 'QUOTA_' },
      getPropertyStore: () => properties,
      getSettings: () => ({ enabled: true, apiKey: 'test-key', dailyQuotaGuard: 100, timeZone: 'Asia/Seoul', initialLookbackDays: 1 })
    },
    SheetStore: {
      readChannels: () => [channel],
      hasVideoId: () => false,
      updateChannel: (row, patch) => { updates.push({ row, patch }); return patch; }
    }
  });
  runFile(context, 'src/YouTubeService.gs');
  const result = context.YouTubeService.scanAllChannels();
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].lastSuccessAt, channel.lastSuccessAt);
  assert.equal(updates[0].patch.status, 'RETRY_WAIT');
  assert.equal(Object.hasOwn(updates[0].patch, 'lastSuccessAt'), false);
});

test('manual reset changes only enabled final-failure channels', () => {
  const updates = [];
  const context = baseContext({
    MonitorConfig: {},
    SheetStore: {
      readChannels: () => [
        { rowNumber: 2, enabled: true, status: 'FINAL_FAILURE' },
        { rowNumber: 3, enabled: false, status: 'FINAL_FAILURE' },
        { rowNumber: 4, enabled: true, status: 'OK' }
      ],
      updateChannel: (row, patch) => updates.push({ row, patch })
    },
    Utilities: { getUuid: () => 'incident-1' }
  });
  runFile(context, 'src/YouTubeService.gs');
  assert.deepEqual(Array.from(context.YouTubeService.resetFinalFailedChannels()), [2]);
  assert.equal(updates[0].patch.status, 'RETRY_WAIT');
  assert.equal(updates[0].patch.notificationSentAt, '');
});

test('final-failure notification is sent once and marks channel rows', () => {
  const sent = [];
  const updates = [];
  const context = baseContext({
    MonitorConfig: { getSettings: () => ({ alertRecipients: 'alerts@example.com' }) },
    YouTubeRetryRules: { sanitizeMessage: (value) => String(value) },
    MailApp: { sendEmail: (message) => sent.push(message) },
    SheetStore: { updateChannel: (row, patch) => updates.push({ row, patch }) }
  });
  runFile(context, 'src/NotificationService.gs');
  const failure = { rowNumber: 2, channelName: 'Example', code: 'YOUTUBE_API_FORBIDDEN', message: 'forbidden', finalFailure: true, notificationSentAt: '' };
  const first = context.NotificationService.sendFinalFailureAlert([failure], { executionId: 'run-1' });
  const second = context.NotificationService.sendFinalFailureAlert([{ ...failure, notificationSentAt: '2026-10-09T00:00:00.000Z' }], { executionId: 'run-2' });
  assert.equal(first.sent, true);
  assert.equal(second.reason, 'NO_NEW_FINAL_FAILURES');
  assert.equal(sent.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(first.recipientCount, 1);
});

test('unnotified final failures remain eligible for a later regular-run alert', () => {
  const context = baseContext({
    MonitorConfig: { getSettings: () => ({ alertRecipients: 'alerts@example.com' }) },
    YouTubeRetryRules: { sanitizeMessage: (value) => String(value) },
    SheetStore: { readChannels: () => [
      { rowNumber: 2, enabled: true, status: 'FINAL_FAILURE', notificationSentAt: '', channelName: 'Needs alert' },
      { rowNumber: 3, enabled: true, status: 'FINAL_FAILURE', notificationSentAt: 'already-sent', channelName: 'Done' },
      { rowNumber: 4, enabled: false, status: 'FINAL_FAILURE', notificationSentAt: '', channelName: 'Disabled' }
    ] }
  });
  runFile(context, 'src/NotificationService.gs');
  const pending = context.NotificationService.unnotifiedChannelFailures();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rowNumber, 2);
});

test('formula-like spreadsheet values are escaped', () => {
  const context = baseContext({
    MonitorConfig: { getSettings: () => ({ spreadsheetId: '' }), HEADERS: {}, SHEETS: {} },
    SpreadsheetApp: {}
  });
  runFile(context, 'src/SheetStore.gs');
  assert.equal(context.SheetStore.safeCell('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.equal(context.SheetStore.safeCell('@mention'), "'@mention");
  assert.equal(context.SheetStore.safeCell('normal'), 'normal');
});

test('selects the earliest due channel or whole-run retry', () => {
  const context = baseContext({});
  runFile(context, 'src/Triggers.gs');
  const next = context.YouTubeTriggerRules.earliestRetryAt([
    { enabled: true, status: 'RETRY_WAIT', nextRetryAt: '2026-10-09T00:30:00.000Z' },
    { enabled: true, status: 'OK', nextRetryAt: '2026-10-09T00:01:00.000Z' }
  ], { status: 'RETRY_WAIT', nextRetryAt: '2026-10-09T00:15:00.000Z' });
  assert.equal(next, '2026-10-09T00:15:00.000Z');
});

test('overlapping regular run schedules one deferred handoff', () => {
  const created = [];
  const triggerBuilder = (handler) => ({
    timeBased() { return this; },
    after(delay) { this.delay = delay; return this; },
    create() { created.push({ handler, delay: this.delay }); }
  });
  const context = baseContext({
    MonitorConfig: { getPropertyStore: () => fakeProperties(), PROPERTIES: { runState: 'RUN_STATE' } },
    LockService: { getScriptLock: () => ({ tryLock: () => false }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: triggerBuilder }
  });
  runFile(context, 'src/Triggers.gs');
  const result = context.processYouTubeRun_('regular', {});
  assert.equal(result.handedOff, true);
  assert.equal(result.followUp.handler, 'processDeferredYouTubeRegularTrigger');
  assert.deepEqual(created, [{ handler: 'processDeferredYouTubeRegularTrigger', delay: 60000 }]);
});

test('whole-run transient failure persists state and schedules the first retry', () => {
  const properties = fakeProperties();
  const created = [];
  const triggerBuilder = (handler) => ({
    timeBased() { return this; },
    after(delay) { this.delay = delay; return this; },
    create() { created.push({ handler, delay: this.delay }); }
  });
  const context = baseContext({
    Utilities: { getUuid: () => 'run-1' },
    MonitorConfig: { getPropertyStore: () => properties, PROPERTIES: { runState: 'RUN_STATE' } },
    SheetStore: { readChannels: () => [], appendLog: () => {} },
    NotificationService: {
      unnotifiedChannelFailures: () => [],
      sendFinalFailureAlert: () => ({ sent: false, reason: 'NO_NEW_FINAL_FAILURES' })
    },
    YouTubeService: { scanAllChannels: () => {
      const error = new Error('server error');
      error.code = 'GOOGLE_SERVER_ERROR';
      error.retryable = true;
      throw error;
    } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, hasLock: () => true, releaseLock: () => {} }) },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: triggerBuilder
    }
  });
  runFile(context, 'src/YouTubeService.gs');
  context.YouTubeService = { scanAllChannels: () => {
    const error = new Error('server error');
    error.code = 'GOOGLE_SERVER_ERROR';
    error.retryable = true;
    throw error;
  } };
  runFile(context, 'src/Triggers.gs');
  const result = context.processYouTubeRun_('regular', {});
  const state = JSON.parse(properties.values.RUN_STATE);
  assert.equal(state.status, 'RETRY_WAIT');
  assert.equal(state.retryCount, 1);
  assert.equal(result.retrySchedule.scheduled, true);
  assert.equal(created[0].handler, 'processYouTubeRetryTrigger');
  assert.ok(created[0].delay > 4 * 60 * 1000 && created[0].delay <= 5 * 60 * 1000);
});

test('manifest and anonymous example files contain only placeholders', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
  const example = fs.readFileSync(path.join(ROOT, 'examples', 'script-properties.example.json'), 'utf8');
  const clasp = fs.readFileSync(path.join(ROOT, '.clasp.json.example'), 'utf8');
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.match(example, /YOUR_RESTRICTED_API_KEY/);
  assert.match(clasp, /YOUR_SCRIPT_ID/);
  assert.doesNotMatch(example + clasp, /AIza[0-9A-Za-z_-]{30,}/);
});
