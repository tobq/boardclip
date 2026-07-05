'use strict';
// Single source of truth for recognizing Google Drive "forked" copies of the
// sync files. When a rename-over-existing lands in a Drive-synced folder, Drive
// orphans the old object and creates a duplicate, disambiguating the name
// DIFFERENTLY per client:
//   macOS / Drive web:          "clipboard-history (1).json"     (parenthesized)
//   Windows Drive File Stream:  "clipboard-history 2.json"       (space+number, before ext)
//                               "clipboard-history.json 2.json"  (space+number, after ext)
// plus leaked atomic-write temps ("<name>.json.<pid>.<ts>.tmp"). The heal MUST
// match EVERY variant or a device stays permanently split (matching only the
// parenthesized form once stranded thousands of Windows-forked clips). These
// patterns NEVER match the canonical "<name>.json".
function forkFileRe(base) {
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dup = '(?:\\(\\d+\\)|\\d+)'; // "(1)" (mac/web) or "2" (Windows File Stream)
  return new RegExp(`^${b} ${dup}\\.json$|^${b}\\.json ${dup}\\.json$`);
}
function leakedTmpRe(base) {
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${b}\\.json\\.\\d+\\.\\d+(?: (?:\\(\\d+\\)|\\d+))?\\.tmp$`);
}

const FORK_HISTORY_RE = forkFileRe('clipboard-history');
const FORK_SETTINGS_RE = forkFileRe('clipboard-settings');
const LEAKED_HISTORY_TMP_RE = leakedTmpRe('clipboard-history');
const LEAKED_SETTINGS_TMP_RE = leakedTmpRe('clipboard-settings');

const isHistoryFork = (n) => FORK_HISTORY_RE.test(n) || LEAKED_HISTORY_TMP_RE.test(n);
const isSettingsFork = (n) => FORK_SETTINGS_RE.test(n) || LEAKED_SETTINGS_TMP_RE.test(n);

module.exports = {
  forkFileRe, leakedTmpRe,
  FORK_HISTORY_RE, FORK_SETTINGS_RE, LEAKED_HISTORY_TMP_RE, LEAKED_SETTINGS_TMP_RE,
  isHistoryFork, isSettingsFork,
};
