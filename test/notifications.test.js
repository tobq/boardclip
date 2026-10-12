'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { escapeXml, toastXml, notificationOptions, createNotifier } = require('../lib/notifications');

// 1. Toast XML: escaped text, one foreground button, silent.
{
  const xml = toastXml({ title: 'A <b> & "c"', body: "it's", action: 'Merge' });
  assert.ok(xml.includes('<text>A &lt;b&gt; &amp; &quot;c&quot;</text>'));
  assert.ok(xml.includes('<text>it&apos;s</text>'));
  assert.ok(xml.includes('<action content="Merge" arguments="action" activationType="foreground"/>'));
  assert.ok(xml.includes('<audio silent="true"/>'));
  assert.ok(xml.startsWith('<toast activationType="foreground"'));
  assert.ok(!toastXml({ title: 't' }).includes('<actions>'), 'no button without an action');
  assert.strictEqual(escapeXml(null), '');
}

// 2. Per platform: Windows gets the toast XML, macOS Electron's actions,
//    Linux (and any notification without an action) plain fields only.
{
  const win = notificationOptions({ title: 't', body: 'b', action: 'Merge', platform: 'win32' });
  assert.ok(win.toastXml && win.toastXml.includes('Merge'));
  assert.strictEqual(win.actions, undefined);
  const mac = notificationOptions({ title: 't', body: 'b', action: 'Merge', platform: 'darwin' });
  assert.deepStrictEqual(mac.actions, [{ type: 'button', text: 'Merge' }]);
  assert.strictEqual(mac.toastXml, undefined);
  const linux = notificationOptions({ title: 't', body: 'b', action: 'Merge', platform: 'linux' });
  assert.deepStrictEqual(Object.keys(linux).sort(), ['body', 'silent', 'title']);
  const plain = notificationOptions({ title: 't', body: 'b', platform: 'win32' });
  assert.strictEqual(plain.toastXml, undefined);
}

// 3. The notifier: body click and button both run the action, once; the
//    notification stays referenced until it is acted on or closed.
function fakeNotificationClass(shown, supported = true) {
  return class FakeNotification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; }
    show() { shown.push(this); }
  };
}
{
  const shown = [];
  const notifier = createNotifier({ Notification: fakeNotificationClass(shown), platform: 'win32' });
  let runs = 0;
  const n = notifier.show({ title: 't', body: 'b', action: 'Merge', onAction: () => { runs += 1; } });
  assert.strictEqual(shown.length, 1);
  assert.ok(n.options.toastXml.includes('Merge'));
  assert.strictEqual(notifier.liveCount(), 1);
  n.emit('click');
  n.emit('action', {}, 0);
  assert.strictEqual(runs, 1, 'click and action run the action once');
  assert.strictEqual(notifier.liveCount(), 0);

  const closed = notifier.show({ title: 't', action: 'Merge', onAction: () => { runs += 1; } });
  closed.emit('close');
  assert.strictEqual(notifier.liveCount(), 0);
  assert.strictEqual(runs, 1, 'dismissing runs nothing');

  const plain = notifier.show({ title: 't', body: 'b', action: 'Merge' });
  assert.strictEqual(plain.options.toastXml, undefined, 'no handler = no button');
  plain.emit('click');
}
{
  const errors = [];
  const shown = [];
  const notifier = createNotifier({ Notification: fakeNotificationClass(shown, false), onError: (e) => errors.push(e) });
  assert.strictEqual(notifier.show({ title: 't' }), null, 'unsupported: nothing shown');
  assert.strictEqual(shown.length, 0);
  const failing = createNotifier({ Notification: fakeNotificationClass(shown), onError: (e) => errors.push(e) });
  const n = failing.show({ title: 't', action: 'Merge', onAction: () => { throw new Error('boom'); } });
  n.emit('click');
  n.emit('failed', {}, 'bad xml');
  assert.deepStrictEqual(errors.map(e => e.message), ['boom', 'bad xml']);
}
{
  // A rejected toast is shown again without the button; its click still acts.
  const shown = [];
  const errors = [];
  const notifier = createNotifier({ Notification: fakeNotificationClass(shown), platform: 'win32', onError: (e) => errors.push(e.message) });
  let runs = 0;
  const first = notifier.show({ title: 't', body: 'b', action: 'Merge', onAction: () => { runs += 1; } });
  first.emit('failed', {}, 'toast rejected');
  assert.strictEqual(shown.length, 2, 'shown again');
  assert.strictEqual(shown[1].options.toastXml, undefined, 'the retry is plain');
  assert.strictEqual(shown[1].options.title, 't');
  shown[1].emit('click');
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(errors, ['toast rejected']);
  shown[1].emit('failed', {}, 'again');
  assert.strictEqual(shown.length, 2, 'a plain notification is never retried');
  assert.strictEqual(notifier.liveCount(), 0);
}

console.log('notifications tests passed');
