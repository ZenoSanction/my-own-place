/*  My Own Place — Access Logger
    Appends structured CSV rows to the access log file.
    All server modules (web + FTP) call appendLog() to record activity.
*/

const fs   = require('fs');
const path = require('path');

const HEADER = 'Timestamp,IP,Type,Method,Path,Status,UserAgent,Bytes\n';

function ensureLog (logPath) {
  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, HEADER);
  }
}

function csvEscape (val) {
  const s = String(val ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/**
 * @param {string} logPath  - absolute path to access.csv
 * @param {object} entry    - { ip, type, method, path, status, userAgent, bytes }
 */
function appendLog (logPath, { ip='', type='WEB', method='GET',
                                reqPath='/', status=200,
                                userAgent='', bytes=0 } = {}) {
  try {
    ensureLog(logPath);
    const ts  = new Date().toISOString();
    const row = [ts, ip, type, method, reqPath, status, userAgent, bytes]
                  .map(csvEscape).join(',') + '\n';
    fs.appendFileSync(logPath, row);
  } catch (_) { /* never crash the server over a log write */ }
}

module.exports = { appendLog };
