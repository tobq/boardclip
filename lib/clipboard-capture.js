'use strict';

const windowsClipboard = require('./windows-clipboard');

function formatsKey(formats) {
  return (Array.isArray(formats) ? formats : [])
    .map(format => String(format || ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
}

function safeAvailableFormats(clipboard) {
  try { return clipboard.availableFormats(); } catch { return []; }
}

function formatsSuggestImage(formatsOrKey) {
  const key = Array.isArray(formatsOrKey) ? formatsKey(formatsOrKey) : String(formatsOrKey || '');
  return /image|png|tiff|bitmap|dib|filedrop|filename|filecontents|filegroupdescriptor|shell idlist|uri-list/i.test(key);
}

function formatsSuggestFileTransfer(formatsOrKey) {
  const key = Array.isArray(formatsOrKey) ? formatsKey(formatsOrKey) : String(formatsOrKey || '');
  return /filedrop|filename|filecontents|filegroupdescriptor|shell idlist|uri-list/i.test(key);
}

function imageFromNativeImage(image, source) {
  if (!image || image.isEmpty()) return null;
  const buffer = image.toPNG();
  if (!buffer || !buffer.length) return null;
  const size = image.getSize();
  if (!size || !size.width || !size.height) return null;
  return { buffer, width: size.width, height: size.height, source };
}

function imageFromBuffer(nativeImage, buffer, source, extra) {
  if (!buffer || !buffer.length || !nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
  const image = nativeImage.createFromBuffer(buffer);
  const captured = imageFromNativeImage(image, source);
  return captured ? { ...captured, ...(extra || {}) } : null;
}

function readElectronImage(clipboard) {
  try { return clipboard.readImage(); } catch { return null; }
}

function readClipboardImage(options) {
  const opts = options || {};
  const clipboard = opts.clipboard;
  const nativeImage = opts.nativeImage;
  const platform = opts.platform || process.platform;
  const win = opts.windowsClipboard || windowsClipboard;
  const formats = opts.formats || safeAvailableFormats(clipboard);
  const key = formatsKey(formats);
  if (!formatsSuggestImage(key)) return null;

  if (platform === 'win32' && formatsSuggestFileTransfer(key) && win && typeof win.readImageCandidate === 'function') {
    const candidate = win.readImageCandidate();
    if (candidate && candidate.buffer) {
      const fromCandidate = imageFromBuffer(nativeImage, candidate.buffer, candidate.source || 'win32-fallback', { path: candidate.path });
      if (fromCandidate) return { ...fromCandidate, formats, formatsKey: key };
    }
  }

  const electronImage = imageFromNativeImage(readElectronImage(clipboard), 'electron-readImage');
  if (electronImage) return { ...electronImage, formats, formatsKey: key };

  if (platform === 'win32' && win && typeof win.readImageCandidate === 'function') {
    const candidate = win.readImageCandidate();
    if (candidate && candidate.buffer) {
      const fromCandidate = imageFromBuffer(nativeImage, candidate.buffer, candidate.source || 'win32-fallback', { path: candidate.path });
      if (fromCandidate) return { ...fromCandidate, formats, formatsKey: key };
    }
  }

  return null;
}

function clipboardChangeToken(formats) {
  const sequence = windowsClipboard.getSequenceNumber();
  if (sequence) return `winseq:${sequence}`;
  return `formats:${Array.isArray(formats) ? formatsKey(formats) : String(formats || '')}`;
}

module.exports = {
  formatsKey,
  formatsSuggestImage,
  formatsSuggestFileTransfer,
  readClipboardImage,
  clipboardChangeToken,
  _private: {
    imageFromNativeImage,
    imageFromBuffer,
  },
};
