/** Retry rules shared by channel-level and whole-run failures. */
var YouTubeRetryRules = (function () {
  var DELAYS_MINUTES = [5, 15, 30];
  var RETRYABLE_CODES = {
    NETWORK_TIMEOUT: true,
    GOOGLE_SERVER_ERROR: true,
    YOUTUBE_RATE_LIMIT: true,
    YOUTUBE_API_SERVER_ERROR: true
  };

  function sanitizeMessage(value) {
    return String(value || 'Unknown error')
      .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/(AIza)[A-Za-z0-9_-]{20,}/g, '$1[REDACTED]')
      .slice(0, 1000);
  }

  function classify(error) {
    var message = sanitizeMessage(error && error.message || error);
    var code = String(error && error.code || 'YOUTUBE_SCAN_FAILED');
    var retryable = error && typeof error.retryable === 'boolean'
      ? error.retryable
      : Boolean(RETRYABLE_CODES[code]);
    if (!retryable && /(timed?\s*out|timeout|시간 초과)/i.test(message)) {
      code = 'NETWORK_TIMEOUT';
      retryable = true;
    } else if (!retryable && /(server error|server not available|try again later)/i.test(message)) {
      code = 'GOOGLE_SERVER_ERROR';
      retryable = true;
    }
    return { code: code, message: message, retryable: retryable };
  }

  function nextFailureState(current, error, now) {
    current = current || {};
    now = now || new Date();
    var failure = classify(error);
    var attempts = Number(current.retryCount || 0);
    var incidentId = String(current.incidentId || '');
    var notificationSentAt = String(current.notificationSentAt || '');
    if (!incidentId) {
      incidentId = typeof Utilities !== 'undefined' && Utilities.getUuid
        ? Utilities.getUuid()
        : 'incident-' + now.getTime();
      notificationSentAt = '';
    }
    var base = {
      status: 'FINAL_FAILURE',
      retryCount: attempts,
      nextRetryAt: '',
      lastFailureAt: now.toISOString(),
      lastErrorCode: failure.code,
      lastError: failure.message,
      incidentId: incidentId,
      notificationSentAt: notificationSentAt,
      retryable: failure.retryable,
      finalFailure: true
    };
    if (!failure.retryable || attempts >= DELAYS_MINUTES.length) return base;
    var delayMinutes = DELAYS_MINUTES[attempts];
    base.status = 'RETRY_WAIT';
    base.retryCount = attempts + 1;
    base.nextRetryAt = new Date(now.getTime() + delayMinutes * 60000).toISOString();
    base.finalFailure = false;
    base.delayMinutes = delayMinutes;
    return base;
  }

  function isDue(channel, now) {
    if (String(channel && channel.status || '') !== 'RETRY_WAIT') return false;
    var due = new Date(channel.nextRetryAt);
    return !isNaN(due.getTime()) && due.getTime() <= (now || new Date()).getTime();
  }

  return {
    DELAYS_MINUTES: DELAYS_MINUTES.slice(),
    classify: classify,
    nextFailureState: nextFailureState,
    isDue: isDue,
    sanitizeMessage: sanitizeMessage
  };
}());

/** YouTube Data API client and checkpointed channel scanner. */
var YouTubeService = (function () {
  var API_BASE = 'https://www.googleapis.com/youtube/v3/';
  var RUN_BUDGET_MS = 270000;
  var MAX_VIDEOS_PER_RUN = 50;

  function todayKey(timeZone) {
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      return Utilities.formatDate(new Date(), timeZone || 'Asia/Seoul', 'yyyyMMdd');
    }
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  function consumeQuota(units, settings) {
    var properties = MonitorConfig.getPropertyStore();
    var key = MonitorConfig.PROPERTIES.quotaPrefix + todayKey(settings.timeZone);
    var used = Number(properties.getProperty(key) || 0);
    if (used + units > settings.dailyQuotaGuard) {
      var error = new Error('The configured daily YouTube API quota guard has been reached.');
      error.code = 'YOUTUBE_QUOTA_GUARD';
      error.retryable = false;
      throw error;
    }
    properties.setProperty(key, String(used + units));
  }

  function apiGet(resource, params, settings) {
    if (!settings.apiKey) {
      var missing = new Error('The YOUTUBE_API_KEY Script Property is required.');
      missing.code = 'YOUTUBE_API_KEY_MISSING';
      missing.retryable = false;
      throw missing;
    }
    consumeQuota(1, settings);
    var query = Object.keys(params || {}).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    });
    query.push('key=' + encodeURIComponent(settings.apiKey));
    var response;
    try {
      response = UrlFetchApp.fetch(API_BASE + resource + '?' + query.join('&'), {
        method: 'get',
        followRedirects: true,
        muteHttpExceptions: true
      });
    } catch (fetchError) {
      var network = YouTubeRetryRules.classify(fetchError);
      var wrapped = new Error(network.message);
      wrapped.code = network.code;
      wrapped.retryable = network.retryable;
      throw wrapped;
    }
    var status = Number(response.getResponseCode());
    var body;
    try { body = JSON.parse(response.getContentText() || '{}'); } catch (ignore) { body = {}; }
    if (status < 200 || status >= 300) {
      var apiMessage = body && body.error && body.error.message
        ? YouTubeRetryRules.sanitizeMessage(body.error.message)
        : 'YouTube API request failed.';
      var error = new Error(apiMessage + ' HTTP ' + status + '.');
      error.code = status === 429
        ? 'YOUTUBE_RATE_LIMIT'
        : status >= 500
          ? 'YOUTUBE_API_SERVER_ERROR'
          : status === 403
            ? 'YOUTUBE_API_FORBIDDEN'
            : 'YOUTUBE_API_FAILED';
      error.retryable = status === 429 || status >= 500;
      throw error;
    }
    return body;
  }

  function channelLookupParams(channelUrl) {
    var text = String(channelUrl || '').trim();
    var idMatch = /\/channel\/(UC[\w-]+)/i.exec(text);
    if (idMatch) return { id: idMatch[1] };
    var handleMatch = /(?:youtube\.com\/)?@([^/?#]+)/i.exec(text);
    if (handleMatch) return { forHandle: handleMatch[1] };
    if (/^UC[\w-]+$/.test(text)) return { id: text };
    if (/^@[^/?#]+$/.test(text)) return { forHandle: text.slice(1) };
    var error = new Error('Use a /channel/UC... URL, an @handle, or a raw UC... channel ID.');
    error.code = 'YOUTUBE_CHANNEL_URL_INVALID';
    error.retryable = false;
    throw error;
  }

  function resolveChannel(channel, settings) {
    if (channel.channelId && channel.uploadsPlaylistId) return channel;
    var params = channelLookupParams(channel.channelUrl);
    params.part = 'snippet,contentDetails';
    var response = apiGet('channels', params, settings);
    var item = (response.items || [])[0];
    if (!item) {
      var error = new Error('The configured YouTube channel could not be found.');
      error.code = 'YOUTUBE_CHANNEL_NOT_FOUND';
      error.retryable = false;
      throw error;
    }
    var patch = {
      channelName: channel.channelName || item.snippet && item.snippet.title || '',
      channelId: item.id || '',
      uploadsPlaylistId: item.contentDetails && item.contentDetails.relatedPlaylists
        ? item.contentDetails.relatedPlaylists.uploads || ''
        : ''
    };
    SheetStore.updateChannel(channel.rowNumber, patch);
    Object.keys(patch).forEach(function (key) { channel[key] = patch[key]; });
    return channel;
  }

  function validDate(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function cutoffFor(channel, settings, scanStartedAt) {
    var checkpoint = validDate(channel.lastSuccessAt);
    if (checkpoint) return checkpoint;
    return new Date(scanStartedAt.getTime() - settings.initialLookbackDays * 86400000);
  }

  function withinWindow(value, cutoff, scanStartedAt) {
    var published = validDate(value);
    return Boolean(published && published.getTime() > cutoff.getTime() && published.getTime() <= scanStartedAt.getTime());
  }

  function playlistVideoId(item) {
    return item && item.contentDetails && item.contentDetails.videoId ||
      item && item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId || '';
  }

  function playlistPublishedAt(item) {
    return item && item.contentDetails && item.contentDetails.videoPublishedAt ||
      item && item.snippet && item.snippet.publishedAt || '';
  }

  function loadPlaylistItems(channel, settings, cutoff, deadline) {
    var items = [];
    var pageToken = '';
    var reachedCheckpoint = false;
    var pageCount = 0;
    do {
      var params = {
        part: 'snippet,contentDetails',
        playlistId: channel.uploadsPlaylistId,
        maxResults: 50
      };
      if (pageToken) params.pageToken = pageToken;
      var page = apiGet('playlistItems', params, settings);
      var pageItems = page.items || [];
      items = items.concat(pageItems);
      reachedCheckpoint = pageItems.some(function (item) {
        var published = validDate(playlistPublishedAt(item));
        return published && published.getTime() <= cutoff.getTime();
      });
      pageToken = String(page.nextPageToken || '');
      pageCount += 1;
    } while (pageToken && !reachedCheckpoint && pageCount < 10 && Date.now() <= deadline);
    return {
      items: items,
      truncated: Boolean(pageToken && !reachedCheckpoint)
    };
  }

  function videoDetails(ids, settings) {
    if (!ids.length) return [];
    return apiGet('videos', {
      part: 'snippet,status',
      id: ids.slice(0, 50).join(',')
    }, settings).items || [];
  }

  function cleanDescription(value) {
    return String(value || '').replace(/https?:\/\/\S+/g, '').replace(/#[^\s#]+/g, '')
      .replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  }

  function appendVideo(channel, video, detectedAt) {
    if (!video || !video.id || SheetStore.hasVideoId(video.id)) return null;
    var snippet = video.snippet || {};
    return SheetStore.appendVideo({
      videoId: video.id,
      channelId: snippet.channelId || channel.channelId,
      channelName: snippet.channelTitle || channel.channelName,
      title: snippet.title || 'Untitled video',
      publishedAt: snippet.publishedAt || '',
      videoUrl: 'https://www.youtube.com/watch?v=' + encodeURIComponent(video.id),
      detectedAt: detectedAt.toISOString(),
      description: cleanDescription(snippet.description)
    });
  }

  function scanChannel(channel, settings, context) {
    context = context || {};
    var scanStartedAt = context.scanStartedAt || new Date();
    var deadline = context.deadline || scanStartedAt.getTime() + RUN_BUDGET_MS;
    channel = resolveChannel(channel, settings);
    var cutoff = cutoffFor(channel, settings, scanStartedAt);
    var playlist = loadPlaylistItems(channel, settings, cutoff, deadline);
    var items = playlist.items;
    var ids = [];
    items.forEach(function (item) {
      var videoId = playlistVideoId(item);
      if (!videoId || SheetStore.hasVideoId(videoId)) return;
      if (!withinWindow(playlistPublishedAt(item), cutoff, scanStartedAt)) return;
      ids.push(videoId);
    });
    var created = 0;
    var stopped = playlist.truncated || ids.length > 50;
    videoDetails(ids, settings).forEach(function (video) {
      if (Date.now() > deadline) { stopped = true; return; }
      if (video.status && video.status.privacyStatus !== 'public') return;
      if (!withinWindow(video.snippet && video.snippet.publishedAt, cutoff, scanStartedAt)) return;
      if (appendVideo(channel, video, scanStartedAt)) created += 1;
    });
    if (stopped) {
      return { channelName: channel.channelName, checked: items.length, created: created, stopped: true };
    }
    SheetStore.updateChannel(channel.rowNumber, {
      lastSuccessAt: scanStartedAt.toISOString(),
      lastVideoId: items.length ? playlistVideoId(items[0]) : channel.lastVideoId,
      status: 'OK',
      retryCount: 0,
      nextRetryAt: '',
      lastFailureAt: '',
      lastErrorCode: '',
      lastError: '',
      incidentId: '',
      notificationSentAt: ''
    });
    return { channelName: channel.channelName, checked: items.length, created: created, stopped: false };
  }

  function lastSuccessTime(channel) {
    var date = validDate(channel.lastSuccessAt);
    return date ? date.getTime() : 0;
  }

  function persistChannelFailure(rowNumber, failure) {
    return SheetStore.updateChannel(rowNumber, {
      status: failure.status,
      retryCount: failure.retryCount,
      nextRetryAt: failure.nextRetryAt,
      lastFailureAt: failure.lastFailureAt,
      lastErrorCode: failure.lastErrorCode,
      lastError: failure.lastError,
      incidentId: failure.incidentId,
      notificationSentAt: failure.notificationSentAt
    });
  }

  function scanAllChannels(options) {
    options = options || {};
    var settings = MonitorConfig.getSettings();
    if (!settings.enabled) return { disabled: true, channels: 0, created: 0, errors: [] };
    if (!settings.apiKey) {
      var missing = new Error('The YOUTUBE_API_KEY Script Property is required.');
      missing.code = 'YOUTUBE_API_KEY_MISSING';
      missing.retryable = false;
      throw missing;
    }
    var scanStartedAt = new Date();
    var deadline = Date.now() + RUN_BUDGET_MS;
    var channels = SheetStore.readChannels().filter(function (channel) {
      if (!channel.enabled) return false;
      if (options.retryOnly) return YouTubeRetryRules.isDue(channel, scanStartedAt);
      return channel.status !== 'FINAL_FAILURE' && channel.status !== 'RETRY_WAIT';
    }).sort(function (a, b) { return lastSuccessTime(a) - lastSuccessTime(b); });
    var results = [];
    var errors = [];
    var created = 0;
    var timeBudgetReached = false;
    for (var index = 0; index < channels.length && created < MAX_VIDEOS_PER_RUN; index++) {
      if (Date.now() > deadline) { timeBudgetReached = true; break; }
      var channel = channels[index];
      try {
        var result = scanChannel(channel, settings, { scanStartedAt: scanStartedAt, deadline: deadline });
        results.push(result);
        created += result.created;
        if (result.stopped) { timeBudgetReached = true; break; }
      } catch (error) {
        var failure = YouTubeRetryRules.nextFailureState(channel, error, new Date());
        persistChannelFailure(channel.rowNumber, failure);
        errors.push({
          rowNumber: channel.rowNumber,
          channelName: channel.channelName,
          lastSuccessAt: channel.lastSuccessAt,
          code: failure.lastErrorCode,
          message: failure.lastError,
          retryable: failure.retryable,
          finalFailure: failure.finalFailure,
          retryCount: failure.retryCount,
          nextRetryAt: failure.nextRetryAt,
          incidentId: failure.incidentId,
          notificationSentAt: failure.notificationSentAt
        });
      }
    }
    return {
      disabled: false,
      channels: results.length,
      created: created,
      remainingChannels: Math.max(0, channels.length - results.length - errors.length),
      timeBudgetReached: timeBudgetReached,
      results: results,
      errors: errors
    };
  }

  function resetFinalFailedChannels() {
    var rows = [];
    SheetStore.readChannels().forEach(function (channel) {
      if (!channel.enabled || channel.status !== 'FINAL_FAILURE') return;
      SheetStore.updateChannel(channel.rowNumber, {
        status: 'RETRY_WAIT',
        retryCount: 0,
        nextRetryAt: new Date().toISOString(),
        lastErrorCode: '',
        lastError: '',
        incidentId: '',
        notificationSentAt: ''
      });
      rows.push(channel.rowNumber);
    });
    return rows;
  }

  return {
    channelLookupParams: channelLookupParams,
    cleanDescription: cleanDescription,
    scanChannel: scanChannel,
    scanAllChannels: scanAllChannels,
    resetFinalFailedChannels: resetFinalFailedChannels,
    apiGet: apiGet
  };
}());
