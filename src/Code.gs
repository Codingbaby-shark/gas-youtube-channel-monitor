/** Spreadsheet menu. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('YouTube Monitor')
    .addItem('Run now', 'runYouTubeMonitorFromMenu')
    .addItem('Retry failed channels', 'retryFailedYouTubeChannelsFromMenu')
    .addSeparator()
    .addItem('Install regular triggers', 'installYouTubeMonitorTriggersFromMenu')
    .addToUi();
}

function runYouTubeMonitorFromMenu() {
  var result = runYouTubeMonitorNow();
  SpreadsheetApp.getUi().alert('YouTube Monitor', JSON.stringify(result, null, 2), SpreadsheetApp.getUi().ButtonSet.OK);
}

function retryFailedYouTubeChannelsFromMenu() {
  var result = retryFailedYouTubeChannels();
  SpreadsheetApp.getUi().alert('YouTube Monitor', JSON.stringify(result, null, 2), SpreadsheetApp.getUi().ButtonSet.OK);
}

function installYouTubeMonitorTriggersFromMenu() {
  var result = installYouTubeMonitorTriggers();
  SpreadsheetApp.getUi().alert('YouTube Monitor', JSON.stringify(result, null, 2), SpreadsheetApp.getUi().ButtonSet.OK);
}
