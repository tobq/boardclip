'use strict';

// LAN peer discovery for P2P sync: ONE UDP socket, joined to the multicast group
// on EVERY real IPv4 interface and announcing once per interface.
//
// Why per-interface: `socket.addMembership(group)` with no interface lets the OS
// pick ONE adapter. On a Windows box with Hyper-V / WSL / VMware virtual
// switches that pick is effectively random (2026-09-03: the live app joined on
// the Hyper-V "Default Switch" 172.21.224.1 while the Mac's announcements were
// arriving on Wi-Fi 192.168.1.182, so the two devices never paired and every
// copy took the cloud path: 30-90 s instead of instant). Joining and sending on
// each interface makes discovery independent of that pick, and re-enumerating
// interfaces every 30 s covers Wi-Fi joining after launch and VPNs coming up.
//
// Unicast re-announce: the same announcement is also sent directly to every
// address the caller passes (peers already heard from, pinned peers, tailnet
// addresses). Multicast is often one-directional or filtered on APs; a peer that
// heard us once, or that we know the address of, keeps hearing us regardless.
//
// Pure with respect to the socket + interface table (both injectable) so the
// join/announce matrix is unit-tested without touching the network.

const os = require('os');
const dgram = require('dgram');

// Tailscale hands out 100.64.0.0/10 (CGNAT). Multicast never crosses the tailnet
// and link-local addresses are not routable peers, so neither gets a join.
const CGNAT_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const LINK_LOCAL_RE = /^169\.254\./;

function isTailscaleIp(ip) {
  return CGNAT_RE.test(String(ip || ''));
}

function normalizeIp(ip) {
  const value = String(ip || '');
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function transportFor(ip) {
  return isTailscaleIp(normalizeIp(ip)) ? 'tailnet' : 'lan';
}

// Every non-internal IPv4 address that can carry LAN multicast, with its
// adapter name. `table` is `os.networkInterfaces()` (injectable for tests).
function lanInterfaces(table = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(table || {})) {
    for (const addr of Array.isArray(addrs) ? addrs : []) {
      if (!addr || addr.internal || !addr.address) continue;
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (LINK_LOCAL_RE.test(addr.address) || isTailscaleIp(addr.address)) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

function createDiscovery({
  group,
  port,
  ttl = 1,
  interfaces = lanInterfaces,
  createSocket = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }),
  onMessage = () => {},
  onError = () => {},
  log = () => {},
  refreshIntervalMs = 30 * 1000,
  setInterval: schedule = setInterval,
  clearInterval: unschedule = clearInterval,
} = {}) {
  if (!group || !port) throw new Error('createDiscovery needs group + port');
  let socket = null;
  let refreshTimer = null;
  const joined = new Map(); // interface ip -> adapter name

  async function start() {
    if (socket) return;
    socket = createSocket();
    socket.on('message', (message, rinfo) => onMessage(message, rinfo));
    socket.on('error', error => onError(error));
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    try { socket.setMulticastTTL(ttl); } catch {}
    // Two instances on one host (the hermetic two-instance QA) must hear each
    // other; loopback is the default but make it explicit.
    try { socket.setMulticastLoopback(true); } catch {}
    refresh();
    refreshTimer = schedule(refresh, refreshIntervalMs);
    if (refreshTimer && refreshTimer.unref) refreshTimer.unref();
  }

  // (Re)join the group on every current interface; leave interfaces that went
  // away. Returns what changed so callers can log it.
  function refresh() {
    if (!socket) return { joined: [], added: [], dropped: [] };
    const wanted = new Map(interfaces().map(iface => [iface.address, iface.name]));
    const added = [];
    const dropped = [];
    for (const [ip, name] of wanted) {
      if (joined.has(ip)) continue;
      try {
        socket.addMembership(group, ip);
        joined.set(ip, name);
        added.push({ name, address: ip });
      } catch (error) {
        log('join.error', { name, address: ip, error: error && error.message });
      }
    }
    for (const ip of [...joined.keys()]) {
      if (wanted.has(ip)) continue;
      try { socket.dropMembership(group, ip); } catch {}
      dropped.push({ name: joined.get(ip), address: ip });
      joined.delete(ip);
    }
    if (added.length || dropped.length) {
      log('interfaces', { joined: joinedInterfaces(), added, dropped });
    }
    return { joined: [...joined.keys()], added, dropped };
  }

  function sendTo(body, targetPort, host, label) {
    socket.send(body, 0, body.length, targetPort, host, error => {
      if (error) log('send.error', { target: label, host, port: targetPort, error: error && error.message });
    });
  }

  // Multicast once per joined interface, then unicast to every explicit target
  // ({ host, port? }). Returns how many sends were issued.
  function announce(body, { unicast = [] } = {}) {
    if (!socket) return 0;
    let sent = 0;
    for (const ip of joined.keys()) {
      try {
        socket.setMulticastInterface(ip);
        sendTo(body, port, group, `multicast via ${ip}`);
        sent++;
      } catch (error) {
        log('send.error', { target: `multicast via ${ip}`, error: error && error.message });
      }
    }
    if (!joined.size) {
      // No usable interface (yet): let the OS pick, exactly the old behaviour.
      try { sendTo(body, port, group, 'multicast default'); sent++; } catch {}
    }
    const seen = new Set();
    for (const target of Array.isArray(unicast) ? unicast : []) {
      const host = normalizeIp(target && target.host);
      const targetPort = Number(target && target.port) || port;
      if (!host || seen.has(`${host}:${targetPort}`)) continue;
      seen.add(`${host}:${targetPort}`);
      try { sendTo(body, targetPort, host, 'unicast'); sent++; } catch {}
    }
    return sent;
  }

  function joinedInterfaces() {
    return [...joined.entries()].map(([address, name]) => ({ name, address }));
  }

  function stop() {
    if (refreshTimer) unschedule(refreshTimer);
    refreshTimer = null;
    joined.clear();
    const current = socket;
    socket = null;
    try { if (current) current.close(); } catch {}
  }

  return {
    start,
    stop,
    refresh,
    announce,
    joinedInterfaces,
    get running() { return !!socket; },
  };
}

module.exports = {
  createDiscovery,
  lanInterfaces,
  isTailscaleIp,
  normalizeIp,
  transportFor,
};
