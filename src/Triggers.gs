/** Locking, run handoff, retry scheduling, and trigger entry points. */
var YouTubeTriggerRules = (function () {
  function earliestRetryAt(channels, runState) {
    var values = (channels || []).filter(function (channel) {
      return channel.enabled && channel.status === 'RETRY_WAIT' && channel.nextRetryAt;
    }).map(function (channel) { return channel.nextRetryAt; });
    if (runState && runState.status === 'RETRY_WAIT' && runState.nextRetryAt) values.push(runState.nextRetryAt);
    var valid = values.map(function (value) { return new Date(value); }).filter(function (value) {
      return !isNaN(value.getTime());
    }).sort(function (a, b) { return a.getTime() - b.getTime(); });
    return valid.length ? valid[0].toISOString() : '';
  }

  function executionState(kind, previous, now) {
    previous = previous || {};
    now = now || new Date();
    return {
      executionId: typeof Utilities !== 'undefined' && Utilities.getUuid
        ? Utilities.getUuid()
        : 'run-' + now.getTime(),
      kind: kind,
      status: 'RUNNING',
      startedAt: now.toISOString(),
      retryCount: Number(previous.retryCount || 0),
      incidentId: String(previous.incidentId || ''),
      notificationSentAt: String(previous.notificationSentAt || ''),
      lastSuccessAt: String(previous.lastSuccessAt || '')
    };
  }

  return { earliestRetryAt: earliestRetryAt, executionState: executionState };
}());

function youtubeRunProperties_() {
  return MonitorConfig.getPropertyStore();
}

function readYouTubeRunState_() {
  var raw = youtubeRunProperties_().getProperty(MonitorConfig.PROPERTIES.runState);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (ignore) { return {}; }
}

function writeYouTubeRunState_(state) {
  youtubeRunProperties_().setProperty(MonitorConfig.PROPERTIES.runState, JSON.stringify(state || {}));
}

function clearYouTubeRunState_() {
  youtubeRunProperties_().deleteProperty(MonitorConfig.PROPERTIES.runState);
}

function projectTriggersFor_(handler) {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction && trigger.getHandlerFunction() === handler;
  });
}

function removeProjectTriggersFor_(handler) {
  var triggers = projectTriggersFor_(handler);
  triggers.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  return triggers.length;
}

function scheduleSingleAfter_(handler, delayMs) {
  if (projectTriggersFor_(handler).length) return { scheduled: false, handler: handler };
  ScriptApp.newTrigger(handler).timeBased().after(Math.max(1000, delayMs)).create();
  return { scheduled: true, handler: handler };
}

function scheduleDeferredYouTubeRegular_() {
  return scheduleSingleAfter_('processDeferredYouTubeRegularTrigger', 60000);
}

function scheduleDeferredYouTubeRetry_() {
  return scheduleSingleAfter_('processYouTubeRetryTrigger', 60000);
}

function scheduleNextYouTubeRetry_() {
  removeProjectTriggersFor_('processYouTubeRetryTrigger');
  var next = YouTubeTriggerRules.earliestRetryAt(SheetStore.readChannels(), readYouTubeRunState_());
  if (!next) return { scheduled: false, nextRetryAt: '' };
  var delayMs = Math.max(1000, new Date(next).getTime() - Date.now());
  ScriptApp.newTrigger('processYouTubeRetryTrigger').timeBased().after(delayMs).create();
  return { scheduled: true, nextRetryAt: next };
}

function logYouTubeFailures_(failures, execution) {
  (failures || []).forEach(function (failure) {
    SheetStore.appendLog({
      executionId: execution.executionId,
      level: failure.finalFailure ? 'ERROR' : 'WARN',
      action: 'CHANNEL_SCAN',
      entity: failure.channelName || String(failure.rowNumber || 'run'),
      result: failure.finalFailure ? 'FINAL_FAILURE' : 'RETRY_WAIT',
      errorCode: failure.code,
      message: YouTubeRetryRules.sanitizeMessage(failure.message),
      details: { retryCount: failure.retryCount, nextRetryAt: failure.nextRetryAt || '' }
    });
  });
}

function notifyYouTubeFailures_(failures, execution) {
  try {
    var combined = [];
    var seen = {};
    (failures || []).concat(NotificationService.unnotifiedChannelFailures()).forEach(function (failure) {
      var key = String(failure.rowNumber || 'run') + ':' + String(failure.incidentId || failure.code || 'unknown');
      if (!seen[key]) {
        seen[key] = true;
        combined.push(failure);
      }
    });
    return NotificationService.sendFinalFailureAlert(combined, {
      executionId: execution.executionId,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt
    });
  } catch (error) {
    SheetStore.appendLog({
      executionId: execution.executionId,
      level: 'ERROR',
      action: 'FINAL_FAILURE_ALERT',
      entity: 'run',
      result: 'FAILED',
      errorCode: error.code || 'ALERT_SEND_FAILED',
      message: YouTubeRetryRules.sanitizeMessage(error.message)
    });
    return { sent: false, reason: error.code || 'ALERT_SEND_FAILED' };
  }
}

function processYouTubeRun_(kind, options) {
  options = options || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    return {
      deferred: kind !== 'retry',
      handedOff: true,
      reason: 'RUN_ALREADY_ACTIVE',
      followUp: kind === 'retry' ? scheduleDeferredYouTubeRetry_() : scheduleDeferredYouTubeRegular_()
    };
  }
  var previous = readYouTubeRunState_();
  var execution = YouTubeTriggerRules.executionState(kind, previous, new Date());
  writeYouTubeRunState_(execution);
  try {
    var result = YouTubeService.scanAllChannels(options);
    execution.finishedAt = new Date().toISOString();
    execution.status = 'COMPLETED';
    execution.lastSuccessAt = execution.finishedAt;
    logYouTubeFailures_(result.errors, execution);
    result.notification = notifyYouTubeFailures_(result.errors, execution);
    clearYouTubeRunState_();
    result.retrySchedule = scheduleNextYouTubeRetry_();
    result.executionId = execution.executionId;
    SheetStore.appendLog({
      executionId: execution.executionId,
      level: 'INFO',
      action: 'MONITOR_RUN',
      entity: kind,
      result: result.disabled ? 'DISABLED' : 'COMPLETED',
      details: { channels: result.channels, created: result.created, errors: result.errors.length }
    });
    return result;
  } catch (error) {
    var failureState = YouTubeRetryRules.nextFailureState(previous, error, new Date());
    var failure = {
      rowNumber: 0,
      channelName: '',
      lastSuccessAt: previous.lastSuccessAt || '',
      code: failureState.lastErrorCode,
      message: failureState.lastError,
      retryable: failureState.retryable,
      finalFailure: failureState.finalFailure,
      retryCount: failureState.retryCount,
      nextRetryAt: failureState.nextRetryAt,
      incidentId: failureState.incidentId,
      notificationSentAt: failureState.notificationSentAt
    };
    execution.finishedAt = new Date().toISOString();
    Object.keys(failureState).forEach(function (key) { execution[key] = failureState[key]; });
    logYouTubeFailures_([failure], execution);
    var notification = notifyYouTubeFailures_([failure], execution);
    if (notification.sent) execution.notificationSentAt = execution.finishedAt;
    writeYouTubeRunState_(execution);
    var retrySchedule = scheduleNextYouTubeRetry_();
    return {
      disabled: false,
      channels: 0,
      created: 0,
      errors: [failure],
      notification: notification,
      retrySchedule: retrySchedule,
      executionId: execution.executionId
    };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function processYouTubeChannelTrigger() {
  return processYouTubeRun_('regular', { retryOnly: false });
}

function processYouTubeRetryTrigger() {
  removeProjectTriggersFor_('processYouTubeRetryTrigger');
  var runState = readYouTubeRunState_();
  return processYouTubeRun_('retry', { retryOnly: runState.status !== 'RETRY_WAIT' });
}

function processDeferredYouTubeRegularTrigger() {
  removeProjectTriggersFor_('processDeferredYouTubeRegularTrigger');
  return processYouTubeRun_('regular', { retryOnly: false });
}

function retryFailedYouTubeChannels() {
  var resetRows = YouTubeService.resetFinalFailedChannels();
  if (!resetRows.length) return { resetRows: [], message: 'No enabled FINAL_FAILURE channels were found.' };
  var result = processYouTubeRun_('manual', { retryOnly: true });
  result.resetRows = resetRows;
  return result;
}
