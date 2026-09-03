'use strict';
// LAN discovery must join + announce on EVERY real IPv4 interface (never let the
// OS pick one virtual switch), re-enumerate interfaces, unicast to known peers,
// and classify Tailscale addresses as the tailnet transport.
const assert = require('assert');
const { createDiscovery, lanInterfaces, isTailscaleIp, transportFor, normalizeIp } = require('../lib/p2p-discovery');

function fakeSocket() {
  const calls = [];
  const handlers = {};
  return {
    calls,
    on(event, fn) { handlers[event] = fn; },
    once(event, fn) { handlers['once:' + event] = fn; },
    off() {},
    bind(port, cb) { calls.push(['bind', port]); cb(); },
    setMulticastTTL(ttl) { calls.push(['ttl', ttl]); },
    setMulticastLoopback(on) { calls.push(['loopback', on]); },
    addMembership(group, iface) {
      if (iface === '10.9.9.9') throw new Error('EADDRNOTAVAIL');
      calls.push(['join', group, iface]);
    },
    dropMembership(group, iface) { calls.push(['leave', group, iface]); },
    setMulticastInterface(iface) { calls.push(['iface', iface]); },
    send(body, offset, length, port, host, cb) { calls.push(['send', port, host, body.toString()]); if (cb) cb(null); },
    close() { calls.push(['close']); },
    emit(event, ...args) { if (handlers[event]) handlers[event](...args); },
  };
}

const TABLE = {
  'Wi-Fi': [{ address: '192.168.1.182', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  'vEthernet (Default Switch)': [{ address: '172.21.224.1', family: 'IPv4', internal: false }],
  'Tailscale': [{ address: '100.109.45.50', family: 'IPv4', internal: false }],
  'Loopback': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  'Link-local': [{ address: '169.254.10.10', family: 'IPv4', internal: false }],
  'Numeric family': [{ address: '10.0.0.5', family: 4, internal: false }],
};

(async () => {
  // 1. Interface table: real IPv4 only (no loopback, link-local, tailnet, IPv6).
  assert.deepStrictEqual(lanInterfaces(TABLE).map(i => i.address), ['192.168.1.182', '172.21.224.1', '10.0.0.5']);
  assert.ok(isTailscaleIp('100.109.45.50') && isTailscaleIp('100.64.0.1') && isTailscaleIp('100.127.255.254'));
  assert.ok(!isTailscaleIp('100.128.0.1') && !isTailscaleIp('100.63.255.255') && !isTailscaleIp('192.168.1.1'));
  assert.strictEqual(transportFor('::ffff:100.96.108.108'), 'tailnet');
  assert.strictEqual(transportFor('::ffff:192.168.1.105'), 'lan');
  assert.strictEqual(normalizeIp('::ffff:192.168.1.105'), '192.168.1.105');

  // 2. start(): bind, ttl, loopback, one join PER interface (a failing join is
  //    logged and skipped, never fatal).
  let table = { ...TABLE, 'Bad': [{ address: '10.9.9.9', family: 'IPv4', internal: false }] };
  const sock = fakeSocket();
  const logs = [];
  let tick = null;
  const disc = createDiscovery({
    group: '239.255.43.21', port: 45454, ttl: 1,
    interfaces: () => lanInterfaces(table),
    createSocket: () => sock,
    log: (event, details) => logs.push([event, details]),
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
    clearInterval: () => { tick = null; },
  });
  await disc.start();
  const joins = sock.calls.filter(c => c[0] === 'join').map(c => c[2]);
  assert.deepStrictEqual(joins, ['192.168.1.182', '172.21.224.1', '10.0.0.5'], 'joined on every real interface');
  assert.ok(sock.calls.some(c => c[0] === 'bind' && c[1] === 45454));
  assert.ok(sock.calls.some(c => c[0] === 'loopback' && c[1] === true));
  assert.ok(logs.some(l => l[0] === 'join.error' && l[1].address === '10.9.9.9'), 'failed join is logged');
  assert.deepStrictEqual(disc.joinedInterfaces().map(i => i.address), ['192.168.1.182', '172.21.224.1', '10.0.0.5']);

  // 3. announce(): one multicast send per joined interface (selecting the
  //    outgoing interface first) + one unicast per distinct explicit target.
  sock.calls.length = 0;
  const sent = disc.announce(Buffer.from('hello'), { unicast: [
    { host: '192.168.1.105', port: 56006 },
    { host: '::ffff:192.168.1.105', port: 56006 },   // duplicate after normalization
    { host: '100.96.108.108' },                       // default discovery port
  ] });
  assert.strictEqual(sent, 5, '3 multicast + 2 unicast');
  const seq = sock.calls.map(c => c[0] === 'iface' ? `iface:${c[1]}` : `${c[0]}:${c[2]}:${c[1]}`);
  assert.deepStrictEqual(seq, [
    'iface:192.168.1.182', 'send:239.255.43.21:45454',
    'iface:172.21.224.1', 'send:239.255.43.21:45454',
    'iface:10.0.0.5', 'send:239.255.43.21:45454',
    'send:192.168.1.105:56006',
    'send:100.96.108.108:45454',
  ]);

  // 4. refresh(): a new interface is joined, a vanished one is left.
  table = { 'Wi-Fi': TABLE['Wi-Fi'], 'Ethernet': [{ address: '192.168.50.7', family: 'IPv4', internal: false }] };
  sock.calls.length = 0;
  const change = tick ? (tick(), disc.joinedInterfaces()) : disc.refresh().joined;
  assert.deepStrictEqual(sock.calls.filter(c => c[0] === 'join').map(c => c[2]), ['192.168.50.7']);
  assert.deepStrictEqual(sock.calls.filter(c => c[0] === 'leave').map(c => c[2]).sort(), ['10.0.0.5', '172.21.224.1']);
  assert.deepStrictEqual((Array.isArray(change) ? change.map(i => i.address || i) : []).sort(), ['192.168.1.182', '192.168.50.7']);

  // 5. Messages reach the caller; stop() closes and clears.
  const got = [];
  const disc2 = createDiscovery({ group: '239.255.43.21', port: 45454, interfaces: () => [], createSocket: () => sock, onMessage: (m, r) => got.push([m.toString(), r.address]), setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  await disc2.start();
  sock.emit('message', Buffer.from('ann'), { address: '192.168.1.105', port: 45454 });
  assert.deepStrictEqual(got, [['ann', '192.168.1.105']]);
  sock.calls.length = 0;
  assert.strictEqual(disc2.announce(Buffer.from('x')), 1, 'no interfaces: one OS-default multicast send');
  disc2.stop();
  assert.ok(sock.calls.some(c => c[0] === 'close'));
  assert.strictEqual(disc2.running, false);
  disc.stop();
  assert.strictEqual(disc.joinedInterfaces().length, 0);

  console.log('p2p-discovery tests passed');
})().catch(error => { console.error(error); process.exit(1); });
