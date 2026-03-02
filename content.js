// Claude Context Tracker - Chrome Extension Content Script
// Runs in isolated world (separate from page JS / SES lockdown)

console.log('[CCT] Content script loaded');

// ── Config ──
var MAX_TOKENS = 200000;
var OVERHEAD = 6000;
var CHARS_PER_TOKEN = 3.5;
var POLL_MS = 2500;
var T_GREEN = 50, T_YELLOW = 70, T_ORANGE = 85, T_RED = 90, T_CRIT = 95;
var WARN_AT = 90;

// ── State ──
var estTokens = 0, pct = 0, msgCount = 0;
var summaryDone = false, lastConvId = null;
var minimized = false, expanded = false, uiOk = false;

// ── Credits State ──
var creditsData = null;
var creditsPrevRemaining = null;
var creditsConnected = false;
var sessionMessages = 0;
var lastMsgCount = 0;

// ── Rate Limits from Settings Page ──
var rateLimitsData = null;
var settingsScrapeInterval = null;

// ═══════════════════════════════════════════════════════════════
// TOKEN ESTIMATION - using actual claude.ai data-testid selectors
// ═══════════════════════════════════════════════════════════════
function getMessages() {
  var msgs = [];
  try {
    var userMsgs = document.querySelectorAll('[data-testid="user-message"]');
    var assistantMsgs = document.querySelectorAll(
      '[class*="font-claude"], .prose, [data-testid="chat-message-text"]'
    );

    for (var i = 0; i < userMsgs.length; i++) {
      var t = (userMsgs[i].innerText || '').trim();
      if (t) msgs.push({ role: 'human', text: t });
    }

    for (var j = 0; j < assistantMsgs.length; j++) {
      var el = assistantMsgs[j];
      if (el.closest('main') || el.closest('[role="main"]')) {
        var t2 = (el.innerText || '').trim();
        if (t2 && t2.length > 5) msgs.push({ role: 'assistant', text: t2 });
      }
    }

    if (msgs.length > 0) return msgs;

    var main = document.querySelector('main') || document.querySelector('[role="main"]');
    if (main) {
      var blocks = main.querySelectorAll('article, [class*="Message"], [class*="message"], .prose, [data-testid*="message"]');
      for (var k = 0; k < blocks.length; k++) {
        var t3 = (blocks[k].innerText || '').trim();
        if (t3 && t3.length > 10) msgs.push({ role: 'unknown', text: t3 });
      }
    }
  } catch (e) {
    console.log('[CCT] getMessages error:', e);
  }
  return msgs;
}

function estimate() {
  var msgs = getMessages();
  var seen = {}, chars = 0, count = 0;
  for (var i = 0; i < msgs.length; i++) {
    var key = msgs[i].text.substring(0, 120);
    if (!seen[key]) {
      seen[key] = true;
      chars += msgs[i].text.length;
      count++;
    }
  }
  var tokens = count > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) + OVERHEAD : 0;
  return { tokens: tokens, count: count, chars: chars };
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY GENERATOR
// ═══════════════════════════════════════════════════════════════
function makeSummary() {
  var msgs = getMessages();
  var title = (document.title || '').replace(/\s*[-\u2013]\s*Claude\s*$/i, '').trim() || 'Claude Conversation';
  var d = new Date().toISOString().split('T')[0];
  var tm = new Date().toTimeString().substring(0, 5);

  var allTexts = msgs.map(function (m) { return m.text; });
  var first = allTexts.slice(0, 3).join('\n---\n').substring(0, 600);
  var last = allTexts.slice(-4).join('\n---\n').substring(0, 2500);

  var s = '# Conversation Summary - ' + d + ' ' + tm + '\n\n';
  s += '**Source**: ' + location.href + '\n';
  s += '**Title**: ' + title + '\n';
  s += '**Messages**: ' + msgs.length + '\n';
  s += '**Context**: ~' + Math.round(pct) + '% (~' + estTokens.toLocaleString() + ' tokens)\n\n---\n\n';
  s += '## Initial Context\n\n```\n' + first + '\n```\n\n';
  s += '## Where We Left Off\n\n```\n' + last + '\n```\n\n';
  s += '## Full Conversation\n\n';
  for (var i = 0; i < msgs.length; i++) {
    var role = msgs[i].role === 'human' ? 'Human' : 'Assistant';
    var m = msgs[i].text;
    if (m.length > 3000) m = m.substring(0, 3000) + '\n[...truncated...]';
    s += '### ' + role + ' (' + (i + 1) + ')\n\n' + m + '\n\n';
  }
  s += '---\n\n> Pour continuer: "Voici le resume de notre conv precedente. Lis-le et continuons."\n';
  return s;
}

function dlSummary() {
  try {
    var s = makeSummary();
    var fn = 'claude-summary-' + new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19) + '.md';
    var b = new Blob([s], { type: 'text/markdown;charset=utf-8' });
    var u = URL.createObjectURL(b);
    var a = document.createElement('a');
    a.href = u; a.download = fn; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 200);
    return fn;
  } catch (e) { return null; }
}

function cpSummary() {
  try {
    var s = makeSummary();
    navigator.clipboard.writeText(s);
    return true;
  } catch (e) {
    try {
      var ta = document.createElement('textarea');
      ta.value = makeSummary();
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select(); document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e2) { return false; }
  }
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════
function getColor(p) {
  if (p < T_GREEN) return '#8B9A6B';
  if (p < T_YELLOW) return '#B8976A';
  if (p < T_ORANGE) return '#C17A4A';
  if (p < T_RED) return '#C15F3C';
  return '#A8403A';
}

function getUsageColor(usedPct) {
  if (usedPct < 30) return '#8B9A6B';
  if (usedPct < 60) return '#B8976A';
  if (usedPct < 80) return '#C17A4A';
  if (usedPct < 95) return '#C15F3C';
  return '#A8403A';
}

function toast(msg) {
  var old = document.getElementById('cct-toast');
  if (old) old.remove();
  var el = document.createElement('div');
  el.id = 'cct-toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function () { el.style.opacity = '0'; }, 2000);
  setTimeout(function () { if (el.parentNode) el.remove(); }, 2500);
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS PAGE SCRAPING
// Detects when user visits /settings and extracts usage data
// Uses structural DOM approach: find section labels first, then
// extract percentage + reset text from their parent containers
// ═══════════════════════════════════════════════════════════════
function isSettingsPage() {
  return location.pathname.includes('/settings');
}

function getDirectText(el) {
  var text = '';
  for (var c = 0; c < el.childNodes.length; c++) {
    if (el.childNodes[c].nodeType === 3) {
      text += el.childNodes[c].textContent;
    }
  }
  return text.trim();
}

function scrapeSettingsUsage() {
  if (!isSettingsPage()) return null;

  try {
    var result = {
      session: null,
      weeklyAll: null,
      weeklySonnet: null
    };

    // Strategy 1: aria-based (progressbar elements)
    var progressBars = document.querySelectorAll('[role="progressbar"]');
    if (progressBars.length > 0) {
      console.log('[CCT] Found', progressBars.length, 'progressbar elements');
      for (var p = 0; p < progressBars.length; p++) {
        var bar = progressBars[p];
        var val = bar.getAttribute('aria-valuenow');
        var max = bar.getAttribute('aria-valuemax');
        console.log('[CCT] progressbar[' + p + '] valuenow=' + val + ' valuemax=' + max);
      }
    }

    // Strategy 2: Structural - find section label elements, then extract data nearby
    // Labels we look for (FR and EN)
    var labelMap = [
      { patterns: [/session\s+en\s+cours/i, /current\s+session/i], type: 'session' },
      { patterns: [/tous\s+les\s+mod[èe]les/i, /all\s+models/i], type: 'weeklyAll' },
      { patterns: [/sonnet\s+seulement/i, /sonnet\s+only/i], type: 'weeklySonnet' }
    ];

    // Walk the DOM tree looking for label elements
    var allEls = document.body.querySelectorAll('*');
    var foundLabels = [];

    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      var dt = getDirectText(el);
      if (!dt || dt.length > 50) continue; // Labels are short text

      for (var lm = 0; lm < labelMap.length; lm++) {
        var entry = labelMap[lm];
        for (var pp = 0; pp < entry.patterns.length; pp++) {
          if (entry.patterns[pp].test(dt)) {
            foundLabels.push({ type: entry.type, el: el, text: dt });
            console.log('[CCT] Found label:', entry.type, '=', dt, 'tag:', el.tagName);
            break;
          }
        }
      }
    }

    // For each found label, find its section container and extract data
    for (var f = 0; f < foundLabels.length; f++) {
      var label = foundLabels[f];
      var data = extractSectionData(label.el);
      if (data) {
        result[label.type] = data;
        console.log('[CCT] Extracted', label.type, ':', JSON.stringify(data));
      }
    }

    // Only return if we found at least something
    if (result.session || result.weeklyAll || result.weeklySonnet) {
      console.log('[CCT] Final scraped data:', JSON.stringify(result));
      return result;
    }

    // Strategy 3: Fallback - look for percentage patterns near progress bars
    // If no labels found, try to find progress elements and use their order
    if (foundLabels.length === 0) {
      console.log('[CCT] No labels found, trying fallback...');
      var fallback = scrapeFallback();
      if (fallback) return fallback;
    }

    console.log('[CCT] No usage data found on settings page');
  } catch (e) {
    console.log('[CCT] Settings scrape error:', e);
  }

  return null;
}

function extractSectionData(labelEl) {
  // From the label element, walk UP the DOM to find the section container
  // The container should have: a percentage text AND optionally a reset time
  // We walk up gradually, checking at each level if we find the data we need
  // But we STOP walking up before we reach a container that includes OTHER sections

  var container = labelEl.parentElement;
  var bestPct = null;
  var bestReset = '';

  for (var up = 0; up < 8 && container && container !== document.body; up++) {
    var text = container.textContent || '';

    // Look for percentage: "N % utilisés" or "N% used" or just "N %" near a bar
    var pctMatch = text.match(/(\d+)\s*%\s*(utilis[ée]s?|used)/i);
    if (!pctMatch) {
      // Also try standalone "N %" if near a progressbar
      pctMatch = text.match(/(\d+)\s*%/);
    }

    // Look for reset time
    var resetMatch = text.match(/(R[ée]initialisation|Resets?)\s+(dans\s+|in\s+)?(\d+\s*h\s*\d+\s*min|\d+\s*min|[a-zé]+\.?\s+\d{1,2}:\d{2})/i);

    if (pctMatch) {
      bestPct = parseInt(pctMatch[1]);
      if (resetMatch) {
        bestReset = resetMatch[3].trim();
      }

      // Check: does this container also include OTHER section labels?
      // If yes, we've gone too far up
      var containerText = text.toLowerCase();
      var labelCount = 0;
      if (containerText.match(/session\s+en\s+cours|current\s+session/i)) labelCount++;
      if (containerText.match(/tous\s+les\s+mod[èe]les|all\s+models/i)) labelCount++;
      if (containerText.match(/sonnet\s+seulement|sonnet\s+only/i)) labelCount++;

      if (labelCount <= 1) {
        // Good - this container belongs to just one section
        return { percentUsed: bestPct, resetText: bestReset };
      }
      // else: too broad, keep walking but use the data from a previous level
    }

    container = container.parentElement;
  }

  // If we found data but the container was always too broad, use the percentage
  // from the closest valid match
  if (bestPct !== null) {
    return { percentUsed: bestPct, resetText: bestReset };
  }

  return null;
}

function scrapeFallback() {
  // Fallback: find all elements containing "N % utilisés" or "N% used"
  // and map them by their position on the page (top to bottom)
  var result = { session: null, weeklyAll: null, weeklySonnet: null };

  var allEls = document.body.querySelectorAll('*');
  var pctElements = [];

  for (var i = 0; i < allEls.length; i++) {
    var dt = getDirectText(allEls[i]);
    var match = dt.match(/^(\d+)\s*%\s*(utilis[ée]s?|used)?$/i);
    if (match) {
      var rect = allEls[i].getBoundingClientRect();
      pctElements.push({
        pct: parseInt(match[1]),
        top: rect.top,
        el: allEls[i]
      });
    }
  }

  // Sort by vertical position (top to bottom)
  pctElements.sort(function(a, b) { return a.top - b.top; });

  console.log('[CCT] Fallback found', pctElements.length, 'percentage elements:', pctElements.map(function(p) { return p.pct + '% @' + Math.round(p.top); }));

  if (pctElements.length >= 3) {
    result.session = { percentUsed: pctElements[0].pct, resetText: '' };
    result.weeklyAll = { percentUsed: pctElements[1].pct, resetText: '' };
    result.weeklySonnet = { percentUsed: pctElements[2].pct, resetText: '' };
    return result;
  } else if (pctElements.length === 2) {
    result.weeklyAll = { percentUsed: pctElements[0].pct, resetText: '' };
    result.weeklySonnet = { percentUsed: pctElements[1].pct, resetText: '' };
    return result;
  }

  return null;
}

function sendSettingsData(data) {
  try {
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'CCT_SETTINGS_DATA',
        data: data
      });
    }
  } catch (e) {
    console.log('[CCT] Send settings data error:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// CREDITS TRACKING
// ═══════════════════════════════════════════════════════════════
function detectModel() {
  try {
    var btn = document.querySelector('[data-testid="model-selector-dropdown"]');
    if (btn) return (btn.textContent || '').trim();
  } catch (e) {}
  return null;
}

function getCreditsColor(remainingPct) {
  if (remainingPct > 70) return '#8B9A6B';
  if (remainingPct > 40) return '#B8976A';
  if (remainingPct > 20) return '#C17A4A';
  if (remainingPct > 5) return '#C15F3C';
  return '#A8403A';
}

function refreshCredits(data) {
  if (!uiOk) return;
  creditsData = data;

  var dot = document.getElementById('cct-credits-dot');
  var pctEl = document.getElementById('cct-credits-pct');
  var resetEl = document.getElementById('cct-credits-reset');
  var barFill = document.getElementById('cct-credits-bar-fill');

  if (!dot || !pctEl || !resetEl || !barFill) return;

  var hasRealData = data && data.type === 'api'
    && data.messagesLimit !== null && data.messagesLimit > 0
    && data.messagesRemaining !== null;

  var isRateLimited = data && data.type === 'dom'
    && data.percentUsed === 100;

  if (!hasRealData && !isRateLimited) {
    updateSessionDisplay();
    return;
  }

  creditsConnected = true;
  dot.className = 'cct-dot cct-dot-live';

  var remaining;
  if (isRateLimited) {
    remaining = 0;
  } else {
    remaining = Math.round((data.messagesRemaining / data.messagesLimit) * 100);
    remaining = Math.min(100, Math.max(0, remaining));
  }

  var c = getCreditsColor(remaining);

  if (creditsPrevRemaining !== null && creditsPrevRemaining < 30 && remaining > 70) {
    celebrateRecharge();
  }
  creditsPrevRemaining = remaining;

  barFill.style.width = remaining + '%';
  barFill.style.background = c;

  if (hasRealData) {
    pctEl.textContent = data.messagesRemaining + '/' + data.messagesLimit + ' remaining';
  } else {
    pctEl.textContent = 'Limit reached';
  }
  pctEl.style.color = c;

  if (data.resetAt) {
    updateResetTimer(data.resetAt);
  } else if (data.resetSeconds && data.lastUpdated) {
    var resetTime = new Date(data.lastUpdated + data.resetSeconds * 1000);
    updateResetTimer(resetTime.toISOString());
  } else {
    resetEl.textContent = '';
  }
}

function updateResetTimer(isoDate) {
  var resetEl = document.getElementById('cct-credits-reset');
  if (!resetEl) return;

  var target = new Date(isoDate).getTime();
  var now = Date.now();
  var diff = Math.max(0, target - now);

  if (diff <= 0) {
    resetEl.textContent = '';
    return;
  }

  var h = Math.floor(diff / 3600000);
  var m = Math.floor((diff % 3600000) / 60000);

  if (h > 0) {
    resetEl.textContent = '\u21bb ' + h + 'h ' + m + 'm';
  } else if (m > 0) {
    resetEl.textContent = '\u21bb ' + m + 'min';
  } else {
    resetEl.textContent = '\u21bb <1min';
  }
}

function updateSessionDisplay() {
  var pctEl = document.getElementById('cct-credits-pct');
  var resetEl = document.getElementById('cct-credits-reset');
  var barFill = document.getElementById('cct-credits-bar-fill');
  var dot = document.getElementById('cct-credits-dot');
  if (!pctEl) return;

  dot.className = 'cct-dot cct-dot-live';
  barFill.style.width = '0%';

  var model = detectModel();
  var parts = [];
  if (msgCount > 0) parts.push(msgCount + ' msgs');
  if (model) parts.push(model);

  pctEl.textContent = parts.length > 0 ? parts.join(' \u00b7 ') : '\u2014';
  pctEl.style.color = 'rgba(61, 57, 41, 0.5)';
  resetEl.textContent = '';
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMITS DISPLAY (from settings page scraping)
// ═══════════════════════════════════════════════════════════════
function refreshRateLimits(data) {
  if (!uiOk || !data) return;
  rateLimitsData = data;

  var container = document.getElementById('cct-limits');
  if (!container) return;

  // Check if we have any data
  var hasData = data.session || data.weeklyAll || data.weeklySonnet;
  if (!hasData) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';

  // Update each row
  updateLimitRow('session', data.session);
  updateLimitRow('weekly', data.weeklyAll);
  updateLimitRow('sonnet', data.weeklySonnet);
}

function updateLimitRow(id, limitData) {
  var row = document.getElementById('cct-limit-' + id);
  if (!row) return;

  if (!limitData) {
    row.style.display = 'none';
    return;
  }

  row.style.display = 'flex';

  var barFill = row.querySelector('.cct-limit-bar-fill');
  var pctEl = row.querySelector('.cct-limit-pct');
  var resetEl = row.querySelector('.cct-limit-reset');

  if (barFill) {
    var usedPct = limitData.percentUsed || 0;
    barFill.style.width = usedPct + '%';
    barFill.style.background = getUsageColor(usedPct);
  }

  if (pctEl) {
    pctEl.textContent = (limitData.percentUsed || 0) + '%';
    pctEl.style.color = getUsageColor(limitData.percentUsed || 0);
  }

  if (resetEl) {
    resetEl.textContent = limitData.resetText || '';
  }
}

function detectRateLimitDOM() {
  try {
    var selectors = [
      '[role="alert"]',
      '[role="dialog"]',
      '[class*="RateLimit"]',
      '[class*="rate-limit"]',
      '[class*="UsageLimit"]',
      '[class*="usage-limit"]',
      '[data-testid*="limit"]',
      '[data-testid*="rate"]'
    ];
    var found = false;
    var text = '';
    for (var i = 0; i < selectors.length; i++) {
      var els = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        var t = (els[j].innerText || '').toLowerCase();
        if (t.includes('message limit') || t.includes('usage limit') ||
            t.includes('try again') || t.includes('too many messages')) {
          found = true;
          text = t;
          break;
        }
      }
      if (found) break;
    }

    var input = document.querySelector('[data-testid="chat-input-ssr"]');
    if (input && input.disabled) {
      var placeholder = input.getAttribute('placeholder') || '';
      if (placeholder.toLowerCase().includes('limit') || placeholder.toLowerCase().includes('try again')) {
        found = true;
        text = placeholder.toLowerCase();
      }
    }

    if (!found) return null;

    var match = text.match(/try again in (\d+)\s*(hour|minute|min|h|m)/i);
    var secs = null;
    if (match) {
      var val = parseInt(match[1]);
      var unit = match[2].toLowerCase();
      secs = unit.startsWith('h') ? val * 3600 : val * 60;
    }

    try {
      chrome.runtime.sendMessage({
        type: 'CCT_RATE_LIMITED',
        resetSeconds: secs
      });
    } catch (e) {}

    return { rateLimited: true, resetSeconds: secs };
  } catch (e) {}
  return null;
}

// ═══════════════════════════════════════════════════════════════
// CELEBRATION ANIMATION (Cursor-style micro-interactions)
// ═══════════════════════════════════════════════════════════════
function celebrateRecharge() {
  if (!uiOk) return;

  var credits = document.getElementById('cct-credits');
  if (!credits) return;

  credits.classList.add('cct-celebrating');

  var recharged = document.getElementById('cct-recharged');
  if (recharged) recharged.classList.add('show');

  for (var i = 0; i < 8; i++) {
    createSparkle(credits, i);
  }

  setTimeout(function () {
    credits.classList.remove('cct-celebrating');
    if (recharged) recharged.classList.remove('show');
  }, 2500);

  toast('Credits recharged \u2728');
}

function createSparkle(parent, index) {
  var el = document.createElement('div');
  el.className = 'cct-sparkle';

  var angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
  var distance = 25 + Math.random() * 35;
  var endX = Math.cos(angle) * distance;
  var endY = Math.sin(angle) * distance;

  var colors = ['#D4A574', '#C15F3C', '#8B9A6B', '#B8976A', '#E8C5A0', '#A8403A'];
  el.style.background = colors[index % colors.length];

  el.style.left = (Math.random() * 100) + '%';
  el.style.top = '50%';
  el.style.setProperty('--sparkle-x', endX + 'px');
  el.style.setProperty('--sparkle-y', endY + 'px');

  var size = 3 + Math.random() * 4;
  el.style.width = size + 'px';
  el.style.height = size + 'px';

  el.style.animationDelay = (index * 0.07) + 's';

  parent.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.remove(); }, 2000);
}

// ═══════════════════════════════════════════════════════════════
// UI - Claude native design
// ═══════════════════════════════════════════════════════════════
function buildUI() {
  if (uiOk || document.getElementById('cct-root')) return;
  if (!document.body) return;

  console.log('[CCT] Building UI...');

  var root = document.createElement('div');
  root.id = 'cct-root';
  root.innerHTML =
    '<div id="cct-box">' +
      '<div id="cct-mini">0%</div>' +
      '<div id="cct-body">' +
        '<div id="cct-head">' +
          '<span id="cct-head-label">Context</span>' +
          '<div id="cct-controls">' +
            '<button id="cct-tog" title="Details">+</button>' +
            '<button id="cct-min" title="Minimize">\u2212</button>' +
          '</div>' +
        '</div>' +
        '<div id="cct-pct" style="color:#8B9A6B">0%</div>' +
        '<div id="cct-sub">Estimating...</div>' +
        '<div id="cct-bar-bg"><div id="cct-bar-fill" style="width:0%;background:#8B9A6B"></div></div>' +

        // Usage section (API rate limits)
        '<div id="cct-credits">' +
          '<div id="cct-credits-head">' +
            '<span class="cct-section-label">Usage</span>' +
            '<span id="cct-credits-dot" class="cct-dot cct-dot-live"></span>' +
          '</div>' +
          '<div id="cct-credits-bar-bg"><div id="cct-credits-bar-fill"></div></div>' +
          '<div id="cct-credits-info">' +
            '<span id="cct-credits-pct">\u2014</span>' +
            '<span id="cct-credits-reset"></span>' +
          '</div>' +
          '<div id="cct-recharged">Recharged \u2726</div>' +
        '</div>' +

        // Rate Limits section (from settings page)
        '<div id="cct-limits" style="display:none">' +
          '<div id="cct-limits-head">' +
            '<span class="cct-section-label">Limits</span>' +
            '<span id="cct-limits-dot" class="cct-dot cct-dot-live"></span>' +
          '</div>' +

          // Session row
          '<div id="cct-limit-session" class="cct-limit-row" style="display:none">' +
            '<span class="cct-limit-label">Session</span>' +
            '<div class="cct-limit-bar-bg"><div class="cct-limit-bar-fill"></div></div>' +
            '<span class="cct-limit-pct">0%</span>' +
            '<span class="cct-limit-reset"></span>' +
          '</div>' +

          // Weekly All row
          '<div id="cct-limit-weekly" class="cct-limit-row" style="display:none">' +
            '<span class="cct-limit-label">Weekly</span>' +
            '<div class="cct-limit-bar-bg"><div class="cct-limit-bar-fill"></div></div>' +
            '<span class="cct-limit-pct">0%</span>' +
            '<span class="cct-limit-reset"></span>' +
          '</div>' +

          // Sonnet row
          '<div id="cct-limit-sonnet" class="cct-limit-row" style="display:none">' +
            '<span class="cct-limit-label">Sonnet</span>' +
            '<div class="cct-limit-bar-bg"><div class="cct-limit-bar-fill"></div></div>' +
            '<span class="cct-limit-pct">0%</span>' +
            '<span class="cct-limit-reset"></span>' +
          '</div>' +
        '</div>' +

        '<div id="cct-extra">' +
          '<div><span>Tokens (est.)</span><span id="cct-tok">0</span></div>' +
          '<div><span>Messages</span><span id="cct-msg">0</span></div>' +
          '<div><span>Model</span><span id="cct-model">\u2014</span></div>' +
          '<div><span>Max</span><span>200K</span></div>' +
        '</div>' +
        '<div id="cct-btns">' +
          '<button class="cct-b cct-bp" id="cct-cp">Copy conversation summary</button>' +
          '<div id="cct-hint">Then open a new chat and paste to continue</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);

  // Warning banner
  var warn = document.createElement('div');
  warn.id = 'cct-warn';
  warn.innerHTML =
    '<h4>Running out of context</h4>' +
    '<p>~<span id="cct-wpct">90</span>% used. Copy a summary and continue in a new conversation.</p>' +
    '<div id="cct-warn-btns"><button class="cct-b cct-bp" id="cct-wcp">Copy summary</button><button class="cct-b" id="cct-wdis">Dismiss</button></div>';
  document.body.appendChild(warn);

  // ── Events ──
  document.getElementById('cct-min').addEventListener('click', function (e) {
    e.stopPropagation();
    minimized = !minimized;
    root.className = minimized ? 'mini' : '';
  });

  document.getElementById('cct-box').addEventListener('click', function () {
    if (minimized) { minimized = false; root.className = ''; }
  });

  document.getElementById('cct-tog').addEventListener('click', function (e) {
    e.stopPropagation();
    expanded = !expanded;
    document.getElementById('cct-extra').className = expanded ? 'on' : '';
    document.getElementById('cct-btns').className = expanded ? 'on' : '';
    this.textContent = expanded ? '\u2212' : '+';
  });

  document.getElementById('cct-cp').addEventListener('click', function () {
    if (cpSummary()) toast('Summary copied \u2014 open a new chat and paste');
  });

  document.getElementById('cct-wcp').addEventListener('click', function () {
    if (cpSummary()) toast('Summary copied \u2014 open a new chat and paste');
    document.getElementById('cct-warn').style.display = 'none';
  });

  document.getElementById('cct-wdis').addEventListener('click', function () {
    document.getElementById('cct-warn').style.display = 'none';
    summaryDone = true;
  });

  // Drag
  var dragging = false, dx = 0, dy = 0;
  document.getElementById('cct-head').addEventListener('mousedown', function (e) {
    if (minimized) return;
    dragging = true;
    var r = root.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    root.style.left = (e.clientX - dx) + 'px';
    root.style.top = (e.clientY - dy) + 'px';
    root.style.right = 'auto'; root.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', function () { dragging = false; });

  // Ctrl+Shift+K toggle
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'K') {
      e.preventDefault();
      minimized = !minimized;
      root.className = minimized ? 'mini' : '';
    }
  });

  uiOk = true;
  console.log('[CCT] UI ready');
}

// ═══════════════════════════════════════════════════════════════
// UPDATE DISPLAY
// ═══════════════════════════════════════════════════════════════
function refresh(tokens, p, count) {
  if (!uiOk) return;
  try {
    var c = getColor(p);
    var d = Math.min(100, Math.round(p));
    var rem = Math.max(0, (MAX_TOKENS - tokens) / 1000).toFixed(0);

    document.getElementById('cct-pct').textContent = d + '%';
    document.getElementById('cct-pct').style.color = c;
    document.getElementById('cct-mini').textContent = d + '%';
    document.getElementById('cct-mini').style.color = c;
    document.getElementById('cct-sub').textContent = '~' + rem + 'K tokens remaining';
    document.getElementById('cct-bar-fill').style.width = d + '%';
    document.getElementById('cct-bar-fill').style.background = c;
    document.getElementById('cct-tok').textContent = tokens.toLocaleString();
    document.getElementById('cct-msg').textContent = count;

    // Model info
    var modelEl = document.getElementById('cct-model');
    var model = detectModel();
    if (model && modelEl) modelEl.textContent = model;

    // Subtle border glow at high usage
    var box = document.getElementById('cct-box');
    box.style.borderColor = p > T_ORANGE
      ? 'rgba(193, 95, 60, 0.25)'
      : 'rgba(61, 57, 41, 0.1)';

    document.getElementById('cct-pct').className = p >= T_CRIT ? 'cct-pulse' : '';

    // Auto-expand at orange
    if (p >= T_ORANGE && !expanded) {
      expanded = true;
      document.getElementById('cct-extra').className = 'on';
      document.getElementById('cct-btns').className = 'on';
      document.getElementById('cct-tog').textContent = '\u2212';
    }

    // Warning popup
    if (p >= WARN_AT && !summaryDone) {
      document.getElementById('cct-wpct').textContent = d;
      document.getElementById('cct-warn').style.display = 'block';
      summaryDone = true;
    }
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// TICK
// ═══════════════════════════════════════════════════════════════
function tick() {
  try {
    // Detect conversation change
    var m = location.href.match(/\/chat\/([a-f0-9-]+)/i);
    var cid = m ? m[1] : null;
    if (cid !== lastConvId) {
      lastConvId = cid;
      summaryDone = false;
      if (cid) sessionMessages = 0;
    }

    var d = estimate();
    estTokens = d.tokens;
    pct = (d.tokens / MAX_TOKENS) * 100;
    msgCount = d.count;

    // Track session messages
    if (d.count > lastMsgCount && lastMsgCount > 0) {
      sessionMessages += (d.count - lastMsgCount);
    }
    lastMsgCount = d.count;

    refresh(d.tokens, pct, d.count);

    // Update credits/usage section
    if (creditsConnected && creditsData) {
      refreshCredits(creditsData);
    } else {
      updateSessionDisplay();
    }

    // Update rate limits section (from settings page data)
    if (rateLimitsData) {
      refreshRateLimits(rateLimitsData);
    }

    // If we're on the settings page, try to scrape usage data
    if (isSettingsPage()) {
      var scraped = scrapeSettingsUsage();
      if (scraped) {
        rateLimitsData = scraped;
        refreshRateLimits(scraped);
        sendSettingsData(scraped);
      }
    }

    // Check for rate limit indicators in the DOM
    detectRateLimitDOM();
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
function start() {
  console.log('[CCT] Starting...');
  if (!document.body) { setTimeout(start, 500); return; }
  if (document.getElementById('cct-root')) return;

  try {
    buildUI();
    tick();
    setInterval(tick, POLL_MS);

    // Watch for DOM changes (new messages)
    var target = document.querySelector('main') || document.body;
    var deb = null;
    new MutationObserver(function () {
      clearTimeout(deb);
      deb = setTimeout(tick, 400);
    }).observe(target, { childList: true, subtree: true });

    // ── Chrome runtime integration ──
    try {
      // Listen for usage updates from background
      if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(function (msg) {
          if (msg.type === 'CCT_USAGE_UPDATE') {
            refreshCredits(msg.data);
            if (msg.rateLimits) {
              rateLimitsData = msg.rateLimits;
              refreshRateLimits(msg.rateLimits);
            }
          }
        });
      }

      // Listen for storage changes (backup channel)
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener(function (changes) {
          if (changes.cctUsageData && changes.cctUsageData.newValue) {
            refreshCredits(changes.cctUsageData.newValue);
          }
          if (changes.cctRateLimits && changes.cctRateLimits.newValue) {
            rateLimitsData = changes.cctRateLimits.newValue;
            refreshRateLimits(changes.cctRateLimits.newValue);
          }
        });
      }

      // Request initial data
      if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CCT_GET_USAGE' }, function (resp) {
          if (chrome.runtime.lastError) return;
          if (resp && resp.data) refreshCredits(resp.data);
          if (resp && resp.rateLimits) {
            rateLimitsData = resp.rateLimits;
            refreshRateLimits(resp.rateLimits);
          }
        });
      }

      // Report detected model
      var model = detectModel();
      if (model && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CCT_MODEL_INFO', model: model });
      }
    } catch (e) {
      console.log('[CCT] chrome.runtime setup error:', e);
    }

    // If on settings page, scrape immediately and then periodically
    if (isSettingsPage()) {
      setTimeout(function() {
        var scraped = scrapeSettingsUsage();
        if (scraped) {
          rateLimitsData = scraped;
          refreshRateLimits(scraped);
          sendSettingsData(scraped);
        }
      }, 2000);

      // Re-scrape every 30s while on settings page
      settingsScrapeInterval = setInterval(function() {
        if (!isSettingsPage()) {
          clearInterval(settingsScrapeInterval);
          return;
        }
        var scraped = scrapeSettingsUsage();
        if (scraped) {
          rateLimitsData = scraped;
          refreshRateLimits(scraped);
          sendSettingsData(scraped);
        }
      }, 30000);
    }

    console.log('[CCT] v2.3 running');
  } catch (e) {
    console.error('[CCT] Init error:', e);
    setTimeout(start, 3000);
  }
}

// Wait for SPA to render
setTimeout(start, 1500);
