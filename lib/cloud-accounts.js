const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { probePath } = require('./fs-probe');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
// Cloud mounts (DriveFS drive letters, ~/Library/CloudStorage, OneDrive) are
// the one place discovery can HANG instead of failing, so every existence check
// here carries a deadline. See lib/fs-probe.js for the incident this prevents.
const MOUNT_PROBE_TIMEOUT_MS = 2000;
const exists = target => probePath(target, { timeoutMs: MOUNT_PROBE_TIMEOUT_MS });
const readdirBounded = async (dir) => {
  if (!(await exists(dir))) return [];
  try { return await fs.promises.readdir(dir); } catch { return []; }
};

const EMAIL_RE_SOURCE = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const EMAIL_RE = new RegExp(`^${EMAIL_RE_SOURCE}$`, 'i');

function addAccount(accounts, seen, provider, label, basePath) {
  const drivePath = path.join(basePath, 'clipboard-tray');
  if (seen.has(drivePath)) return;
  seen.add(drivePath);
  accounts.push({ provider, label, email: label, path: drivePath });
}

function normalizeDriveLetter(value) {
  const match = String(value || '').trim().match(/^([A-Z]):?\\?$/i);
  return match ? match[1].toUpperCase() : null;
}

function setEmailByDriveLetter(map, letter, email) {
  const normalizedLetter = normalizeDriveLetter(letter);
  const normalizedEmail = String(email || '').trim();
  if (!normalizedLetter || !EMAIL_RE.test(normalizedEmail)) return;
  map.set(normalizedLetter, normalizedEmail);
}

function mergeMissingDriveEmails(target, source) {
  for (const [letter, email] of source) {
    if (!target.has(letter)) target.set(letter, email);
  }
}

function driveFsBaseDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Google', 'DriveFS');
}

function getDriveEmailsFromPreferenceCache() {
  const emails = new Map();
  const baseDir = driveFsBaseDir();
  const googleDriveNameRe = new RegExp(
    `(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?` +
    `(${EMAIL_RE_SOURCE}) - Google(?: Drive|\\.\\.\\.).{0,16}?([A-Z]):\\\\`,
    'gi'
  );

  for (const name of ['root_preference_sqlite.db', 'root_preference_sqlite.db-wal']) {
    try {
      const text = fs.readFileSync(path.join(baseDir, name)).toString('latin1');
      for (const match of text.matchAll(googleDriveNameRe)) {
        setEmailByDriveLetter(emails, match[2], match[1]);
      }
    } catch {}
  }

  return emails;
}

function getDriveEmailsFromRecentLogs() {
  const emails = new Map();
  const logDir = path.join(driveFsBaseDir(), 'Logs');
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .filter(name => /^drive_fs(?:_\d+)?\.txt$/i.test(name))
      .map(name => {
        const filePath = path.join(logDir, name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(-8);
  } catch {
    return emails;
  }

  const logMountRe = new RegExp(
    `name:\\s*(${EMAIL_RE_SOURCE}) - Google(?: Drive|\\.\\.\\.).*?mount_point(?:\\(raw\\))?:\\s*"?([A-Z]):\\\\`,
    'gi'
  );

  for (const { filePath } of files) {
    try {
      const buf = fs.readFileSync(filePath);
      const tail = buf.length > 2 * 1024 * 1024 ? buf.subarray(buf.length - 2 * 1024 * 1024) : buf;
      const text = tail.toString('utf-8');
      for (const match of text.matchAll(logMountRe)) {
        setEmailByDriveLetter(emails, match[2], match[1]);
      }
    } catch {}
  }

  return emails;
}

async function getWindowsMountLetters() {
  const letters = new Set();

  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Google\\DriveFS', '/v', 'PerAccountPreferences'],
      { windowsHide: true, timeout: 3000 }
    );
    const match = stdout.match(/REG_\w+\s+(.+)/);
    if (match) {
      const prefs = JSON.parse(match[1].trim());
      for (const acct of prefs.per_account_preferences || []) {
        const letter = normalizeDriveLetter(acct.value && acct.value.mount_point_path);
        if (letter) letters.add(letter);
      }
    }
  } catch {}

  // Probed in PARALLEL, each with a deadline: a wedged letter costs 2 s once
  // instead of blocking the main thread for ever.
  const probedLetters = await Promise.all([...'GHIJKLMNOPQRSTUVWXYZ'].map(
    async letter => (await exists(`${letter}:\\My Drive`) ? letter : null)
  ));
  for (const letter of probedLetters) {
    if (letter) letters.add(letter);
  }

  return letters;
}

async function getPsDriveInfo() {
  const letters = new Set();
  const emails = new Map();

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-PSDrive -PSProvider FileSystem | ForEach-Object { "$($_.Name)|$($_.Description)" }',
      ],
      { windowsHide: true, timeout: 5000 }
    );
    for (const line of stdout.split(/\r?\n/)) {
      const [name, desc] = line.split('|');
      const letter = normalizeDriveLetter(name);
      if (!letter) continue;
      letters.add(letter);

      const emailMatch = String(desc || '').match(new RegExp(`(${EMAIL_RE_SOURCE})`, 'i'));
      if (emailMatch) setEmailByDriveLetter(emails, name, emailMatch[1]);
    }
  } catch {}

  return { letters, emails };
}

async function getMacAccounts(accounts, seen) {
  const cloudBase = path.join(os.homedir(), 'Library', 'CloudStorage');
  try {
    for (const entry of await readdirBounded(cloudBase)) {
      if (entry === 'GoogleDrive') {
        const myDrive = path.join(cloudBase, entry, 'My Drive');
        if (await exists(myDrive)) addAccount(accounts, seen, 'google', 'Google Drive', myDrive);
      } else if (entry.startsWith('GoogleDrive-')) {
        const myDrive = path.join(cloudBase, entry, 'My Drive');
        if (await exists(myDrive)) {
          addAccount(accounts, seen, 'google', entry.replace('GoogleDrive-', '').replace(/_/g, '.'), myDrive);
        }
      } else if (entry === 'OneDrive' || entry.startsWith('OneDrive-')) {
        const label = entry === 'OneDrive' ? 'OneDrive' : entry.replace('OneDrive-', 'OneDrive - ').replace(/_/g, '.');
        addAccount(accounts, seen, 'onedrive', label, path.join(cloudBase, entry));
      }
    }
  } catch {}

  const iCloud = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (await exists(iCloud)) addAccount(accounts, seen, 'icloud', 'iCloud Drive', iCloud);
}

async function addWindowsOneDriveAccounts(accounts, seen) {
  const envCandidates = [
    ['OneDrive Business', process.env.OneDriveCommercial],
    ['OneDrive Personal', process.env.OneDriveConsumer],
    ['OneDrive', process.env.OneDrive],
  ];
  for (const [name, dir] of envCandidates) {
    if (dir && await exists(dir)) addAccount(accounts, seen, 'onedrive', name, dir);
  }

  try {
    const oneDriveRoot = path.join(os.homedir(), 'OneDrive');
    if (await exists(oneDriveRoot)) addAccount(accounts, seen, 'onedrive', 'OneDrive', oneDriveRoot);
  } catch {}
}

async function addWindowsICloudAccounts(accounts, seen) {
  for (const dir of [
    path.join(os.homedir(), 'iCloudDrive'),
    path.join(os.homedir(), 'iCloud Drive'),
  ]) {
    if (await exists(dir)) addAccount(accounts, seen, 'icloud', 'iCloud Drive', dir);
  }
}

async function getWindowsAccounts(accounts, seen) {
  const letters = await getWindowsMountLetters();
  const psDrive = await getPsDriveInfo();
  const emailByLetter = psDrive.emails;

  mergeMissingDriveEmails(emailByLetter, getDriveEmailsFromPreferenceCache());
  mergeMissingDriveEmails(emailByLetter, getDriveEmailsFromRecentLogs());

  for (const letter of emailByLetter.keys()) {
    if (psDrive.letters.has(letter)) letters.add(letter);
  }

  for (const letter of [...letters].sort()) {
    const myDrive = `${letter}:\\My Drive`;
    addAccount(accounts, seen, 'google', emailByLetter.get(letter) || `Google Drive (${letter}:)`, myDrive);
  }

  await addWindowsOneDriveAccounts(accounts, seen);
  await addWindowsICloudAccounts(accounts, seen);
}

async function getCloudAccounts() {
  const accounts = [];
  const seen = new Set();

  if (process.platform === 'darwin') {
    await getMacAccounts(accounts, seen);
  } else if (process.platform === 'win32') {
    await getWindowsAccounts(accounts, seen);
  }

  return accounts;
}

module.exports = getCloudAccounts;
