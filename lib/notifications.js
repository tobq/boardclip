'use strict';

// OS notifications with an optional action button, on Windows and macOS.
// - Windows: Electron's Notification takes a button only through custom toast
//   XML. A foreground-activated button reaches the app as the notification's
//   'click' (Electron maps every activation to it), so the body and the button
//   run the same action.
// - macOS: Electron's `actions` ('action' event). They show only when the app's
//   notification style is Alerts; otherwise the body click is the way in.
// Clicking the notification runs the action everywhere: that is the generic
// path, and a button is the extra a platform adds on top.

function escapeXml(value) {
  return String(value == null ? '' : value).replace(/[<>&"']/g, (ch) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[ch]);
}

function toastXml({ title, body, action, silent = true }) {
  return '<toast activationType="foreground" launch="open">'
    + '<visual><binding template="ToastGeneric">'
    + `<text>${escapeXml(title)}</text>`
    + (body ? `<text>${escapeXml(body)}</text>` : '')
    + '</binding></visual>'
    + (action ? `<actions><action content="${escapeXml(action)}" arguments="action" activationType="foreground"/></actions>` : '')
    + (silent ? '<audio silent="true"/>' : '')
    + '</toast>';
}

function notificationOptions({ title, body, action, silent = true, platform = process.platform } = {}) {
  const options = { title: String(title || ''), body: String(body || ''), silent: !!silent };
  if (action && platform === 'win32') options.toastXml = toastXml({ title, body, action, silent });
  if (action && platform === 'darwin') options.actions = [{ type: 'button', text: String(action) }];
  return options;
}

// show() keeps each notification referenced until it is acted on or closed:
// an unreferenced Notification can be garbage-collected before its click.
// A toast Windows rejects ('failed') is shown again without the button, so the
// message still arrives and its click still runs the action; onError hears of
// every failure (each one is a bug to fix, not a path to rely on).
function createNotifier({ Notification, platform = process.platform, onError = () => {} } = {}) {
  const live = new Set();
  const present = (options, act) => {
    const notification = new Notification(options);
    live.add(notification);
    const done = () => { live.delete(notification); };
    notification.on('click', () => { done(); act(); });
    notification.on('action', () => { done(); act(); });
    notification.on('close', done);
    notification.on('failed', (_event, error) => {
      done();
      onError(new Error(String(error || 'notification failed')));
      if (options.toastXml) {
        const { toastXml, ...plain } = options;
        try { present(plain, act); } catch (retryError) { onError(retryError); }
      }
    });
    notification.show();
    return notification;
  };
  return {
    show({ title, body, action, onAction, silent = true } = {}) {
      try {
        if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return null;
        const withAction = typeof onAction === 'function';
        let acted = false;
        const act = () => {
          if (!withAction || acted) return;
          acted = true;
          try { onAction(); } catch (error) { onError(error); }
        };
        return present(notificationOptions({ title, body, action: withAction ? action : '', silent, platform }), act);
      } catch (error) {
        onError(error);
        return null;
      }
    },
    liveCount: () => live.size,
  };
}

module.exports = { escapeXml, toastXml, notificationOptions, createNotifier };
