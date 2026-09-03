'use strict';

// Tailscale peer enrichment for P2P discovery. When the tailscale CLI is
// installed, `tailscale status --json` lists every device on the tailnet with
// its 100.64/10 address and online state; the app unicasts its discovery
// announcement to the online ones, so two devices on different networks pair
// over the (already encrypted) tailnet with no relay of our own. No CLI -> the
// synced endpoint registry and manual pins still work.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CANDIDATES = {
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'],
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
};

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function findBinary({ platform = process.platform, exists = fs.existsSync, pathEnv = process.env.PATH || '' } = {}) {
  for (const candidate of CANDIDATES[platform] || []) {
    if (exists(candidate)) return candidate;
  }
  const exe = platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  const sep = platform === 'win32' ? ';' : ':';
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    const candidate = join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  return '';
}

function ipv4Of(list) {
  return (Array.isArray(list) ? list : []).map(String).filter(ip => IPV4_RE.test(ip));
}

function parseStatus(status) {
  if (!status || typeof status !== 'object') return { available: false, self: null, peers: [] };
  const self = status.Self && typeof status.Self === 'object' ? {
    name: String(status.Self.HostName || ''),
    dnsName: String(status.Self.DNSName || '').replace(/\.$/, ''),
    ips: ipv4Of(status.Self.TailscaleIPs || status.TailscaleIPs),
    online: !!status.Self.Online,
  } : null;
  const peers = [];
  for (const raw of Object.values(status.Peer && typeof status.Peer === 'object' ? status.Peer : {})) {
    if (!raw || typeof raw !== 'object') continue;
    peers.push({
      id: String(raw.ID || raw.NodeID || raw.PublicKey || ''),
      name: String(raw.HostName || ''),
      dnsName: String(raw.DNSName || '').replace(/\.$/, ''),
      os: String(raw.OS || ''),
      ips: ipv4Of(raw.TailscaleIPs),
      online: !!raw.Online,
    });
  }
  peers.sort((a, b) => a.name.localeCompare(b.name));
  return { available: true, backend: String(status.BackendState || ''), self, peers };
}

function readStatus({ binary = findBinary(), timeoutMs = 5000, exec = execFile } = {}) {
  if (!binary) return Promise.resolve({ available: false, self: null, peers: [] });
  return new Promise(resolve => {
    exec(binary, ['status', '--json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { resolve({ available: false, error: error.message, self: null, peers: [] }); return; }
      try { resolve(parseStatus(JSON.parse(String(stdout)))); } catch (parseError) {
        resolve({ available: false, error: parseError.message, self: null, peers: [] });
      }
    });
  });
}

module.exports = { findBinary, parseStatus, readStatus, CANDIDATES };
