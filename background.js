// Claude Context Tracker - Background Service Worker
// Intercepts API responses for rate limit data and fetches usage info

console.log('[CCT-BG] Service worker loaded');

// ── State ──
var orgId = null;
var usageData = {
  type: null,
  messagesLimit: null,
  messagesRemaining: null,
  tokensLimit: null,
  tokensRemaining: null,
  resetAt: null,
  resetSeconds: null,
  percentUsed: null,
  percentRemaining: null,
  model: null,
  planType: null,
  lastUpdated: null
};
var headerCache = {};
var discoveryDone = false;

// ═══════════════════════════════════════════════════════════════
// WebRequest: Capture org_id + rate limit headers
// ═══════════════════════════════════════════════════════════════

chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    if (!orgId) {
      var m = details.url.match(/\/api\/organizations\/([a-f0-9-]+)/);
      if (m) {
        orgId = m[1];
        console.log('[CCT-BG] org_id:', orgId);
        chrome.storage.local.set({ cctOrgId: orgId });
        if (!discoveryDone) {
          discoveryDone = true;
          tryFetchUsage();
        }
      }
    }
  },
  { urls: ["https://claude.ai/api/*"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    var rl = {};
    var headers = details.responseHeaders || [];

    for (var i = 0; i < headers.length; i++) {
      var name = headers[i].name.toLowerCase();
      if (name.includes('ratelimit') || name.includes('rate-limit') ||
          name.includes('retry-after') || name.includes('x-limit') ||
          name.includes('quota') || name.includes('remaining')) {
        rl[name] = headers[i].value;
      }
    }

    if (Object.keys(rl).length > 0) {
      console.log('[CCT-BG] Rate limit headers:', rl);
      headerCache = rl;
      parseHeaders(rl);
      pushUpdate();
    }

    // 429 = rate limited
    if (details.statusCode === 429) {
      console.log('[CCT-BG] 429 Rate Limited!');
      usageData.messagesRemaining = 0;
      usageData.percentUsed = 100;
      usageData.percentRemaining = 0;
      usageData.type = 'api';

      for (var j = 0; j < headers.length; j++) {
        if (headers[j].name.toLowerCase() === 'retry-after') {
          var secs = parseInt(headers[j].value);
          if (!isNaN(secs)) {
            usageData.resetSeconds = secs;
            usageData.resetAt = new Date(Date.now() + secs * 1000).toISOString();
          }
          break;
        }
      }

      usageData.lastUpdated = Date.now();
      pushUpdate();
    }
  },
  { urls: ["https://claude.ai/api/*"] },
  ["responseHeaders"]
);

function parseHeaders(h) {
  for (var key in h) {
    var val = h[key];
    if (key.includes('remaining') && key.includes('request')) {
      usageData.messagesRemaining = parseInt(val);
    } else if (key.includes('remaining') && key.includes('token')) {
      usageData.tokensRemaining = parseInt(val);
    } else if (key.includes('limit') && !key.includes('remaining') && key.includes('request')) {
      usageData.messagesLimit = parseInt(val);
    } else if (key.includes('limit') && !key.includes('remaining') && key.includes('token')) {
      usageData.tokensLimit = parseInt(val);
    } else if (key.includes('reset')) {
      var num = parseInt(val);
      if (!isNaN(num) && num < 100000) {
        usageData.resetSeconds = num;
        usageData.resetAt = new Date(Date.now() + num * 1000).toISOString();
      } else {
        usageData.resetAt = val;
      }
    } else if (key.includes('remaining')) {
      usageData.messagesRemaining = parseInt(val);
    } else if (key.includes('limit') && !key.includes('remaining')) {
      usageData.messagesLimit = parseInt(val);
    }
  }

  if (usageData.messagesLimit && usageData.messagesRemaining !== null) {
    usageData.percentUsed = Math.round(
      ((usageData.messagesLimit - usageData.messagesRemaining) / usageData.messagesLimit) * 100
    );
    usageData.percentRemaining = 100 - usageData.percentUsed;
  }

  usageData.type = 'api';
  usageData.lastUpdated = Date.now();
}

// ═══════════════════════════════════════════════════════════════
// Direct API fetching
// ═══════════════════════════════════════════════════════════════

async function discoverOrgId() {
  try {
    var resp = await fetch('https://claude.ai/api/auth/session', { credentials: 'include' });
    if (resp.ok) {
      var data = await resp.json();
      console.log('[CCT-BG] Session data keys:', Object.keys(data));

      // Try common structures
      if (data.account && data.account.memberships) {
        for (var i = 0; i < data.account.memberships.length; i++) {
          var membership = data.account.memberships[i];
          var org = membership.organization;
          if (org && org.uuid) {
            orgId = org.uuid;
            console.log('[CCT-BG] org_id from session:', orgId);
            chrome.storage.local.set({ cctOrgId: orgId });
            return true;
          }
        }
      }

      // Alternative structures
      if (data.uuid) { orgId = data.uuid; return true; }
      if (data.organization_id) { orgId = data.organization_id; return true; }
      if (data.org_id) { orgId = data.org_id; return true; }

      // Store raw for debugging
      chrome.storage.local.set({ cctSessionRaw: JSON.stringify(data).substring(0, 3000) });
    }
  } catch (e) {
    console.log('[CCT-BG] Session fetch error:', e.message);
  }
  return false;
}

async function tryFetchUsage() {
  if (!orgId) {
    var found = await discoverOrgId();
    if (!found) {
      console.log('[CCT-BG] Could not discover org_id');
      return;
    }
  }

  console.log('[CCT-BG] Fetching usage for org:', orgId);

  var endpoints = [
    '/api/organizations/' + orgId + '/rate_limiter/usage',
    '/api/organizations/' + orgId + '/usage',
    '/api/organizations/' + orgId + '/stats',
    '/api/organizations/' + orgId + '/settings/billing',
    '/api/organizations/' + orgId + '/settings',
  ];

  for (var i = 0; i < endpoints.length; i++) {
    try {
      var url = 'https://claude.ai' + endpoints[i];
      var resp = await fetch(url, { credentials: 'include' });

      if (resp.ok) {
        var data = await resp.json();
        console.log('[CCT-BG] Data from', endpoints[i], ':', JSON.stringify(data).substring(0, 500));
        processApiResponse(data, endpoints[i]);
        return;
      } else {
        console.log('[CCT-BG]', endpoints[i], '->', resp.status);
      }
    } catch (e) {
      console.log('[CCT-BG]', endpoints[i], 'error:', e.message);
    }
  }

  console.log('[CCT-BG] No usage endpoint found');
}

function processApiResponse(data, endpoint) {
  // Only extract rate limit data from explicitly rate-limit-shaped responses
  // Must have BOTH a limit number AND a remaining number to be valid
  var limit = null;
  var remaining = null;
  var resetAt = null;

  // Check nested objects that look like rate limit data
  var sources = [data, data.rate_limit, data.rateLimit, data.usage];

  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    if (!src || typeof src !== 'object') continue;

    // Need explicit rate-limit-named fields (not generic "remaining" or "limit")
    var foundLimit = src.messages_limit || src.messagesLimit || src.message_limit;
    var foundRemaining = src.messages_remaining !== undefined ? src.messages_remaining
      : (src.messagesRemaining !== undefined ? src.messagesRemaining : undefined);

    if (foundLimit && foundRemaining !== undefined) {
      limit = parseInt(foundLimit);
      remaining = parseInt(foundRemaining);
      break;
    }
  }

  // Also check for reset times
  for (var j = 0; j < sources.length; j++) {
    var s = sources[j];
    if (!s || typeof s !== 'object') continue;
    if (s.resetAt || s.reset_at || s.reset_time) {
      resetAt = s.resetAt || s.reset_at || s.reset_time;
      break;
    }
  }

  // Only update if we found valid data (both limit AND remaining)
  if (limit > 0 && remaining !== null && !isNaN(remaining)) {
    usageData.messagesLimit = limit;
    usageData.messagesRemaining = remaining;
    usageData.percentUsed = Math.round(((limit - remaining) / limit) * 100);
    usageData.percentRemaining = 100 - usageData.percentUsed;
    if (resetAt) usageData.resetAt = resetAt;
    usageData.type = 'api';
    usageData.lastUpdated = Date.now();

    chrome.storage.local.set({ cctUsageData: usageData });
    pushUpdate();
  }

  // Always store raw for debugging
  chrome.storage.local.set({
    cctRawApi: JSON.stringify(data).substring(0, 2000),
    cctRawEndpoint: endpoint
  });
}

// ═══════════════════════════════════════════════════════════════
// Push updates to content scripts
// ═══════════════════════════════════════════════════════════════

function pushUpdate() {
  chrome.storage.local.set({ cctUsageData: usageData });

  chrome.tabs.query({ url: "https://claude.ai/*" }, function(tabs) {
    for (var i = 0; i < tabs.length; i++) {
      chrome.tabs.sendMessage(tabs[i].id, {
        type: 'CCT_USAGE_UPDATE',
        data: usageData
      }).catch(function() {});
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Message handler
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'CCT_GET_USAGE') {
    sendResponse({ data: usageData, headers: headerCache, orgId: orgId });
    return true;
  }

  if (msg.type === 'CCT_REFRESH_USAGE') {
    tryFetchUsage();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CCT_MODEL_INFO') {
    usageData.model = msg.model;
    chrome.storage.local.set({ cctUsageData: usageData });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CCT_RATE_LIMITED') {
    usageData.messagesRemaining = 0;
    usageData.percentUsed = 100;
    usageData.percentRemaining = 0;
    usageData.type = 'dom';
    if (msg.resetSeconds) {
      usageData.resetSeconds = msg.resetSeconds;
      usageData.resetAt = new Date(Date.now() + msg.resetSeconds * 1000).toISOString();
    }
    usageData.lastUpdated = Date.now();
    pushUpdate();
    sendResponse({ ok: true });
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════
// Periodic refresh
// ═══════════════════════════════════════════════════════════════

chrome.alarms.create('cct-refresh', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name === 'cct-refresh') {
    tryFetchUsage();
  }
});

// On install
chrome.runtime.onInstalled.addListener(function() {
  console.log('[CCT-BG] Installed/updated');
  chrome.storage.local.set({ cctUsageData: usageData });
});

// Try to discover org on startup
setTimeout(function() {
  if (!orgId) discoverOrgId().then(function(found) {
    if (found) tryFetchUsage();
  });
}, 3000);
