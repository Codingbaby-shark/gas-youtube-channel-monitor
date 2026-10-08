/** Final-failure email alerts. Recipient addresses are never written to logs. */
var NotificationService = (function () {
  function recipients() {
    return String(MonitorConfig.getSettings().alertRecipients || '').split(',').map(function (entry) {
      return entry.trim();
    }).filter(Boolean);
  }

  function buildFailureAlert(failures, context) {
    context = context || {};
    var lines = [
      'YouTube Channel Content Monitor needs administrator attention.',
      '',
      'Execution ID: ' + String(context.executionId || 'unknown'),
      'Started At: ' + String(context.startedAt || ''),
      'Finished At: ' + String(context.finishedAt || new Date().toISOString()),
      ''
    ];
    failures.forEach(function (failure, index) {
      lines.push('Failure ' + (index + 1));
      lines.push('Channel: ' + String(failure.channelName || '(run-level failure)'));
      lines.push('Error Code: ' + String(failure.code || 'YOUTUBE_SCAN_FAILED'));
      lines.push('Retry Count: ' + String(failure.retryCount || 0));
      lines.push('Last Successful Checkpoint: ' + String(failure.lastSuccessAt || '(none)'));
      lines.push('Message: ' + YouTubeRetryRules.sanitizeMessage(failure.message));
      lines.push('');
    });
    lines.push('Fix the permanent cause, then use YouTube Monitor → Retry failed channels.');
    return {
      subject: '[YouTube monitor] ' + failures.length + ' final failure(s)',
      body: lines.join('\n')
    };
  }

  function sendFinalFailureAlert(failures, context) {
    var pending = (failures || []).filter(function (failure) {
      return failure.finalFailure && !failure.notificationSentAt;
    });
    if (!pending.length) return { sent: false, reason: 'NO_NEW_FINAL_FAILURES', recipientCount: 0 };
    var to = recipients();
    if (!to.length) {
      var missing = new Error('The ALERT_RECIPIENTS Script Property is required for final-failure email alerts.');
      missing.code = 'ALERT_RECIPIENTS_MISSING';
      throw missing;
    }
    var alert = buildFailureAlert(pending, context);
    MailApp.sendEmail({ to: to.join(','), subject: alert.subject, body: alert.body });
    var sentAt = new Date().toISOString();
    pending.forEach(function (failure) {
      if (failure.rowNumber) SheetStore.updateChannel(failure.rowNumber, { notificationSentAt: sentAt });
    });
    return { sent: true, recipientCount: to.length, failureCount: pending.length };
  }

  function unnotifiedChannelFailures() {
    return SheetStore.readChannels().filter(function (channel) {
      return channel.enabled && channel.status === 'FINAL_FAILURE' && !channel.notificationSentAt;
    }).map(function (channel) {
      return {
        rowNumber: channel.rowNumber,
        channelName: channel.channelName,
        lastSuccessAt: channel.lastSuccessAt,
        code: channel.lastErrorCode,
        message: channel.lastError,
        finalFailure: true,
        retryCount: channel.retryCount,
        incidentId: channel.incidentId,
        notificationSentAt: channel.notificationSentAt
      };
    });
  }

  return {
    buildFailureAlert: buildFailureAlert,
    sendFinalFailureAlert: sendFinalFailureAlert,
    unnotifiedChannelFailures: unnotifiedChannelFailures
  };
}());
