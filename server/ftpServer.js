/*  My Own Place — FTP Server (ftp-srv)  v1.2
    ─────────────────────────────────────────
    • PASV-mode FTP, single-user auth, full access logging.

    Fixes vs v1.1:
    • bunyan (ftp-srv's internal logger) tries to write to stdout.  In
      Electron's main process stdout can be closed/blocked, which stalls
      the bunyan write and freezes the Bluebird promise chain inside
      ftp-srv's listen() call.  We now pass an explicit no-op Writable
      stream so bunyan never touches stdout at all.
    • pasv_url changed from '0.0.0.0' (invalid for real connections) to
      the machine's actual LAN IP.
    • listen() is wrapped in Promise.resolve().then() to ensure we always
      get a native Promise, avoiding Bluebird / Electron interop edge cases.
    • Timeout increased to 10 s with a plain net.createServer pre-check:
      we probe the port first so we can give a clearer "port in use" error
      instead of a generic timeout.
*/

'use strict';

const net    = require('net');
const os     = require('os');
const crypto = require('crypto');
const { appendLog } = require('./logger');

const LISTEN_TIMEOUT_MS = 10000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getLocalIP () {
  try {
    for (const ifaces of Object.values(os.networkInterfaces()))
      for (const iface of ifaces)
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  } catch (_) {}
  return '127.0.0.1';
}

function verifyPBKDF2 (pw, stored) {
  if (!stored) return !pw;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex') === hash;
}

// Quick TCP probe: can we bind to this port right now?
// Returns a resolved promise if the port is free, rejects if it's in use.
function probePort (port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', err => reject(err));
    probe.listen(port, '0.0.0.0', () => probe.close(resolve));
  });
}

// ── Main factory ──────────────────────────────────────────────────────────────
async function createFtpServer (config, logPath) {
  const { ftpPort, ftpUsername, password, wwwRoot } = config;
  const pasvMin = ftpPort + 100;
  const pasvMax = ftpPort + 200;
  const localIp = getLocalIP();

  // ── Pre-flight port check ─────────────────────────────────────────────────
  // Quickly verify the port is bindable before handing off to ftp-srv.
  // This gives a specific "port in use" error instead of a 10-second timeout.
  try {
    await probePort(ftpPort);
  } catch (e) {
    throw new Error(
      `FTP port ${ftpPort} is already in use by another application.\n` +
      `Change the FTP port in Settings, or stop the other application first.`
    );
  }

  // ── Load ftp-srv ──────────────────────────────────────────────────────────
  const FtpSrv = require('ftp-srv');

  // ftp-srv assigns options.log directly as its logger and calls methods like
  // .info(), .debug(), .child() on it.  We must supply a real object with all
  // those methods — a plain { name, streams } config object (our previous
  // attempt) doesn't have them and causes a silent "is not a function" crash.
  //
  // Solution: build a no-op logger that satisfies every method bunyan exposes.
  // child() must return the same no-op logger so nested loggers are also silent.
  const noop = () => {};
  const nullLogger = {
    trace: noop, debug: noop, info: noop,
    warn:  noop, error: noop, fatal: noop,
    child () { return nullLogger; },
  };

  const server = new FtpSrv({
    url:       `ftp://0.0.0.0:${ftpPort}`,
    anonymous: false,
    pasv_url:  localIp,     // must be the real LAN IP, not 0.0.0.0
    pasv_min:  pasvMin,
    pasv_max:  pasvMax,
    log:       nullLogger,  // fully silent — no stdout writes at all
  });

  // ── Auth / event handler ──────────────────────────────────────────────────
  server.on('login', ({ connection, username, password: pw }, resolve, reject) => {
    const ip = connection.ip || '?';
    if (username === ftpUsername && verifyPBKDF2(pw, password)) {
      appendLog(logPath, {
        ip, type: 'FTP', method: 'LOGIN',
        reqPath: '/', status: 230,
        userAgent: `FTP:${username}`, bytes: 0,
      });

      connection.on('RETR', (err, filePath) =>
        appendLog(logPath, { ip, type: 'FTP', method: 'RETR',
          reqPath: filePath || '?', status: err ? 550 : 226,
          userAgent: `FTP:${username}`, bytes: 0 }));

      connection.on('STOR', (err, filePath) =>
        appendLog(logPath, { ip, type: 'FTP', method: 'STOR',
          reqPath: filePath || '?', status: err ? 553 : 226,
          userAgent: `FTP:${username}`, bytes: 0 }));

      connection.on('DELE', (err, filePath) =>
        appendLog(logPath, { ip, type: 'FTP', method: 'DELE',
          reqPath: filePath || '?', status: err ? 550 : 250,
          userAgent: `FTP:${username}`, bytes: 0 }));

      resolve({ root: wwwRoot });
    } else {
      appendLog(logPath, {
        ip, type: 'FTP', method: 'LOGIN',
        reqPath: '/', status: 530,
        userAgent: `FTP:${username}`, bytes: 0,
      });
      reject(new Error('Invalid credentials'));
    }
  });

  // ── Start listening ───────────────────────────────────────────────────────
  // Wrap in Promise.resolve().then() to guarantee a native Promise regardless
  // of whether ftp-srv returns a Bluebird promise or something else.
  // Race against a hard timeout so a stalled listen() never blocks the UI.
  const listenPromise = Promise.resolve().then(() => server.listen());

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() =>
      reject(new Error(
        `FTP server did not start within ${LISTEN_TIMEOUT_MS / 1000}s.\n` +
        `If a Windows Security Alert appeared, click "Allow Access" and try again.\n` +
        `You can also disable FTP in Settings if you don't need it.`
      )),
      LISTEN_TIMEOUT_MS
    )
  );

  await Promise.race([listenPromise, timeoutPromise]);

  return {
    stop () {
      try { return server.close(); } catch (_) {}
    },
  };
}

module.exports = { createFtpServer };
