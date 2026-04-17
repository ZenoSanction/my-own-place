/*  My Own Place — Renderer (UI logic)  v1.1
    ──────────────────────────────────────────
    Changes from v1.0:
    • timed() moved to module level so navigate() can use it too.
    • init() now runs a ping test first, then shows a step-by-step
      progress bar so you can see exactly which stage is failing.
    • navigate() uses a timed config refresh that falls back gracefully
      instead of hanging forever on a plain _api.config.get() call.
    • renderSettings() no longer calls _api.config.get() independently —
      it uses the already-loaded S.config and updates it after save.
    • All remaining unprotected IPC calls in the settings handler fixed.
*/

'use strict';

// ── App state ─────────────────────────────────────────────────────────────────
var S = {
  page:      'dashboard',
  config:    {},
  serverOn:  false,
  ip:        '…',
  publicIp:  null,     // fetched async; null = not yet loaded, '' = unavailable
  // file manager
  fmPath:    '',
  // editor
  edFile:    null,
  edDirty:   false,
  // log
  logFilter: { type: 'ALL', search: '' },
};

// ── IPC bridge ────────────────────────────────────────────────────────────────
// window.api is injected by preload.js via contextBridge.exposeInMainWorld().
// IMPORTANT: do NOT name this variable `api`.
// contextBridge.exposeInMainWorld('api', ...) defines window.api as
// non-configurable + non-writable.  The JS spec forbids declaring a const/let
// in global scope with the same name as a non-configurable global property,
// so `const api` is a SyntaxError at parse time (before line 1 even runs).
// Using `_api` (or any name that isn't already on window) avoids the conflict.
const _api = window.api;

// ── Timed IPC helper ──────────────────────────────────────────────────────────
// Wraps any promise with a hard timeout.  If the promise does not resolve
// within `ms` milliseconds a descriptive error is thrown.
// Having this at module level lets both init() and navigate() use it.
function timed (promise, label, ms) {
  ms = ms || 6000;
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () {
      reject(new Error(
        '"' + label + '" did not respond within ' + (ms / 1000) + 's.\n\n' +
        'The app engine (main process) is not responding.\n' +
        'Try closing all windows and relaunching via dev.bat.'
      ));
    }, ms);
    promise.then(
      function (v) { clearTimeout(t); resolve(v); },
      function (e) { clearTimeout(t); reject(e);  }
    );
  });
}

// ── DOM helper ────────────────────────────────────────────────────────────────
function setContent (html) {
  var el = document.getElementById('content');
  if (el) el.innerHTML = html;
}

// ── Startup progress display ──────────────────────────────────────────────────
// Shows a spinner with a labelled progress bar — much more informative than
// a plain spinner.  pct is 0-100.
function progressHtml (msg, pct) {
  return '<div style="display:flex;align-items:center;justify-content:center;height:100%">' +
    '<div style="text-align:center;padding:3rem 2rem;max-width:320px;width:100%">' +
      '<div class="spinner" style="margin:0 auto 1.5rem"></div>' +
      '<p style="color:#c9d1d9;font-size:.95rem;margin-bottom:1rem">' + esc(msg) + '</p>' +
      '<div style="background:#21262d;border-radius:4px;height:4px;overflow:hidden">' +
        '<div style="background:#58a6ff;width:' + pct + '%;height:100%;' +
             'transition:width .4s ease;border-radius:4px"></div>' +
      '</div>' +
      '<p style="color:#6e7681;font-size:.72rem;margin-top:.6rem">My Own Place</p>' +
    '</div>' +
  '</div>';
}

// ── Crash screen ──────────────────────────────────────────────────────────────
function showCrash (err) {
  var msg = (err && err.message) ? err.message : String(err);
  var stack = (err && err.stack) ? err.stack : msg;
  // Try setContent first; if #content is gone fall back to document.body
  var container = document.getElementById('content') || document.body;
  container.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:1rem">' +
      '<div style="background:#161b22;border:1px solid #f85149;border-radius:12px;' +
                  'padding:2rem;max-width:580px;width:100%;text-align:center">' +
        '<div style="font-size:2.5rem;margin-bottom:.75rem">⚠️</div>' +
        '<h2 style="color:#f85149;margin-bottom:.75rem">Something went wrong</h2>' +
        // Selectable textarea so the user can copy the full error
        '<textarea id="crash-text" readonly ' +
                  'style="width:100%;height:120px;background:#0d1117;border:1px solid #30363d;' +
                         'border-radius:8px;color:#c9d1d9;font-family:monospace;font-size:.78rem;' +
                         'padding:.75rem;resize:vertical;line-height:1.5;text-align:left">' +
          esc(stack) +
        '</textarea>' +
        '<div style="display:flex;gap:.5rem;justify-content:center;margin-top:.75rem;flex-wrap:wrap">' +
          '<button class="btn btn-primary" onclick="location.reload()">↺ Reload App</button>' +
          '<button class="btn" id="crash-copy-btn" onclick="' +
            'var t=document.getElementById(\'crash-text\');' +
            'navigator.clipboard.writeText(t.value).then(function(){' +
              'document.getElementById(\'crash-copy-btn\').textContent=\'✓ Copied!\';' +
            '})">📋 Copy Error</button>' +
        '</div>' +
        '<p style="color:#6e7681;font-size:.75rem;margin-top:.75rem">' +
          'Press <kbd style="background:#21262d;padding:.1rem .4rem;border-radius:4px">F12</kbd>' +
          ' for Developer Tools, or copy the error above and paste it into the chat.' +
        '</p>' +
      '</div>' +
    '</div>';
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function init () {

  // ── Step 0: Verify JS is actually running ─────────────────────────────────
  // This replaces "Starting up…" with a progress bar.
  // If you still see "Starting up…" after launching, renderer.js is not
  // executing — check the debug log at %TEMP%\myownplace-debug.log.
  setContent(progressHtml('Initialising…', 5));

  // ── Step 1: Check for IPC bridge ──────────────────────────────────────────
  if (!window.api) {
    showCrash(new Error(
      'The IPC bridge (window.api) is not available.\n\n' +
      'This usually means the preload script failed to load.\n' +
      'Make sure you launched via dev.bat or start.vbs — ' +
      'do not open index.html directly in a browser.\n\n' +
      'Check %TEMP%\\myownplace-debug.log for details.'
    ));
    return;
  }

  setContent(progressHtml('Testing connection…', 20));

  try {
    // ── Step 2: Ping the main process ────────────────────────────────────────
    // This is a near-instant round-trip that confirms the IPC channel works.
    // If this times out, every other call would time out too, and we can say
    // so clearly instead of giving a vague "config.get() timed out" message.
    await timed(_api.ping(), 'ping', 4000);

    setContent(progressHtml('Loading configuration…', 45));

    // ── Step 3: Load config ──────────────────────────────────────────────────
    S.config = await timed(_api.config.get(), 'config.get()', 6000);

    setContent(progressHtml('Getting network info…', 70));

    // ── Step 4: Get local IP ─────────────────────────────────────────────────
    S.ip = await timed(_api.network.ip(), 'network.ip()', 6000);

    setContent(progressHtml('Ready!', 100));

    refreshIndicator(false);

    // ── Step 5: Navigate to first page ───────────────────────────────────────
    if (!S.config.setupComplete || !S.config.password) {
      showSetupBanner();
      await navigate('settings');
    } else {
      await navigate('dashboard');
    }

  } catch (err) {
    showCrash(err);
  }
}

// ── Server status indicator (sidebar dot) ────────────────────────────────────
function refreshIndicator (on) {
  S.serverOn = on;
  var el = document.getElementById('server-indicator');
  if (el) el.className = 'indicator ' + (on ? 'running' : 'stopped');
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigate (page) {

  // Warn about unsaved editor changes
  if (S.edDirty && S.page === 'editor') {
    if (!confirm('You have unsaved changes in the editor. Leave anyway?')) return;
    S.edDirty = false;
  }

  S.page = page;
  document.querySelectorAll('.nav-list li').forEach(function (li) {
    li.classList.toggle('active', li.dataset.page === page);
  });

  setContent('<div style="text-align:center;padding:4rem"><div class="spinner"></div></div>');

  try {
    // Refresh config before each page render.
    // A 4-second timeout prevents this from hanging silently.
    // If it fails (e.g. during a brief stall) we keep the last known config
    // rather than crashing — the pages can still render with cached data.
    try {
      S.config = await timed(_api.config.get(), 'nav config:get', 4000);
    } catch (_) {
      // Config refresh failed — continue with the copy loaded during init().
      // This is safe: config only changes when the user saves Settings.
    }

    switch (page) {
      case 'dashboard': await renderDashboard(); break;
      case 'files':     await renderFiles('files');   break;
      case 'photos':    await renderFiles('photos');  break;
      case 'editor':    await renderEditor();    break;
      case 'templates': await renderTemplates(); break;
      case 'log':       await renderLog();       break;
      case 'guestbook': await renderGuestbook(); break;
      case 'settings':  await renderSettings();  break;
      default:
        setContent('<div class="page-header"><div class="page-title">Page not found</div></div>');
    }
  } catch (err) {
    showCrash(err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
async function renderDashboard () {
  // Fire both IPC calls simultaneously — they're independent, no point waiting
  // for log.stats() before asking for server.status().  timed() prevents either
  // call from hanging the dashboard if the main process stalls.
  const [stats, st] = await Promise.all([
    timed(_api.log.stats(),      'log.stats()',      5000).catch(() => ({ today:0, total:0, ips:0 })),
    timed(_api.server.status(),  'server.status()',  5000).catch(() => ({ webRunning:false, ftpRunning:false })),
  ]);
  refreshIndicator(st.webRunning || st.ftpRunning);

  const lanUrl    = 'http://' + S.ip + ':' + S.config.webPort;
  const ftpUrl    = 'ftp://'  + S.ip + ':' + S.config.ftpPort;
  // Internet URL uses public IP if we have it, otherwise a placeholder
  const pubIpText = S.publicIp || '…';
  const internetUrl = S.publicIp
    ? 'http://' + S.publicIp + ':' + S.config.webPort
    : null;

  document.getElementById('content').innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-title">Dashboard</div>
      <div class="page-subtitle">Control your personal server</div>
    </div>
  </div>

  <!-- Master toggle -->
  <div class="card mb-2">
    <button id="master-toggle" class="master-btn ${S.serverOn ? 'stop' : 'start'}">
      ${S.serverOn ? '⏹ Stop Server' : '▶ Start Server'}
    </button>
  </div>

  <!-- Status cards -->
  <div class="grid-2 mb-2">
    <div class="server-toggle ${st.webRunning ? 'running' : 'stopped'}">
      <div class="st-icon">${st.webRunning ? '🌐' : '🔴'}</div>
      <div class="st-info">
        <h3>Web Server</h3>
        <p>${st.webRunning
          ? `Running on port <strong>${S.config.webPort}</strong>`
          : `Stopped — will use port ${S.config.webPort}`}</p>
        ${st.webRunning ? `<div class="share-bar mt-1">
          <input class="share-url" id="web-url" value="${lanUrl}" readonly>
          <button class="btn btn-sm" onclick="copyText('${lanUrl}')">Copy</button>
          <button class="btn btn-sm btn-primary" onclick="openBrowser('${lanUrl}')">Open</button>
        </div>` : ''}
      </div>
    </div>
    <div class="server-toggle ${st.ftpRunning ? 'running' : 'stopped'}">
      <div class="st-icon">${st.ftpRunning ? '📂' : '🔴'}</div>
      <div class="st-info">
        <h3>FTP Server</h3>
        <p>${S.config.enableFTP
          ? (st.ftpRunning
              ? `Running on port <strong>${S.config.ftpPort}</strong>`
              : `Stopped — will use port ${S.config.ftpPort}`)
          : 'Disabled in settings'}</p>
        ${st.ftpRunning ? `<div class="share-bar mt-1">
          <input class="share-url" value="${ftpUrl}" readonly>
          <button class="btn btn-sm" onclick="copyText('${ftpUrl}')">Copy</button>
        </div>` : ''}
        ${S.config.enableFTP && !st.ftpRunning && S.serverOn ? `
        <p style="font-size:.75rem;color:#f0883e;margin-top:.4rem">
          ⚠ FTP did not start — port ${S.config.ftpPort} may be in use,
          or a Windows Firewall dialog appeared.<br>
          Disable FTP in <a onclick="navigate('settings')"
          style="cursor:pointer;color:#58a6ff">Settings</a> if you don't need it.
        </p>` : ''}
      </div>
    </div>
  </div>

  <!-- Stats -->
  <div class="grid-4 mb-2">
    <div class="stat-card">
      <div class="stat-label">Visits Today</div>
      <div class="stat-value">${stats.today ?? 0}</div>
      <div class="stat-sub">web + FTP requests</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Requests</div>
      <div class="stat-value">${stats.total ?? 0}</div>
      <div class="stat-sub">all time</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Unique IPs</div>
      <div class="stat-value">${stats.ips ?? 0}</div>
      <div class="stat-sub">distinct visitors</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Network IP</div>
      <div class="stat-value" style="font-size:1rem">${S.ip}</div>
      <div class="stat-sub">your LAN address</div>
    </div>
  </div>

  <!-- Bandwidth stats -->
  <div class="card mb-2">
    <div class="card-title">📊 Bandwidth</div>
    <div class="grid-4" style="gap:.75rem">
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:.9rem 1rem">
        <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text2);margin-bottom:.3rem">Transferred Today</div>
        <div style="font-size:1.4rem;font-weight:700">${fmtBytes(stats.bytesToday ?? 0)}</div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:.9rem 1rem">
        <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text2);margin-bottom:.3rem">Transferred Total</div>
        <div style="font-size:1.4rem;font-weight:700">${fmtBytes(stats.bytesTotal ?? 0)}</div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:.9rem 1rem">
        <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text2);margin-bottom:.3rem">Web Transfer</div>
        <div style="font-size:1.4rem;font-weight:700">${fmtBytes(stats.bytesWeb ?? 0)}</div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:.9rem 1rem">
        <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text2);margin-bottom:.3rem">FTP Transfer</div>
        <div style="font-size:1.4rem;font-weight:700">${fmtBytes(stats.bytesFtp ?? 0)}</div>
      </div>
    </div>
  </div>

  <!-- Quick actions -->
  <div class="card mb-2">
    <div class="card-title">Quick Actions</div>
    <div class="flex gap-1" style="flex-wrap:wrap">
      <button class="btn" onclick="navigate('files')">📁 Manage Files</button>
      <button class="btn" onclick="navigate('editor')">✏️ Edit Site</button>
      <button class="btn" onclick="navigate('templates')">🎨 Templates</button>
      <button class="btn" onclick="navigate('log')">📋 View Log</button>
      <button class="btn" onclick="openWwwFolder()">📂 Open Folder</button>
      ${st.webRunning ? `<button class="btn" onclick="openBrowser('${lanUrl}')">🌐 Preview Site</button>` : ''}
    </div>
  </div>

  <!-- Share with Friends card ───────────────────────────────────────────── -->
  <div class="card mb-2">
    <div class="card-title">🌍 Share with Friends</div>

    <div class="grid-2" style="gap:1rem;margin-bottom:1rem">
      <!-- LAN (same Wi-Fi) -->
      <div style="background:var(--bg3);border-radius:8px;padding:1rem;border:1px solid var(--border)">
        <div style="font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;
                    color:#8b949e;margin-bottom:.4rem">📶 Same Wi-Fi / Network</div>
        <div class="share-bar">
          <input class="share-url" value="${st.webRunning ? lanUrl : 'Start the server first'}" readonly
                 style="font-size:.82rem">
          ${st.webRunning ? `<button class="btn btn-sm" onclick="copyText('${lanUrl}')">Copy</button>` : ''}
        </div>
        <p style="font-size:.75rem;color:#8b949e;margin-top:.4rem">
          Friends on the same Wi-Fi can use this link directly.
        </p>
      </div>

      <!-- Internet (port forwarding required) -->
      <div style="background:var(--bg3);border-radius:8px;padding:1rem;border:1px solid var(--border)">
        <div style="font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;
                    color:#8b949e;margin-bottom:.4rem">🌐 Internet (anywhere)</div>
        <div class="share-bar">
          <input class="share-url" id="pub-url-input"
                 value="${internetUrl || ('http://' + pubIpText + ':' + (S.config.webPort || 8080))}"
                 readonly style="font-size:.82rem">
          <!-- Always show Copy — reads the live input value so it works even before
               the public IP has loaded.  onclick uses getElementById so the button
               captures whatever value is in the field at click time, not render time. -->
          <button class="btn btn-sm" id="pub-url-copy"
                  onclick="copyText(document.getElementById('pub-url-input').value)">Copy</button>
        </div>
        <p style="font-size:.75rem;color:${S.publicIp ? '#3fb950' : '#f0883e'};margin-top:.4rem" id="pub-ip-note">
          ${S.publicIp
            ? `✓ Your public IP is <strong>${S.publicIp}</strong> — see setup steps below.`
            : (S.publicIp === ''
                ? '⚠ Could not detect public IP — check your internet connection.'
                : '⏳ Looking up your public IP…')}
        </p>
      </div>
    </div>

    <!-- Port forwarding guide — always shown so user knows what to do -->
    <details ${S.serverOn ? 'open' : ''} style="border-top:1px solid var(--border);padding-top:.75rem">
      <summary style="cursor:pointer;font-size:.88rem;font-weight:600;
                      color:#c9d1d9;list-style:none;display:flex;align-items:center;gap:.4rem">
        <span id="pf-arrow" style="font-size:.7rem">▶</span>
        How to make your site reachable from the internet
      </summary>
      <div style="margin-top:.75rem;font-size:.83rem;color:#8b949e;line-height:1.7">
        <p style="margin-bottom:.6rem">
          Your router uses <strong style="color:#c9d1d9">NAT</strong> — it hides your computer
          behind a single public IP.  You need to tell your router to forward
          incoming web traffic to your computer.  This is called
          <strong style="color:#c9d1d9">port forwarding</strong>.
        </p>
        <ol style="padding-left:1.4rem;margin-bottom:.75rem">
          <li style="margin-bottom:.4rem">
            Open a browser and go to your router admin page —
            usually <code style="background:#21262d;padding:.1rem .35rem;border-radius:4px">192.168.1.1</code>
            or <code style="background:#21262d;padding:.1rem .35rem;border-radius:4px">192.168.0.1</code>
            (check the sticker on your router).
          </li>
          <li style="margin-bottom:.4rem">
            Find the <strong style="color:#c9d1d9">Port Forwarding</strong> section
            (sometimes under "Advanced", "NAT", or "Virtual Servers").
          </li>
          <li style="margin-bottom:.4rem">
            Add a new rule:<br>
            <table style="margin-top:.3rem;font-size:.8rem;border-collapse:collapse">
              <tr>
                <td style="padding:.2rem .6rem .2rem 0;color:#6e7681">Protocol</td>
                <td><code style="background:#21262d;padding:.1rem .35rem;border-radius:4px">TCP</code></td>
              </tr>
              <tr>
                <td style="padding:.2rem .6rem .2rem 0;color:#6e7681">External Port</td>
                <td><code style="background:#21262d;padding:.1rem .35rem;border-radius:4px">${S.config.webPort}</code></td>
              </tr>
              <tr>
                <td style="padding:.2rem .6rem .2rem 0;color:#6e7681">Internal IP</td>
                <td><code style="background:#21262d;padding:.1rem .35rem;border-radius:4px">${S.ip}</code></td>
              </tr>
              <tr>
                <td style="padding:.2rem .6rem .2rem 0;color:#6e7681">Internal Port</td>
                <td><code style="background:#21262d;padding:.1rem .35rem;border-radius:4px">${S.config.webPort}</code></td>
              </tr>
            </table>
          </li>
          <li style="margin-bottom:.4rem">
            Save the rule and test by visiting<br>
            <code style="background:#21262d;padding:.1rem .35rem;border-radius:4px">
              http://${pubIpText}:${S.config.webPort}</code>
            from a phone on mobile data (not Wi-Fi).
          </li>
          <li>
            <strong style="color:#f0883e">Important:</strong> Your public IP can change.
            If friends can't connect tomorrow, check that the IP above
            (currently <strong style="color:#c9d1d9">${pubIpText}</strong>) hasn't changed.
            Free services like
            <a onclick="openBrowser('https://www.noip.com')"
               style="cursor:pointer;color:#58a6ff">No-IP</a> or
            <a onclick="openBrowser('https://www.duckdns.org')"
               style="cursor:pointer;color:#58a6ff">DuckDNS</a>
            give you a permanent hostname that follows your IP automatically.
          </li>
        </ol>
      </div>
    </details>
  </div>

  <!-- FTP credentials (shown when FTP is running) -->
  ${st.ftpRunning ? `<div class="card mt-2">
    <div class="card-title">FTP Connection Details</div>
    <table style="font-size:.85rem;width:100%">
      <tr><td class="text-muted" style="width:130px">Host</td><td class="text-mono">${S.ip}</td></tr>
      <tr><td class="text-muted">Port</td><td class="text-mono">${S.config.ftpPort}</td></tr>
      <tr><td class="text-muted">Username</td><td class="text-mono">${S.config.ftpUsername}</td></tr>
      <tr><td class="text-muted">Password</td><td class="text-mono">(your server password)</td></tr>
      <tr><td class="text-muted">Mode</td><td class="text-mono">Passive (PASV)</td></tr>
    </table>
    <p class="form-hint mt-1">Use FileZilla, WinSCP, or any FTP client with these credentials.</p>
    <div class="card mt-2" style="background:#161b22;border-color:#30363d">
      <div class="card-title" style="font-size:.8rem">💡 FTP Tips</div>
      <ul style="font-size:.82rem;color:var(--text2);line-height:1.8;padding-left:1.2rem;margin:0">
        <li>FTP has <strong style="color:var(--text)">no file size limit</strong> — use it for files over 4 GB</li>
        <li>FTP streams files directly to disk — no memory spike like the in-app uploader</li>
        <li>Best for large videos, backups, game files, and bulk transfers</li>
        <li>Set protocol to <strong style="color:var(--text)">FTP</strong> and transfer mode to <strong style="color:var(--text)">Passive (PASV)</strong> in your client</li>
        <li>Files land in your website root: <span class="text-mono" style="font-size:.78rem">${esc(S.config.wwwRoot || '')}</span></li>
      </ul>
    </div>
  </div>` : ''}
  `;

  document.getElementById('master-toggle').onclick = toggleServer;

  // Wire up the details toggle arrow
  const det = document.querySelector('details');
  if (det) {
    det.addEventListener('toggle', function () {
      var arrow = document.getElementById('pf-arrow');
      if (arrow) arrow.textContent = det.open ? '▼' : '▶';
    });
  }

  // Fetch public IP in the background and update the card when it arrives.
  // Only do the network request if we haven't fetched it this session yet.
  if (S.publicIp === null) {
    _api.network.publicip().then(function (ip) {
      S.publicIp = ip || '';   // cache result ('' = not available)
      // Only update if we're still on the dashboard
      if (S.page === 'dashboard') {
        var noteEl = document.getElementById('pub-ip-note');
        var urlEl  = document.getElementById('pub-url-input');
        if (noteEl) {
          if (ip) {
            noteEl.style.color = '#3fb950';
            noteEl.innerHTML = '✓ Your public IP is <strong>' + esc(ip) + '</strong> — see setup steps below.';
          } else {
            noteEl.style.color = '#f0883e';
            noteEl.textContent = '⚠ Could not detect public IP — check your internet connection.';
          }
        }
        if (urlEl && ip) {
          urlEl.value = 'http://' + ip + ':' + S.config.webPort;
        }
      }
    }).catch(function () {
      S.publicIp = '';
    });
  }
}

async function toggleServer () {
  const btn = document.getElementById('master-toggle');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>&nbsp; Please wait…';

  try {
    if (S.serverOn) {
      // Give stop up to 8 seconds
      await timed(_api.server.stop(), 'server.stop()', 8000);
      refreshIndicator(false);
      toast('Server stopped', 'info');
    } else {
      // Give start up to 25 seconds — FTP has an 8s internal timeout,
      // web server typically starts in < 1s, so 25s is very generous.
      const r = await timed(_api.server.start(), 'server.start()', 25000);

      if (r.web) {
        // Web server is up — that's the important one
        refreshIndicator(true);
        if (r.errors && r.errors.length) {
          // Web running but something else (FTP) failed — show as warning
          toast('Web server started. ⚠ ' + r.errors.join(' | '), 'warning');
        } else {
          toast('Server started!', 'success');
        }
      } else {
        // Web itself failed — that's a real error
        var errMsg = (r.errors && r.errors.length)
          ? r.errors.join(', ')
          : 'Unknown error — check the debug log';
        toast('Server failed to start: ' + errMsg, 'error');
      }
    }
  } catch (err) {
    // timed() threw — either the IPC timed out or start/stop threw
    toast('Server error: ' + err.message, 'error');
  }

  // Always refresh the dashboard so the status cards reflect reality,
  // even if we caught an error above.
  await renderDashboard();
}

// ═════════════════════════════════════════════════════════════════════════════
// FILE MANAGER
// ═════════════════════════════════════════════════════════════════════════════
async function renderFiles (dirPath) {
  dirPath = dirPath || '';
  S.fmPath = dirPath;
  const result = await _api.fs.list(dirPath);

  if (result.error) {
    document.getElementById('content').innerHTML =
      `<div class="page-header"><div class="page-title">File Manager</div></div>
       <div class="card"><p class="text-red">${esc(result.error)}</p></div>`;
    return;
  }

  const { items, current } = result;
  const pathParts    = (current === '/' || !current) ? [] : current.split('/').filter(Boolean);
  const breadcrumbHtml = buildBreadcrumb(pathParts);

  const rows = items.map(function (f) {
    const icon    = f.isDir ? '📁' : fileIcon(f.name);
    const size    = f.isDir ? '—' : fmtBytes(f.size);
    const modDate = new Date(f.modified).toLocaleDateString();
    // Folders → clicking the name navigates into that folder (standard behaviour).
    // Files   → clicking the name does nothing; use the ✏️ button to edit.
    //           (Previously clicking a file opened the editor, which confused
    //            users when the preview iframe showed the rendered page.)
    const nameAttrs = f.isDir
      ? `onclick="navigate_files('${esc(f.path)}')" style="cursor:pointer"`
      : `onclick="previewFile('${esc(f.path)}','${esc(f.name)}')" style="cursor:pointer" title="Click to preview"`;
    return `<tr>
      <td><span class="fi-name" ${nameAttrs}>
        <span class="fi-icon">${icon}</span>${esc(f.name)}
      </span></td>
      <td class="text-muted">${size}</td>
      <td class="text-muted">${modDate}</td>
      <td>
        <div class="file-actions">
          ${!f.isDir ? `<button class="btn btn-sm" title="Edit" onclick="openEditorFile('${esc(f.path)}')">✏️</button>` : ''}
          ${!f.isDir ? `<button class="btn btn-sm" title="Share" onclick="shareFile('${esc(f.path)}','${esc(f.name)}')">🔗</button>` : ''}
          <button class="btn btn-sm" title="Rename" onclick="renameItem('${esc(f.path)}','${esc(f.name)}')">🔤</button>
          <button class="btn btn-sm btn-danger" title="Delete" onclick="deleteItem('${esc(f.path)}','${esc(f.name)}',${f.isDir})">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('content').innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-title">File Manager</div>
      <div class="page-subtitle">Manage your website files</div>
    </div>
    <button class="btn" onclick="openWwwFolder()">📂 Open in Explorer</button>
  </div>

  ${breadcrumbHtml}

  <div class="file-toolbar">
    <label class="btn btn-primary" style="cursor:pointer">
      ⬆ Upload
      <input type="file" id="upload-input" multiple hidden onchange="handleUpload(this.files)">
    </label>
    <button class="btn" onclick="promptNewFolder()">📁 New Folder</button>
    <button class="btn" onclick="promptNewFile()">📄 New File</button>
    <button class="btn" onclick="renderFiles('${esc(S.fmPath)}')">↻ Refresh</button>
    <button class="btn" onclick="manageShares()">🔗 Shares</button>
  </div>

  <div class="card" id="fm-drop-target">
    ${items.length ? `
    <table class="file-table">
      <thead><tr>
        <th>Name</th>
        <th style="width:80px">Size</th>
        <th style="width:110px">Modified</th>
        <th style="width:110px">Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>` : `<div class="log-empty">📭 This folder is empty<br>
      <span class="text-small text-muted">Upload files or create a new one above.</span></div>`}
  </div>

  <div class="drop-zone mt-2" id="drop-zone" onclick="document.getElementById('upload-input').click()">
    <div style="font-size:2rem">⬆</div>
    <p>Drag &amp; drop files here, or click to upload</p>
    <p class="text-small">Files will be uploaded to: /${esc(S.fmPath || '')}</p>
  </div>
  `;

  // ── Drag-and-drop: full-pane overlay ─────────────────────────────────────
  // Uses relatedTarget instead of a depth counter so there is zero flicker
  // when the drag moves over child elements inside the content area.
  const contentEl = document.getElementById('content');
  const dz        = document.getElementById('drop-zone');

  // Build the overlay and append it *inside* contentEl so that
  // contentEl.contains(relatedTarget) returns true for the overlay itself,
  // preventing the dragleave from firing when the cursor moves onto it.
  var overlay = document.createElement('div');
  overlay.id  = 'drag-overlay';
  overlay.innerHTML =
    '<div style="pointer-events:none;text-align:center">' +
    '<div style="font-size:3rem;margin-bottom:.6rem">⬆</div>' +
    '<div style="font-size:1.1rem;font-weight:700">Drop files to upload</div>' +
    '<div style="font-size:.82rem;margin-top:.3rem;opacity:.7">→ /' + esc(S.fmPath || 'root') + '</div>' +
    '</div>';
  contentEl.appendChild(overlay);

  contentEl.addEventListener('dragenter', function (e) {
    var types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
    if (!types.includes('Files')) return;
    e.preventDefault();
    overlay.classList.add('active');
    dz.classList.add('dragover');
  });
  contentEl.addEventListener('dragleave', function (e) {
    if (!contentEl.contains(e.relatedTarget)) {
      overlay.classList.remove('active');
      dz.classList.remove('dragover');
    }
  });
  contentEl.addEventListener('dragover', function (e) { e.preventDefault(); });

  overlay.addEventListener('dragover',  function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  overlay.addEventListener('dragleave', function (e) {
    if (!contentEl.contains(e.relatedTarget)) {
      overlay.classList.remove('active');
      dz.classList.remove('dragover');
    }
  });
  overlay.addEventListener('drop', function (e) {
    e.preventDefault();
    overlay.classList.remove('active');
    dz.classList.remove('dragover');
    handleUpload(e.dataTransfer.files);
  });
}

function buildBreadcrumb (parts) {
  var html = '<div class="breadcrumb"><a onclick="renderFiles(\'\')">⌂ Root</a>';
  var built = '';
  for (var i = 0; i < parts.length; i++) {
    built += (built ? '/' : '') + parts[i];
    var cap = built;
    if (i === parts.length - 1) {
      html += '<span class="breadcrumb-sep">/</span><span class="current">' + esc(parts[i]) + '</span>';
    } else {
      html += '<span class="breadcrumb-sep">/</span><a onclick="renderFiles(\'' + esc(cap) + '\')">' + esc(parts[i]) + '</a>';
    }
  }
  html += '</div>';
  return html;
}

window.navigate_files = function (p) { renderFiles(p); };

window.handleUpload = async function (files) {
  if (!files || !files.length) return;
  var total = files.length;
  var ok    = 0;

  // Show a live progress toast for the duration of the upload
  var progEl = document.createElement('div');
  progEl.className  = 'toast info';
  progEl.style.cssText = 'display:flex;align-items:center;gap:.6rem;min-width:260px';
  var tc = document.getElementById('toast-container');
  if (tc) tc.prepend(progEl);

  function setProgress (i) {
    progEl.innerHTML =
      '<span class="spinner" style="width:14px;height:14px;flex-shrink:0"></span>' +
      'Uploading ' + (i + 1) + '\u202f/\u202f' + total +
      (total > 1 ? ' &mdash; ' + esc(files[i].name) : '&nbsp;&mdash;&nbsp;' + esc(files[i].name));
  }

  for (var i = 0; i < files.length; i++) {
    setProgress(i);
    var file = files[i];
    try {
      var b64 = await readFileAsBase64(file);
      var r   = await _api.fs.upload(file.name, b64, S.fmPath);
      if (r.success) ok++;
      else toast('Upload failed: ' + r.error, 'error');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  }

  // Remove progress toast and show result
  if (progEl.parentNode) progEl.parentNode.removeChild(progEl);
  if (ok) {
    toast(ok + ' file' + (ok > 1 ? 's' : '') + ' uploaded', 'success');
    renderFiles(S.fmPath);
  }
};

function readFileAsBase64 (file) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload  = function () { res(fr.result.split(',')[1]); };
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

window.promptNewFolder = function () {
  showModal('New Folder', `
    <div class="form-group">
      <label>Folder Name</label>
      <input class="form-control" id="nf-name" placeholder="my-folder" autofocus>
    </div>
    <button class="btn btn-primary w-full" onclick="doNewFolder()">Create Folder</button>
  `);
};

window.doNewFolder = async function () {
  var name = document.getElementById('nf-name').value.trim();
  if (!name) return toast('Enter a folder name', 'warning');
  var r = await _api.fs.mkdir(S.fmPath ? S.fmPath + '/' + name : name);
  closeModal();
  if (r.success) { toast('Folder created', 'success'); renderFiles(S.fmPath); }
  else toast('Error: ' + r.error, 'error');
};

window.promptNewFile = function () {
  showModal('New File', `
    <div class="form-group">
      <label>File Name</label>
      <input class="form-control" id="newfile-name" placeholder="page.html" autofocus>
    </div>
    <button class="btn btn-primary w-full" onclick="doNewFile()">Create File</button>
  `);
};

window.doNewFile = async function () {
  var name = document.getElementById('newfile-name').value.trim();
  if (!name) return toast('Enter a file name', 'warning');
  var rel  = S.fmPath ? S.fmPath + '/' + name : name;
  var r    = await _api.fs.write(rel, '');
  closeModal();
  if (r.success) { toast('File created', 'success'); openEditorFile(rel); }
  else toast('Error: ' + r.error, 'error');
};

window.deleteItem = function (filePath, name, isDir) {
  showModal('Confirm Delete', `
    <p class="mb-2">Delete <strong>${esc(name)}</strong>${isDir ? ' and all its contents' : ''}?</p>
    <p class="text-muted text-small mb-2">This cannot be undone.</p>
    <div class="flex gap-1">
      <button class="btn btn-danger w-full" onclick="doDelete('${esc(filePath)}')">Delete</button>
      <button class="btn w-full" onclick="closeModal()">Cancel</button>
    </div>
  `);
};

window.doDelete = async function (filePath) {
  closeModal();
  var r = await _api.fs.delete(filePath);
  if (r.success) { toast('Deleted', 'success'); renderFiles(S.fmPath); }
  else toast('Error: ' + r.error, 'error');
};

window.renameItem = function (filePath, name) {
  showModal('Rename', `
    <div class="form-group">
      <label>New Name</label>
      <input class="form-control" id="rn-name" value="${esc(name)}" autofocus>
    </div>
    <button class="btn btn-primary w-full" onclick="doRename('${esc(filePath)}','${esc(name)}')">Rename</button>
  `);
};

window.doRename = async function (oldPath, oldName) {
  var newName = document.getElementById('rn-name').value.trim();
  if (!newName || newName === oldName) return closeModal();
  var newPath = oldPath.replace(/(\/)?[^/]+$/, function (m, slash) { return (slash || '') + newName; });
  var r = await _api.fs.rename(oldPath, newPath);
  closeModal();
  if (r.success) { toast('Renamed', 'success'); renderFiles(S.fmPath); }
  else toast('Error: ' + r.error, 'error');
};

// ── User account management (called from Settings page) ───────────────────────
window.promptAddUser = function () {
  showModal('Add User', `
    <div class="form-group">
      <label>Username</label>
      <input class="form-control" id="nu-name" placeholder="e.g. alice" autofocus
             autocomplete="off" style="max-width:240px">
    </div>
    <div class="form-group">
      <label>Password</label>
      <div class="settings-row">
        <input class="form-control" type="password" id="nu-pw"
               placeholder="Choose a password" style="max-width:240px" autocomplete="new-password">
        <button class="btn btn-sm" id="nu-pw-toggle">Show</button>
      </div>
    </div>
    <button class="btn btn-primary w-full" onclick="doAddUser()">Add User</button>
  `);
  var btn = document.getElementById('nu-pw-toggle');
  if (btn) btn.onclick = function () {
    var inp = document.getElementById('nu-pw');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  };
};

window.doAddUser = async function () {
  var name = (document.getElementById('nu-name').value || '').trim();
  var pw   = document.getElementById('nu-pw').value;
  if (!name) return toast('Enter a username', 'warning');
  if (!pw)   return toast('Enter a password', 'warning');
  var r = await _api.users.add(name, pw);
  closeModal();
  if (r.success) { toast('User "' + name + '" added', 'success'); renderSettings(); }
  else toast('Error: ' + r.error, 'error');
};

window.toggleUser = async function (id, enabled) {
  await _api.users.update(id, { enabled });
  toast(enabled ? 'User enabled' : 'User disabled', 'success');
};

window.changeUserPw = function (id, username) {
  showModal('Change Password — ' + username, `
    <div class="form-group">
      <label>New Password</label>
      <div class="settings-row">
        <input class="form-control" type="password" id="cup-pw"
               placeholder="New password" autofocus style="max-width:240px" autocomplete="new-password">
        <button class="btn btn-sm" id="cup-pw-toggle">Show</button>
      </div>
    </div>
    <button class="btn btn-primary w-full" onclick="doChangeUserPw('${esc(id)}')">Save Password</button>
  `);
  var btn = document.getElementById('cup-pw-toggle');
  if (btn) btn.onclick = function () {
    var inp = document.getElementById('cup-pw');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  };
};

window.doChangeUserPw = async function (id) {
  var pw = document.getElementById('cup-pw').value;
  if (!pw) return toast('Enter a new password', 'warning');
  var r = await _api.users.update(id, { password: pw });
  closeModal();
  if (r.success) toast('Password updated', 'success');
  else toast('Error: ' + r.error, 'error');
};

window.deleteUser = function (id, username) {
  showModal('Remove User', `
    <p class="mb-2">Remove <strong>${esc(username)}</strong>?</p>
    <p class="text-muted text-small mb-2">They will no longer be able to log into your site.</p>
    <div class="flex gap-1">
      <button class="btn btn-danger w-full" onclick="doDeleteUser('${esc(id)}')">Remove</button>
      <button class="btn w-full" onclick="closeModal()">Cancel</button>
    </div>
  `);
};

window.doDeleteUser = async function (id) {
  closeModal();
  await _api.users.delete(id);
  toast('User removed', 'success');
  renderSettings();
};

// ── File preview ─────────────────────────────────────────────────────────────
window.previewFile = async function (filePath, fileName) {
  var ext       = (fileName.split('.').pop() || '').toLowerCase();
  var imageExts = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','svg']);
  var textExts  = new Set(['html','htm','css','js','json','txt','md','xml','csv','ini','log']);

  if (imageExts.has(ext)) {
    // ── Image preview ──────────────────────────────────────────────────────
    var ri = await _api.fs.readbinary(filePath);
    if (ri.error) { toast('Cannot preview: ' + ri.error, 'error'); return; }
    var mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
                    gif:'image/gif', webp:'image/webp', avif:'image/avif',
                    bmp:'image/bmp', svg:'image/svg+xml' };
    var dataUrl = 'data:' + (mimeMap[ext] || 'image/' + ext) + ';base64,' + ri.content;
    showModal(fileName, `
      <div style="text-align:center">
        <img src="${dataUrl}"
             style="max-width:100%;max-height:65vh;border-radius:8px;display:inline-block">
      </div>
      <div class="flex gap-1 mt-2">
        <button class="btn" onclick="shareFile('${esc(filePath)}','${esc(fileName)}');closeModal()">🔗 Share</button>
        <button class="btn" onclick="closeModal()">Close</button>
      </div>
    `);

  } else if (textExts.has(ext)) {
    // ── Text / code / HTML preview ─────────────────────────────────────────
    var rt = await _api.fs.read(filePath);
    if (rt.error) { toast('Cannot preview: ' + rt.error, 'error'); return; }
    var isHtml = (ext === 'html' || ext === 'htm');
    var body   = isHtml
      ? `<iframe srcdoc="${esc(rt.content)}"
                 style="width:100%;height:60vh;border:none;border-radius:8px;background:#fff"
                 sandbox="allow-scripts allow-same-origin"></iframe>`
      : `<pre style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;
                     padding:1rem;overflow:auto;max-height:60vh;
                     font-size:.78rem;line-height:1.55;color:var(--text);
                     white-space:pre-wrap;word-break:break-all">${esc(rt.content.slice(0, 30000))}</pre>`;
    showModal(fileName, body + `
      <div class="flex gap-1 mt-2">
        <button class="btn btn-primary" onclick="openEditorFile('${esc(filePath)}');closeModal()">✏️ Edit</button>
        <button class="btn" onclick="shareFile('${esc(filePath)}','${esc(fileName)}');closeModal()">🔗 Share</button>
        <button class="btn" onclick="closeModal()">Close</button>
      </div>
    `);

  } else {
    // ── Generic file info panel ────────────────────────────────────────────
    showModal(fileName, `
      <div style="text-align:center;padding:1.25rem 0">
        <div style="font-size:3rem;margin-bottom:.6rem">${fileIcon(fileName)}</div>
        <p style="font-weight:600;margin-bottom:.4rem">${esc(fileName)}</p>
        <p class="text-muted text-small">No preview available for <code>.${esc(ext)}</code> files</p>
      </div>
      <div class="flex gap-1 mt-2">
        <button class="btn btn-primary" onclick="shareFile('${esc(filePath)}','${esc(fileName)}');closeModal()">🔗 Share</button>
        <button class="btn" onclick="closeModal()">Close</button>
      </div>
    `);
  }
};

// ── Share links ───────────────────────────────────────────────────────────────
window.shareFile = function (filePath, fileName) {
  showModal('Share File', `
    <p style="margin-bottom:.75rem">Create a public download link for
      <strong>${esc(fileName)}</strong>.</p>
    <p class="text-muted text-small" style="margin-bottom:1rem">
      The link works for anyone — no password required. Only share with trusted people.
    </p>
    <div class="form-group">
      <label>Link Expiry</label>
      <select class="form-control" id="share-expiry" style="max-width:220px">
        <option value="">Never expires</option>
        <option value="1">1 hour</option>
        <option value="24">24 hours</option>
        <option value="168">7 days</option>
        <option value="720">30 days</option>
      </select>
    </div>
    <button class="btn btn-primary w-full" onclick="doCreateShare('${esc(filePath)}','${esc(fileName)}')">
      🔗 Generate Share Link
    </button>
  `);
};

window.doCreateShare = async function (filePath, fileName) {
  var expiryVal  = document.getElementById('share-expiry').value;
  var expiryHrs  = expiryVal ? parseInt(expiryVal, 10) : null;
  var r          = await _api.share.create(filePath, expiryHrs, fileName);
  if (!r.success) { toast('Failed: ' + (r.error || 'unknown error'), 'error'); return; }

  var expiryText = expiryVal
    ? '⏱ Expires in ' + expiryVal + ' hour' + (parseInt(expiryVal, 10) > 1 ? 's' : '')
    : '✓ Never expires';

  showModal('Share Link Ready', `
    <p style="margin-bottom:.5rem">
      Download link for <strong>${esc(fileName)}</strong>:
    </p>
    <p class="text-muted text-small" style="margin-bottom:.75rem">${esc(expiryText)}</p>
    <div class="share-bar" style="margin-bottom:1rem">
      <input class="share-url" id="share-link-val" value="${esc(r.url)}" readonly
             style="font-size:.8rem">
      <button class="btn btn-sm"
              onclick="copyText(document.getElementById('share-link-val').value)">Copy</button>
    </div>
    <p class="text-muted text-small" style="margin-bottom:1rem">
      Anyone with this link can download the file directly from your server.
    </p>
    <div class="flex gap-1">
      <button class="btn w-full" onclick="closeModal()">Done</button>
      <button class="btn w-full" onclick="manageShares()">Manage All Shares</button>
    </div>
  `);
};

window.manageShares = async function () {
  var shares = await _api.share.list();
  var rows = shares.length
    ? shares.map(function (s) {
        var exp  = s.expires ? new Date(s.expires).toLocaleString() : '—';
        var cre  = new Date(s.created).toLocaleDateString();
        return '<tr>' +
          '<td style="padding:.45rem .5rem">' + esc(s.label) + '</td>' +
          '<td class="text-muted text-small" style="padding:.45rem .5rem">' + esc(cre) + '</td>' +
          '<td class="text-muted text-small" style="padding:.45rem .5rem">' + esc(exp) + '</td>' +
          '<td style="padding:.45rem .5rem"><div class="flex gap-1">' +
            '<button class="btn btn-sm" onclick="copyShareUrl(\'' + esc(s.url) + '\')">📋</button>' +
            '<button class="btn btn-sm btn-danger" onclick="doDeleteShare(\'' + esc(s.token) + '\')">🗑</button>' +
          '</div></td>' +
          '</tr>';
      }).join('')
    : '<tr><td colspan="4" style="text-align:center;padding:1.5rem;color:var(--text2)">' +
      '📭 No active share links</td></tr>';

  showModal('Manage Share Links', `
    <table style="width:100%;border-collapse:collapse;font-size:.84rem;margin-bottom:.75rem">
      <thead><tr>
        <th style="text-align:left;padding:.35rem .5rem;color:var(--text2);font-size:.72rem;
                   text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">File</th>
        <th style="text-align:left;padding:.35rem .5rem;color:var(--text2);font-size:.72rem;
                   text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Created</th>
        <th style="text-align:left;padding:.35rem .5rem;color:var(--text2);font-size:.72rem;
                   text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Expires</th>
        <th style="border-bottom:1px solid var(--border)"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="text-muted text-small">
      ⚠ Share links bypass password protection. Delete any you no longer need.
    </p>
  `);
};

window.copyShareUrl = function (url) {
  navigator.clipboard.writeText(url).then(function () { toast('Link copied!', 'success'); });
};

window.doDeleteShare = async function (token) {
  await _api.share.delete(token);
  toast('Share link deleted', 'success');
  manageShares();   // refresh the modal in place
};

// ═════════════════════════════════════════════════════════════════════════════
// EDITOR
// ═════════════════════════════════════════════════════════════════════════════
async function renderEditor (preloadFile) {
  preloadFile = preloadFile || null;

  // Get the full list of files in the www root
  const fileList = await getAllFiles('');

  const options = fileList
    .filter(function (f) { return /\.(html|css|js|txt|json|xml|svg|md)$/i.test(f); })
    .map(function (f) {
      return '<option value="' + esc(f) + '"' + (f === S.edFile ? ' selected' : '') + '>' + esc(f) + '</option>';
    }).join('');

  document.getElementById('content').innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-title">Site Editor</div>
      <div class="page-subtitle">Edit your website files with live preview</div>
    </div>
  </div>

  <div class="editor-wrap">
    <!-- Toolbar -->
    <div class="editor-toolbar">
      <select class="form-control editor-file-select" id="ed-file-select">
        <option value="">— Select a file —</option>
        ${options}
      </select>
      <button class="btn btn-primary" id="ed-save"   disabled>💾 Save</button>
      <button class="btn"             id="ed-revert" disabled>↩ Revert</button>
      <button class="btn"             id="ed-preview-toggle">👁 Preview</button>
      <button class="btn"             id="ed-format">✨ Format HTML</button>
      <span id="ed-status" class="text-muted text-small"></span>
    </div>

    <!-- Code area -->
    <div style="position:relative;overflow:hidden;border-radius:var(--radius-lg);border:1px solid var(--border)">
      <textarea class="code-editor" id="code-editor" spellcheck="false"
        placeholder="Select a file to start editing…"></textarea>
    </div>

    <!-- Preview -->
    <div style="position:relative">
      <iframe class="preview-frame" id="preview-frame" sandbox="allow-scripts allow-same-origin"></iframe>
      <div id="preview-placeholder" class="editor-placeholder"
           style="position:absolute;inset:0;background:var(--bg3);border-radius:var(--radius-lg);border:1px solid var(--border)">
        <div>👁 Live preview<br><span class="text-small">appears here when a file is open</span></div>
      </div>
    </div>
  </div>
  `;

  const fileSelect = document.getElementById('ed-file-select');
  const editor     = document.getElementById('code-editor');
  const saveBtn    = document.getElementById('ed-save');
  const revertBtn  = document.getElementById('ed-revert');
  const edStatus   = document.getElementById('ed-status');
  const preview    = document.getElementById('preview-frame');
  const previewPh  = document.getElementById('preview-placeholder');
  let originalContent = '';
  let previewVisible  = true;

  async function loadFile (p) {
    if (!p) return;
    S.edFile = p;
    edStatus.textContent = 'Loading…';
    const r = await _api.fs.read(p);
    if (r.error) { toast('Cannot read file: ' + r.error, 'error'); return; }
    editor.value       = r.content;
    originalContent    = r.content;
    S.edDirty          = false;
    saveBtn.disabled   = true;
    revertBtn.disabled = true;
    edStatus.textContent = p;
    refreshPreview();
  }

  function refreshPreview () {
    if (!S.edFile) return;
    if (/\.html?$/i.test(S.edFile)) {
      previewPh.style.display = 'none';
      preview.srcdoc = editor.value;
    } else if (/\.css$/i.test(S.edFile)) {
      previewPh.style.display = 'flex';
      previewPh.innerHTML = '<div style="padding:1rem;width:100%"><pre class="text-mono" style="white-space:pre-wrap;text-align:left">' +
        esc(editor.value.slice(0, 2000)) + '</pre></div>';
    } else {
      previewPh.style.display = 'flex';
      previewPh.innerHTML = '<div>📄 ' + esc(S.edFile) +
        '<br><span class="text-small text-muted">No preview for this file type</span></div>';
    }
  }

  fileSelect.onchange = function () { loadFile(fileSelect.value); };

  editor.addEventListener('input', function () {
    S.edDirty          = editor.value !== originalContent;
    saveBtn.disabled   = !S.edDirty;
    revertBtn.disabled = !S.edDirty;
    edStatus.textContent = S.edDirty ? '● Unsaved changes' : S.edFile;
    refreshPreview();
  });

  editor.addEventListener('keydown', function (e) {
    // Tab → insert 2 spaces instead of losing focus
    if (e.key === 'Tab') {
      e.preventDefault();
      var s   = editor.selectionStart;
      var end = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(end);
      editor.selectionStart = editor.selectionEnd = s + 2;
      editor.dispatchEvent(new Event('input'));
    }
    // Ctrl+S → save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveBtn.click();
    }
  });

  saveBtn.onclick = async function () {
    if (!S.edFile) return;
    const r = await _api.fs.write(S.edFile, editor.value);
    if (r.success) {
      originalContent    = editor.value;
      S.edDirty          = false;
      saveBtn.disabled   = true;
      revertBtn.disabled = true;
      edStatus.textContent = S.edFile;
      toast('File saved', 'success');
    } else toast('Save failed: ' + r.error, 'error');
  };

  revertBtn.onclick = function () {
    editor.value       = originalContent;
    S.edDirty          = false;
    saveBtn.disabled   = revertBtn.disabled = true;
    edStatus.textContent = S.edFile;
    refreshPreview();
  };

  document.getElementById('ed-preview-toggle').onclick = function () {
    previewVisible = !previewVisible;
    preview.style.display   = previewVisible ? '' : 'none';
    previewPh.style.display = previewVisible ? '' : 'none';
    this.textContent = previewVisible ? '👁 Preview' : '👁 Hide';
  };

  document.getElementById('ed-format').onclick = function () {
    if (!/\.html?$/i.test(S.edFile || '')) { toast('Format only works on HTML files', 'warning'); return; }
    editor.value = formatHTML(editor.value);
    editor.dispatchEvent(new Event('input'));
  };

  // Open file if we were sent here from the file manager
  const target = preloadFile || S.edFile;
  if (target) { fileSelect.value = target; loadFile(target); }
}

// Minimal HTML pretty-printer (indent only — not a full formatter)
function formatHTML (html) {
  var out = ''; var depth = 0;
  var tokens = html.replace(/>\s+</g, '><').split(/(?=>)|(?<=<\/[^>]+>)/);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i].trim();
    if (!t) continue;
    if (/^<\//.test(t)) depth = Math.max(0, depth - 1);
    out += '  '.repeat(depth) + t + '\n';
    if (/^<[^/!][^>]*[^/]>$/.test(t) &&
        !/^<(br|hr|img|input|link|meta|area|base|col|embed|param|source|track|wbr)[\s>]/i.test(t))
      depth++;
  }
  return out;
}

// Recursively list all files under a directory
async function getAllFiles (dir) {
  const r = await _api.fs.list(dir);
  if (r.error || !r.items) return [];
  var result = [];
  for (var i = 0; i < r.items.length; i++) {
    var item = r.items[i];
    if (item.isDir) {
      var sub = await getAllFiles(item.path);
      result = result.concat(sub);
    } else {
      result.push(item.path);
    }
  }
  return result;
}

window.openEditorFile = function (p) {
  S.edFile = p;
  navigate('editor');
};

// ═════════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ═════════════════════════════════════════════════════════════════════════════
async function renderTemplates () {
  const templates = await _api.templates.list();

  const cards = templates.map(function (t) {
    return `
    <div class="template-card" onclick="previewTemplate('${esc(t.id)}','${esc(t.name)}')">
      <div class="template-preview">
        <span>${t.emoji || '🌐'}</span>
      </div>
      <div class="template-info">
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.description || 'A website template')}</p>
        <div class="template-tags">
          ${(t.tags || []).map(function (tag) { return '<span class="template-tag">' + esc(tag) + '</span>'; }).join('')}
        </div>
        <div class="flex gap-1">
          <button class="btn btn-primary btn-sm" onclick="applyTemplate(event,'${esc(t.id)}','${esc(t.name)}')">
            ✨ Apply
          </button>
          <button class="btn btn-sm" onclick="previewTemplate('${esc(t.id)}','${esc(t.name)}')">
            👁 Preview
          </button>
        </div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('content').innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-title">Templates</div>
      <div class="page-subtitle">Ready-made designs for your website</div>
    </div>
  </div>
  <div class="card mb-2" style="background:var(--amber-bg);border-color:var(--amber)">
    <p style="font-size:.85rem;color:var(--amber)">
      ⚠️ Applying a template will overwrite your current <code>index.html</code> and style files.
      Use the File Manager to back up your site first if you want to keep your current design.
    </p>
  </div>
  <div class="template-grid">${cards || '<p class="text-muted">No templates found.</p>'}</div>
  `;
}

window.previewTemplate = async function (id, name) {
  const r = await _api.templates.preview(id);
  if (r.error) { toast('Cannot load preview: ' + r.error, 'error'); return; }
  showModal('Preview — ' + name, `
    <iframe srcdoc="${esc(r.content)}"
            style="width:100%;height:70vh;border:none;border-radius:8px;background:#fff"
            sandbox="allow-scripts"></iframe>
    <div class="flex gap-1 mt-2">
      <button class="btn btn-primary w-full" onclick="applyTemplate(null,'${esc(id)}','${esc(name)}')">
        ✨ Apply This Template
      </button>
      <button class="btn w-full" onclick="closeModal()">Close</button>
    </div>
  `);
};

window.applyTemplate = function (e, id, name) {
  if (e) e.stopPropagation();
  closeModal();
  showModal('Apply Template', `
    <h2>Apply "${esc(name)}"?</h2>
    <p class="text-muted mb-2">This will overwrite your existing site files. Backups are not automatic.</p>
    <div class="flex gap-1">
      <button class="btn btn-primary w-full" onclick="doApplyTemplate('${esc(id)}')">✨ Apply</button>
      <button class="btn w-full" onclick="closeModal()">Cancel</button>
    </div>
  `);
};

window.doApplyTemplate = async function (id) {
  closeModal();
  const r = await _api.templates.apply(id);
  if (r.success) {
    toast('Template applied! Open the editor to customise it.', 'success');
    navigate('files');
  } else toast('Failed: ' + r.error, 'error');
};

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ═════════════════════════════════════════════════════════════════════════════
async function renderLog () {
  document.getElementById('content').innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-title">Activity Log</div>
      <div class="page-subtitle">All web and FTP access, most recent first</div>
    </div>
    <div class="flex gap-1">
      <button class="btn" id="log-refresh">↻ Refresh</button>
      <button class="btn" id="log-export">⬇ Export CSV</button>
      <button class="btn btn-danger" id="log-clear">🗑 Clear Log</button>
    </div>
  </div>

  <div class="log-toolbar">
    <div class="log-filter">
      <select id="log-type-filter">
        <option value="ALL">All Types</option>
        <option value="WEB">Web only</option>
        <option value="FTP">FTP only</option>
      </select>
      <input type="text" id="log-search" placeholder="Filter by IP or path…" style="width:220px">
    </div>
    <span id="log-count" class="text-muted text-small"></span>
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <div class="log-table-wrap" style="max-height:calc(100vh - 280px);overflow-y:auto">
      <table class="log-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>IP Address</th>
            <th>Type</th>
            <th>Method</th>
            <th>Path / Action</th>
            <th>Status</th>
            <th style="width:60px">Bytes</th>
            <th>User Agent</th>
          </tr>
        </thead>
        <tbody id="log-body">
          <tr><td colspan="8" class="log-empty"><span class="spinner"></span></td></tr>
        </tbody>
      </table>
    </div>
  </div>
  `;

  var allEntries = [];

  async function loadLog () {
    const r = await _api.log.get(2000);
    allEntries = r.entries || [];
    renderLogRows();
    var countEl = document.getElementById('log-count');
    if (countEl) countEl.textContent = allEntries.length.toLocaleString() + ' entries';
  }

  function renderLogRows () {
    var typeF  = document.getElementById('log-type-filter').value;
    var search = (document.getElementById('log-search').value || '').toLowerCase();
    var rows   = allEntries.filter(function (e) {
      if (typeF !== 'ALL' && e.type !== typeF) return false;
      if (search && !String(e.ip || '').toLowerCase().includes(search)
                 && !String(e.path || '').toLowerCase().includes(search)) return false;
      return true;
    });

    var html = rows.length ? rows.map(function (e) {
      var statusClass = !e.status ? ''
        : Number(e.status) < 300 ? 'status-ok'
        : Number(e.status) < 400 ? 'status-warn' : 'status-err';
      var typeBadge = e.type === 'FTP'
        ? '<span class="badge badge-ftp">FTP</span>'
        : '<span class="badge badge-web">WEB</span>';
      var ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
      return `<tr>
        <td class="text-muted text-small">${esc(ts)}</td>
        <td class="text-mono">${esc(e.ip || '')}</td>
        <td>${typeBadge}</td>
        <td class="text-mono text-small">${esc(e.method || '')}</td>
        <td title="${esc(e.path || '')}" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(e.path || '')}</td>
        <td class="${statusClass} text-mono">${esc(e.status || '')}</td>
        <td class="text-muted">${e.bytes ? fmtBytes(Number(e.bytes)) : '—'}</td>
        <td class="text-muted text-small" title="${esc(e.userAgent || '')}"
            style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(e.userAgent || '')}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="8" class="log-empty">📭 No entries match your filter</td></tr>';

    var body = document.getElementById('log-body');
    if (body) body.innerHTML = html;
  }

  document.getElementById('log-type-filter').onchange = renderLogRows;
  document.getElementById('log-search').oninput = renderLogRows;
  document.getElementById('log-refresh').onclick = loadLog;

  document.getElementById('log-export').onclick = async function () {
    const r = await _api.log.export();
    if (r.success) toast('Log exported to ' + r.path, 'success');
    else if (r.success === false) toast('Export cancelled', 'info');
  };

  document.getElementById('log-clear').onclick = function () {
    showModal('Clear Log', `
      <p class="mb-2">Clear all ${allEntries.length} log entries?</p>
      <p class="text-muted text-small mb-2">This cannot be undone. Export first if you need a copy.</p>
      <div class="flex gap-1">
        <button class="btn btn-danger w-full" onclick="doClearLog()">Clear All Entries</button>
        <button class="btn w-full" onclick="closeModal()">Cancel</button>
      </div>
    `);
  };

  window.doClearLog = async function () {
    closeModal();
    await _api.log.clear();
    toast('Log cleared', 'success');
    await loadLog();
  };

  await loadLog();
}

// ═════════════════════════════════════════════════════════════════════════════
// GUESTBOOK
// ═════════════════════════════════════════════════════════════════════════════
async function renderGuestbook () {
  const messages = await _api.guestbook.messages();

  const rows = messages.length
    ? messages.slice().reverse().map(function (m) {
        var d = new Date(m.timestamp).toLocaleString();
        return '<tr>' +
          '<td style="padding:.5rem .6rem;max-width:120px;overflow:hidden;text-overflow:ellipsis">' + esc(m.name) + '</td>' +
          '<td style="padding:.5rem .6rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:pre-wrap">' + esc(m.message) + '</td>' +
          '<td class="text-muted text-small" style="padding:.5rem .6rem;white-space:nowrap">' + esc(d) + '</td>' +
          '<td style="padding:.5rem .6rem">' +
            '<button class="btn btn-sm btn-danger" onclick="gbDelete(\'' + esc(m.id) + '\')">🗑</button>' +
          '</td>' +
          '</tr>';
      }).join('')
    : '<tr><td colspan="4" class="log-empty">📭 No messages yet</td></tr>';

  document.getElementById('content').innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-title">Guestbook</div>
      <div class="page-subtitle">Messages left by visitors — ${messages.length} total</div>
    </div>
    <div class="flex gap-1">
      <button class="btn btn-primary" onclick="gbDeploy()">📄 Add to Site</button>
      <button class="btn" onclick="renderGuestbook()">↻ Refresh</button>
    </div>
  </div>

  <div class="card mb-2" style="background:var(--green-bg);border-color:var(--green)">
    <p style="font-size:.84rem;color:var(--green)">
      ✅ The <strong>Add to Site</strong> button copies <code>guestbook.html</code> to your website root
      so visitors can leave messages. Make sure your server is running and link to
      <code>/guestbook.html</code> from your homepage.
    </p>
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <div style="overflow-x:auto">
      <table class="file-table">
        <thead><tr>
          <th>Name</th>
          <th>Message</th>
          <th style="width:160px">Date</th>
          <th style="width:60px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  `;
}

window.gbDelete = async function (id) {
  if (!confirm('Delete this message?')) return;
  var r = await _api.guestbook.delete(id);
  if (r.success) { toast('Message deleted', 'success'); renderGuestbook(); }
  else toast('Error: ' + r.error, 'error');
};

window.gbDeploy = async function () {
  var r = await _api.guestbook.deploy();
  if (r.success) toast('guestbook.html added to your website root!', 'success');
  else toast('Deploy failed: ' + r.error, 'error');
};

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
var _setupBanner = false;
function showSetupBanner () { _setupBanner = true; }

async function renderSettings () {
  const cfg     = S.config;
  const [wwwRoot, userList] = await Promise.all([
    _api.fs.wwwroot(),
    _api.users.list(),
  ]);

  document.getElementById('content').innerHTML = `
  ${_setupBanner ? `<div class="setup-banner mb-2">
    <h2>👋 Welcome to My Own Place!</h2>
    <p>Set a password below to protect your server, then you're ready to go.</p>
  </div>` : ''}

  <div class="page-header">
    <div>
      <div class="page-title">Settings</div>
      <div class="page-subtitle">Configure your personal server</div>
    </div>
    <button class="btn btn-primary" id="save-settings">💾 Save Settings</button>
  </div>

  <!-- Server identity -->
  <div class="settings-section">
    <h3>Server Identity</h3>
    <div class="form-group">
      <label>Server Name</label>
      <input class="form-control" id="s-name" value="${esc(cfg.serverName || 'My Own Place')}"
             placeholder="My Own Place" style="max-width:360px">
      <div class="form-hint">Shown on the login page your visitors see.</div>
    </div>
  </div>

  <!-- Security -->
  <div class="settings-section">
    <h3>Security</h3>
    <div class="toggle-row">
      <div class="tr-info">
        <h4>Password Protection</h4>
        <p>Require a password before visitors can access your site</p>
      </div>
      <label class="switch">
        <input type="checkbox" id="s-pw-protect" ${cfg.enablePasswordProtection ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    </div>
    <div class="form-group mt-2">
      <label>New Password</label>
      <div class="settings-row">
        <input class="form-control" type="password" id="s-pw"
               placeholder="Leave blank to keep current password"
               style="max-width:300px" autocomplete="new-password">
        <button class="btn btn-sm" id="pw-toggle">Show</button>
      </div>
      <div class="form-hint">
        ${cfg.password
          ? '✅ A password is currently set.'
          : '⚠️ No password is set — anyone can access your files!'}
      </div>
    </div>
  </div>

  <!-- User Accounts -->
  <div class="settings-section">
    <h3>User Accounts</h3>
    <p class="form-hint" style="margin-bottom:.9rem">
      Add multiple users so different people can log in with their own credentials.
      When users are configured the login page shows a username field.
      If no users are added, the single password above is used instead.
    </p>
    ${userList.length ? `
    <table style="width:100%;border-collapse:collapse;font-size:.86rem;margin-bottom:.75rem">
      <thead><tr>
        <th style="text-align:left;padding:.35rem .5rem;color:var(--text2);font-size:.72rem;
                   text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Username</th>
        <th style="text-align:center;padding:.35rem .5rem;color:var(--text2);font-size:.72rem;
                   text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)">Enabled</th>
        <th style="border-bottom:1px solid var(--border)"></th>
      </tr></thead>
      <tbody>
        ${userList.map(function (u) { return `
        <tr>
          <td style="padding:.45rem .5rem">${esc(u.username)}</td>
          <td style="padding:.45rem .5rem;text-align:center">
            <label class="switch" style="display:inline-block">
              <input type="checkbox" onchange="toggleUser('${esc(u.id)}',this.checked)"
                     ${u.enabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </td>
          <td style="padding:.45rem .5rem">
            <div class="flex gap-1">
              <button class="btn btn-sm" onclick="changeUserPw('${esc(u.id)}','${esc(u.username)}')">🔑 Change PW</button>
              <button class="btn btn-sm btn-danger" onclick="deleteUser('${esc(u.id)}','${esc(u.username)}')">🗑</button>
            </div>
          </td>
        </tr>`; }).join('')}
      </tbody>
    </table>` : `<p class="text-muted text-small" style="margin-bottom:.75rem">No users configured — using the single password above.</p>`}
    <button class="btn" onclick="promptAddUser()">+ Add User</button>
  </div>

  <!-- Web server -->
  <div class="settings-section">
    <h3>Web Server</h3>
    <div class="form-group">
      <label>HTTP Port</label>
      <input class="form-control" type="number" id="s-webport"
             value="${cfg.webPort || 8080}" min="1024" max="65535" style="max-width:160px">
      <div class="form-hint">Your site will be reachable at <code>http://YOUR_IP:PORT/</code>. Default: 8080.</div>
    </div>
  </div>

  <!-- FTP server -->
  <div class="settings-section">
    <h3>FTP Server</h3>
    <div class="toggle-row">
      <div class="tr-info">
        <h4>Enable FTP Server</h4>
        <p>Allow FTP clients (FileZilla, WinSCP) to connect and manage files remotely</p>
      </div>
      <label class="switch">
        <input type="checkbox" id="s-ftp" ${cfg.enableFTP ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    </div>
    <div id="ftp-options" class="${cfg.enableFTP ? '' : 'hidden'}">
      <hr class="divider">
      <div class="form-group">
        <label>FTP Port</label>
        <input class="form-control" type="number" id="s-ftpport"
               value="${cfg.ftpPort || 2121}" min="1024" max="65535" style="max-width:160px">
        <div class="form-hint">Default: 2121. Port 21 requires administrator rights.</div>
      </div>
      <div class="form-group">
        <label>FTP Username</label>
        <input class="form-control" id="s-ftpuser"
               value="${esc(cfg.ftpUsername || 'myownplace')}"
               style="max-width:240px" autocomplete="off">
      </div>
    </div>
  </div>

  <!-- Scheduling -->
  <div class="settings-section">
    <h3>Scheduling</h3>
    <div class="toggle-row">
      <div class="tr-info">
        <h4>Auto Start / Stop</h4>
        <p>Automatically start the server at a set time and stop it later</p>
      </div>
      <label class="switch">
        <input type="checkbox" id="s-sched" ${cfg.scheduleEnabled ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    </div>
    <div id="sched-options" class="${cfg.scheduleEnabled ? '' : 'hidden'}">
      <hr class="divider">
      <div class="flex gap-2" style="flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin-bottom:0">
          <label>Start Time</label>
          <input class="form-control" type="time" id="s-sched-start"
                 value="${esc(cfg.scheduleStart || '08:00')}" style="max-width:160px">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>Stop Time</label>
          <input class="form-control" type="time" id="s-sched-stop"
                 value="${esc(cfg.scheduleStop || '23:00')}" style="max-width:160px">
        </div>
      </div>
      <p class="form-hint mt-1">
        The server will start at <strong id="sched-start-preview">${esc(cfg.scheduleStart || '08:00')}</strong>
        and stop at <strong id="sched-stop-preview">${esc(cfg.scheduleStop || '23:00')}</strong> every day.
        Overnight windows (e.g. 22:00 → 06:00) are supported.
      </p>
    </div>
  </div>

  <!-- Website files -->
  <div class="settings-section">
    <h3>Website Files</h3>
    <div class="form-group">
      <label>Website Root Folder</label>
      <div class="path-row">
        <input class="form-control" id="s-wwwroot" value="${esc(wwwRoot)}" readonly>
        <button class="btn" id="browse-wwwroot">Browse…</button>
        <button class="btn" onclick="openWwwFolder()">📂 Open</button>
      </div>
      <div class="form-hint">All files in this folder are served to your visitors.</div>
    </div>
  </div>

  <!-- About -->
  <div class="settings-section">
    <h3>About My Own Place</h3>
    <table style="font-size:.85rem;width:100%">
      <tr><td class="text-muted" style="width:160px">Version</td><td>1.0.0</td></tr>
      <tr><td class="text-muted">Your Local IP</td><td class="text-mono">${S.ip}</td></tr>
      <tr><td class="text-muted">Data folder</td>
          <td class="text-mono text-small">AppData\\Roaming\\my-own-place</td></tr>
      <tr><td class="text-muted">Debug log</td>
          <td class="text-mono text-small">%TEMP%\\myownplace-debug.log</td></tr>
    </table>
    <div class="form-hint mt-1">Share your IP address with friends so they can visit your site!</div>
  </div>
  `;

  // Show / hide FTP port options when the toggle changes
  document.getElementById('s-ftp').onchange = function () {
    document.getElementById('ftp-options').classList.toggle('hidden', !this.checked);
  };

  // Show / hide schedule time fields
  document.getElementById('s-sched').onchange = function () {
    document.getElementById('sched-options').classList.toggle('hidden', !this.checked);
  };
  // Live-preview the start/stop times in the hint text
  function updateSchedPreview () {
    var s = document.getElementById('s-sched-start');
    var e = document.getElementById('s-sched-stop');
    var ps = document.getElementById('sched-start-preview');
    var pe = document.getElementById('sched-stop-preview');
    if (s && ps) ps.textContent = s.value;
    if (e && pe) pe.textContent = e.value;
  }
  var ss = document.getElementById('s-sched-start');
  var se = document.getElementById('s-sched-stop');
  if (ss) ss.addEventListener('input', updateSchedPreview);
  if (se) se.addEventListener('input', updateSchedPreview);

  // Show / hide password text
  document.getElementById('pw-toggle').onclick = function () {
    var inp  = document.getElementById('s-pw');
    var show = inp.type === 'password';
    inp.type     = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  };

  // Browse for www root folder
  document.getElementById('browse-wwwroot').onclick = async function () {
    const r = await _api.shell.pickFolder();
    if (!r.canceled && r.filePaths[0])
      document.getElementById('s-wwwroot').value = r.filePaths[0];
  };

  // Save settings
  document.getElementById('save-settings').onclick = async function () {
    var pw = document.getElementById('s-pw').value;
    var updates = {
      serverName:               (document.getElementById('s-name').value.trim()    || 'My Own Place'),
      enablePasswordProtection:  document.getElementById('s-pw-protect').checked,
      webPort:                   parseInt(document.getElementById('s-webport').value, 10) || 8080,
      enableFTP:                 document.getElementById('s-ftp').checked,
      ftpPort:                   parseInt(document.getElementById('s-ftpport').value, 10) || 2121,
      ftpUsername:              (document.getElementById('s-ftpuser').value.trim()  || 'myownplace'),
      scheduleEnabled:           document.getElementById('s-sched').checked,
      scheduleStart:            (document.getElementById('s-sched-start').value || '08:00'),
      scheduleStop:             (document.getElementById('s-sched-stop').value  || '23:00'),
      wwwRoot:                   document.getElementById('s-wwwroot').value.trim(),
      setupComplete:             true,
    };
    if (pw) updates.password = pw;

    const r = await _api.config.set(updates);
    if (r.success) {
      _setupBanner = false;
      // Reload config into S.config so the rest of the app sees the new values
      try { S.config = await timed(_api.config.get(), 'post-save config:get', 4000); } catch (_) {}
      toast('Settings saved!', 'success');
      if (S.serverOn) toast('Restart the server for port / FTP changes to take effect.', 'warning');
      // Re-render the page so the password hint updates
      renderSettings();
    } else {
      toast('Save failed — check the debug log', 'error');
    }
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Utilities
// ═════════════════════════════════════════════════════════════════════════════

function toast (msg, type) {
  type = type || 'info';
  var el = document.createElement('div');
  el.className  = 'toast ' + type;
  el.textContent = msg;
  var tc = document.getElementById('toast-container');
  if (tc) tc.prepend(el);
  setTimeout(function () {
    el.classList.add('fade-out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
  }, 3500);
}

function showModal (title, bodyHtml) {
  var mc = document.getElementById('modal-content');
  if (mc) mc.innerHTML = '<h2>' + esc(title) + '</h2><div style="margin-top:.5rem">' + bodyHtml + '</div>';
  var mb = document.getElementById('modal-backdrop');
  if (mb) mb.classList.remove('hidden');
  // Auto-focus first input / textarea in the modal
  setTimeout(function () {
    var inp = document.querySelector('#modal-content input, #modal-content textarea');
    if (inp) inp.focus();
  }, 50);
}

function closeModal () {
  var mb = document.getElementById('modal-backdrop');
  if (mb) mb.classList.add('hidden');
  var mc = document.getElementById('modal-content');
  if (mc) mc.innerHTML = '';
}
window.closeModal = closeModal;

// HTML-escape a value for safe insertion into innerHTML
function esc (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes (b) {
  if (b < 1024)       return b + ' B';
  if (b < 1048576)    return (b / 1024).toFixed(1)       + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1)    + ' MB';
  return                     (b / 1073741824).toFixed(1) + ' GB';
}

function fileIcon (name) {
  var ext = (name.split('.').pop() || '').toLowerCase();
  var map = {
    html:'🌐', htm:'🌐', css:'🎨', js:'📜', json:'📋',
    png:'🖼',  jpg:'🖼', jpeg:'🖼', gif:'🖼', svg:'🖼', webp:'🖼',
    mp4:'🎬',  mov:'🎬', mp3:'🎵', wav:'🎵',
    pdf:'📕',  zip:'📦', rar:'📦', txt:'📄', md:'📄',
    xml:'📋',  csv:'📊',
  };
  return map[ext] || '📄';
}

window.copyText = function (text) {
  navigator.clipboard.writeText(text).then(function () { toast('Copied!', 'success'); });
};

window.openBrowser = function (url) {
  _api.shell.open(url);
};

window.openWwwFolder = async function () {
  var root = await _api.fs.wwwroot();
  _api.shell.openFolder(root);
};

// ═════════════════════════════════════════════════════════════════════════════
// THEME TOGGLE
// ═════════════════════════════════════════════════════════════════════════════

function applyTheme (theme) {
  // 'light' adds the class; 'dark' (default) removes it
  document.body.classList.toggle('light', theme === 'light');
  var btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀';
  btn && (btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
}

window.toggleTheme = function () {
  var current = document.body.classList.contains('light') ? 'light' : 'dark';
  var next    = current === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('mop-theme', next); } catch (_) {}
  applyTheme(next);
};

// Apply saved theme immediately (before init() so there's no flash)
(function () {
  var saved = 'dark';
  try { saved = localStorage.getItem('mop-theme') || 'dark'; } catch (_) {}
  applyTheme(saved);
}());

// ═════════════════════════════════════════════════════════════════════════════
// DOM SETUP + BOOT
// The <script> tag is at the bottom of <body> so the DOM is fully available
// here.  We set up all synchronous event listeners first, then call init().
// ═════════════════════════════════════════════════════════════════════════════

// Null-safe getElementById wrapper
function byId (id) { return document.getElementById(id); }

// Title-bar buttons
var _min = byId('btn-minimize'); if (_min) _min.onclick = function () { window.api && window.api.win.minimize(); };
var _max = byId('btn-maximize'); if (_max) _max.onclick = function () { window.api && window.api.win.maximize(); };
var _cls = byId('btn-close');    if (_cls) _cls.onclick = function () { window.api && window.api.win.close();    };

// Sidebar navigation
document.querySelectorAll('.nav-list li').forEach(function (li) {
  li.addEventListener('click', function () {
    navigate(li.dataset.page).catch(showCrash);
  });
});

// Modal close
var _mc = byId('modal-close');    if (_mc) _mc.onclick = closeModal;
var _mb = byId('modal-backdrop'); if (_mb) _mb.onclick = function (e) {
  if (e.target.id === 'modal-backdrop') closeModal();
};

// Keyboard shortcuts
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeModal();
});

// ── Scheduled auto-start / auto-stop notifications ────────────────────────────
if (window.api && window.api.server.onAutoStart) {
  window.api.server.onAutoStart(function () {
    refreshIndicator(true);
    if (S.page === 'dashboard') renderDashboard();
    else toast('Server started automatically (scheduled)', 'info');
  });
  window.api.server.onAutoStop(function () {
    refreshIndicator(false);
    if (S.page === 'dashboard') renderDashboard();
    else toast('Server stopped automatically (scheduled)', 'info');
  });
}

// ── Auto-update notifications ─────────────────────────────────────────────────
if (window.api && window.api.updater) {
  window.api.updater.onUpdateAvailable(function (version) {
    toast('Update v' + version + ' downloading in the background…', 'info');
  });
  window.api.updater.onUpdateDownloaded(function (version) {
    // Show a persistent banner with a restart button
    var banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.style.cssText = [
      'position:fixed;bottom:1rem;right:1rem;z-index:9999',
      'background:#1f6feb;color:#fff;border-radius:10px',
      'padding:.75rem 1.25rem;display:flex;align-items:center;gap:1rem',
      'box-shadow:0 4px 20px #00000066;font-size:.9rem'
    ].join(';');
    banner.innerHTML = '🔄 Update v' + esc(version) + ' ready — '
      + '<button onclick="window.api.updater.install()" style="'
      + 'background:#fff;color:#1f6feb;border:none;border-radius:6px;'
      + 'padding:.3rem .8rem;font-weight:700;cursor:pointer">Restart & Update</button>'
      + '<button onclick="this.parentNode.remove()" style="'
      + 'background:none;border:none;color:#ffffffaa;cursor:pointer;font-size:1.1rem">✕</button>';
    document.body.appendChild(banner);
  });
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
// Call init() directly — no DOMContentLoaded wrapper needed because this
// script tag is at the bottom of <body> so the DOM is already complete.
init().catch(showCrash);
