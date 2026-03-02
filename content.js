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

  // Only trust data if we have REAL limit+remaining numbers from the API
  var hasRealData = data && data.type === 'api'
    && data.messagesLimit !== null && data.messagesLimit > 0
    && data.messagesRemaining !== null;

  // Rate limited from DOM detection (user hit the wall)
  var isRateLimited = data && data.type === 'dom'
    && data.percentUsed === 100;

  if (!hasRealData && !isRateLimited) {
    // No reliable data — show session counter
    pctEl.textContent = sessionMessages > 0
      ? sessionMessages + ' messages this session'
      : 'Connecting...';
    dot.className = creditsConnected ? 'cct-dot cct-dot-live' : 'cct-dot cct-dot-pending';
    barFill.style.width = '0%';
    resetEl.textContent = '';
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

  // Check for recharge (remaining jumps from low to high)
  if (creditsPrevRemaining !== null && creditsPrevRemaining < 30 && remaining > 70) {
    celebrateRecharge();
  }
  creditsPrevRemaining = remaining;

  // Animate the bar (shows remaining credits)
  barFill.style.width = remaining + '%';
  barFill.style.background = c;

  // Update text
  if (hasRealData) {
    pctEl.textContent = data.messagesRemaining + '/' + data.messagesLimit + ' remaining';
  } else {
    pctEl.textContent = 'Limit reached';
  }
  pctEl.style.color = c;

  // Reset timer
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

function detectRateLimitDOM() {
  try {
    // Only check specific UI elements — NOT conversation text
    // Claude shows rate limit banners/dialogs outside the conversation flow
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

    // Also check for the input being disabled with a rate limit message
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

  // Glow effect on section
  credits.classList.add('cct-celebrating');

  // Show "Recharged" label
  var recharged = document.getElementById('cct-recharged');
  if (recharged) recharged.classList.add('show');

  // Sparkle particles
  for (var i = 0; i < 8; i++) {
    createSparkle(credits, i);
  }

  // Clean up after animation
  setTimeout(function () {
    credits.classList.remove('cct-celebrating');
    if (recharged) recharged.classList.remove('show');
  }, 2500);

  toast('Credits recharged \u2728');
}

function createSparkle(parent, index) {
  var el = document.createElement('div');
  el.className = 'cct-sparkle';

  // Random upward direction with spread
  var angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
  var distance = 25 + Math.random() * 35;
  var endX = Math.cos(angle) * distance;
  var endY = Math.sin(angle) * distance;

  // Palette colors
  var colors = ['#D4A574', '#C15F3C', '#8B9A6B', '#B8976A', '#E8C5A0', '#A8403A'];
  el.style.background = colors[index % colors.length];

  // Random position along section width
  el.style.left = (Math.random() * 100) + '%';
  el.style.top = '50%';
  el.style.setProperty('--sparkle-x', endX + 'px');
  el.style.setProperty('--sparkle-y', endY + 'px');

  // Size variation
  var size = 3 + Math.random() * 4;
  el.style.width = size + 'px';
  el.style.height = size + 'px';

  // Stagger timing
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
        '<div id="cct-credits">' +
          '<div id="cct-credits-head">' +
            '<span class="cct-section-label">Credits</span>' +
            '<span id="cct-credits-dot" class="cct-dot cct-dot-pending"></span>' +
          '</div>' +
          '<div id="cct-credits-bar-bg"><div id="cct-credits-bar-fill"></div></div>' +
          '<div id="cct-credits-info">' +
            '<span id="cct-credits-pct">Connecting...</span>' +
            '<span id="cct-credits-reset"></span>' +
          '</div>' +
          '<div id="cct-recharged">Recharged \u2726</div>' +
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

    // Track session messages (count new user messages)
    if (d.count > lastMsgCount && lastMsgCount > 0) {
      sessionMessages += (d.count - lastMsgCount);
    }
    lastMsgCount = d.count;

    refresh(d.tokens, pct, d.count);

    // Update credits with session count when no API data
    if (!creditsConnected && uiOk) {
      var pctEl = document.getElementById('cct-credits-pct');
      if (pctEl && sessionMessages > 0) {
        pctEl.textContent = sessionMessages + ' messages this session';
      }
    }

    // Update reset countdown
    if (creditsData && creditsData.resetAt) {
      updateResetTimer(creditsData.resetAt);
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

    // ── Credits: chrome.runtime integration ──
    try {
      // Listen for usage updates from background
      if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(function (msg) {
          if (msg.type === 'CCT_USAGE_UPDATE') {
            refreshCredits(msg.data);
          }
        });
      }

      // Listen for storage changes (backup channel)
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener(function (changes) {
          if (changes.cctUsageData && changes.cctUsageData.newValue) {
            refreshCredits(changes.cctUsageData.newValue);
          }
        });
      }

      // Request initial usage data
      if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CCT_GET_USAGE' }, function (resp) {
          if (chrome.runtime.lastError) return;
          if (resp && resp.data) refreshCredits(resp.data);
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

    // Fallback: after 30s, show offline state if no credits data
    setTimeout(function () {
      if (!creditsConnected && uiOk) {
        var dot = document.getElementById('cct-credits-dot');
        if (dot) dot.className = 'cct-dot cct-dot-offline';
        var pctEl = document.getElementById('cct-credits-pct');
        if (pctEl && sessionMessages === 0) {
          pctEl.textContent = 'No data yet';
        }
      }
    }, 30000);

    console.log('[CCT] v2.1 running');
  } catch (e) {
    console.error('[CCT] Init error:', e);
    setTimeout(start, 3000);
  }
}

// Wait for SPA to render
setTimeout(start, 1500);
