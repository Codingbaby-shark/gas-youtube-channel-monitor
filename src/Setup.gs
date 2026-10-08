/** Setup and regular trigger management entry points. */
function initializeYouTubeMonitor() {
  var result = SheetStore.initialize();
  SheetStore.appendLog({
    action: 'INITIALIZE',
    entity: 'spreadsheet',
    result: 'COMPLETED',
    details: { sheets: result.sheets }
  });
  return result;
}

function installYouTubeMonitorTriggers() {
  var settings = MonitorConfig.getSettings();
  removeProjectTriggersFor_('processYouTubeChannelTrigger');
  var created = settings.regularRunHours.map(function (hour) {
    ScriptApp.newTrigger('processYouTubeChannelTrigger').timeBased().everyDays(1).atHour(hour).create();
    return 'processYouTubeChannelTrigger@' + hour;
  });
  SheetStore.appendLog({
    action: 'INSTALL_TRIGGERS',
    entity: 'project',
    result: 'COMPLETED',
    details: { handlers: created }
  });
  return { created: created };
}

function runYouTubeMonitorNow() {
  return processYouTubeRun_('manual', { retryOnly: false });
}
