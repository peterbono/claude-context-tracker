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

// ═══════════════════════════════════════════════════════════════
// TOKEN ESTIMATION - using actual claude.ai data-testid selectors
// ═══════════════════════════════════════════════════════════════
function getMessages() {
  var msgs = [];
  try {
    // Primary: user-message data-testid (confirmed from live DOM)
    var userMsgs = document.querySelectorAll('[data-testid="user-message"]');

    // Assistant messages: siblings/adjacent to user messages in the conversation flow
    // Claude wraps assistant responses in .prose or grid containers after user messages
    var assistantMsgs = document.querySelectorAll(
      // Assistant message blocks (response content area)
      '[class*="font-claude"], .prose, [data-testid="chat-message-text"]'
    );

    // Gather user messages
    for (var i = 0; i < userMsgs.length; i++) {
      var t = (userMsgs[i].innerText || '').trim();
      if (t) msgs.push({ role: 'human', text: t });
    }

    // Gather assistant messages - filter out non-conversation prose
    for (var j = 0; j < assistantMsgs.length; j++) {
      var el = assistantMsgs[j];
      // Only count if it's inside the main conversation area
      if (el.closest('main') || el.closest('[role="main"]')) {
        var t2 = (el.innerText || '').trim();
        if (t2 && t2.length > 5) msgs.push({ role: 'assistant', text: t2 });
      }
    }

    if (msgs.length > 0) return msgs;

    // Fallback: grab everything from main
    var main = document.querySelector('main') || document.querySelector('[role="main"]');
    if (main) {
      // Look for any substantial text blocks
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
    // Dedup by first 120 chars
    var key = msgs[i].text.substring(0, 120);
    if (!seen[key]) {
      seen[key] = true;
      chars += msgs[i].text.length;
      count++;
    }
  }
  // Only add system overhead if there's actual conversation content
  var tokens = count > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) + OVERHEAD : 0;
  return {
    tokens: tokens,
    count: count,
    chars: chars
  };
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
// UI - Claude native design
// ═══════════════════════════════════════════════════════════════
function getColor(p) {
  // Claude-native palette: terracotta progression
  if (p < T_GREEN) return '#8B9A6B';    // sage green - plenty of room
  if (p < T_YELLOW) return '#B8976A';    // warm gold
  if (p < T_ORANGE) return '#C17A4A';    // warm amber
  if (p < T_RED) return '#C15F3C';       // Claude terracotta
  return '#A8403A';                       // deep terracotta
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
        '<div id="cct-extra">' +
          '<div><span>Tokens (est.)</span><span id="cct-tok">0</span></div>' +
          '<div><span>Messages</span><span id="cct-msg">0</span></div>' +
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
    if (cid !== lastConvId) { lastConvId = cid; summaryDone = false; }

    var d = estimate();
    estTokens = d.tokens;
    pct = (d.tokens / MAX_TOKENS) * 100;
    msgCount = d.count;

    refresh(d.tokens, pct, d.count);
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

    console.log('[CCT] v2.0 running');
  } catch (e) {
    console.error('[CCT] Init error:', e);
    setTimeout(start, 3000);
  }
}

// Wait for SPA to render
setTimeout(start, 1500);
