// node scripts/qa-flat-tags.js
// Sandbox proof for the flat-tags cutover (14 Oct 2026) on a REAL instance of this
// checkout (scripts/lib/qa-sandbox.js: isolated data, cloaked windows, no clipboard):
//  1. first start on nested data: a copy + undo record in clipboard-RECOVERED/ before
//     anything changes; settings and history on disk flat; ids, text and clocks kept;
//     AI sharing unchanged; the groups.flatten diagnostic; the popup shows flat tags
//  2. a restart on what the first start wrote changes nothing (no second copy)
//  3. a start after a crash between the two writes (settings flat, history nested)
//     finishes the job from the retired-names record
//  4. after the cutover a typed slash is literal, a retired name still splits, a
//     comma adds two tags, a twin spelling reuses the tag; delete + Undo of a tag
'use strict';
const fs = require('fs');
const path = require('path');
const qa = require('./lib/qa-sandbox');
const M = require('../lib/clipboard-model');

const T0 = 1791000000000;
const clip = (text, groups, extra = {}) => ({
  id: qa.txtId(text), type: 'text', text, ts: T0 / 1000, updatedAt: T0,
  pin: groups ? { groups, groupsUpdatedAt: T0, updatedAt: T0 } : null, ...extra,
});
const seedHistory = () => [
  clip('flat alpha: todo/forge only', ['todo/forge']),
  clip('flat beta: parent and child', ['todo', 'todo/forge', 'todo/done']),
  clip('flat gamma: forge already flat', ['forge']),
  clip('flat delta: twoshot/support', ['twoshot/support']),
  clip('flat epsilon: Notes', ['Notes']),
  clip('flat zeta: notes and private', ['notes', 'private']),
  clip('flat eta: untagged', null),
];
const seedSettings = () => ({
  groups: ['todo', 'todo/forge', 'forge', 'todo/done', 'twoshot/support', 'twoshot', 'Notes', 'notes', 'private', 'AI'],
  groups_shared_with_ai: ['todo', 'todo/forge', 'forge', 'todo/done', 'twoshot/support', 'twoshot', 'AI'],
  facet_joins: { group: 'or' },
  diagnostics_enabled: true,
});
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const tagsById = (history) => Object.fromEntries(history.map(h => [h.id, M.groupsOf(h)]));
const slashNames = (history, settings) => history.flatMap(h => M.groupsOf(h)).concat(settings.groups || [], settings.groups_shared_with_ai || []).filter(g => g.includes('/'));

(async () => {
  const { check, summary } = qa.createChecks();
  let sb = null;
  let ok = true;
  try {
    // ---- 1: first start on nested data ----
    sb = await qa.launch({ name: 'flat-tags-1', ai: true, settings: seedSettings(), history: seedHistory() });
    await qa.waitFor(() => { try { return !slashNames(read(sb.dataDir, 'clipboard-history.json'), read(sb.dataDir, 'clipboard-settings.json')).length; } catch { return false; } }, 'flat files on disk', 30000);
    const s1 = read(sb.dataDir, 'clipboard-settings.json');
    const h1 = read(sb.dataDir, 'clipboard-history.json');
    const recovered = path.join(sb.dataDir, 'clipboard-RECOVERED');
    const copies = fs.existsSync(recovered) ? fs.readdirSync(recovered).filter(d => d.startsWith('flatten-groups-')) : [];
    check('a copy + undo record kept before the change', copies.length === 1 && fs.existsSync(path.join(recovered, copies[0], 'undo.json')), copies.join(','));
    if (copies.length === 1) {
      const kept = read(path.join(recovered, copies[0]), 'clipboard-history.json');
      check('the copy is the ORIGINAL nested history', kept.some(h => (h.pin && h.pin.groups || []).includes('todo/forge')));
      const undo = read(path.join(recovered, copies[0]), 'undo.json');
      check('undo record lists the changed clips with their old tags', undo.clips.length === 4 && undo.clips.some(c => c.groups.includes('todo/done')), `${undo.clips.length} clips`);
    }
    const seed = seedHistory();
    const byId = tagsById(h1);
    check('nested tags became their parts', JSON.stringify(byId[seed[1].id]) === JSON.stringify(['todo', 'forge', 'done']), JSON.stringify(byId[seed[1].id]));
    check('case twins merged into one spelling', JSON.stringify(byId[seed[4].id]) === JSON.stringify(['notes']));
    check('settings tag list flat, nested entries replaced in place', JSON.stringify(s1.groups) === JSON.stringify(['todo', 'forge', 'done', 'twoshot', 'support', 'notes', 'private', 'AI']), JSON.stringify(s1.groups));
    check('retired names recorded', (s1.group_splits || []).length === 3, (s1.group_splits || []).map(r => r.name).join(','));
    check('cutover recorded, remembered group join reset', s1.groups_flattened_at > 0 && !('group' in (s1.facet_joins || {})));
    check('ids unchanged', h1.every(h => seed.some(x => x.id === h.id)) && h1.length === seed.length);
    check('no clock moved', h1.every(h => { const x = seed.find(y => y.id === h.id); return M.itemMutationClock(h) === M.itemMutationClock(x) && h.updatedAt === x.updatedAt; }));
    check('AI share list flat (unanimous rule)', JSON.stringify(s1.groups_shared_with_ai) === JSON.stringify(['todo', 'forge', 'done', 'twoshot', 'support', 'AI']), JSON.stringify(s1.groups_shared_with_ai));
    const flatten = sb.diagnostics().filter(d => d.event === 'groups.flatten' || d.type === 'groups.flatten' || d.name === 'groups.flatten');
    check('groups.flatten diagnostic with matching visibility', flatten.length === 1 && JSON.stringify(flatten[0]).includes('"visible_before":4') && JSON.stringify(flatten[0]).includes('"visible_after":4'), JSON.stringify(flatten[0] || {}).slice(0, 160));
    const state = await sb.historyState();
    check('the popup sees flat tags', state.every(h => !M.groupsOf(h).some(g => g.includes('/'))));
    const chips = await (await sb.openPopup()).eval(`[...document.querySelectorAll('.group-filters [data-group]')].map(e => e.dataset.group)`);
    check('chip row holds only flat tags', chips.length > 0 && chips.every(g => !g.includes('/')), chips.join(','));

    // ---- 4 (same instance): input after the cutover ----
    const alpha = state.find(h => h.id === seed[0].id);
    const r1 = await sb.mcp('assign_group', { ...(await sb.aiRef(alpha)), group: 'todo/forge' });
    const s4 = await sb.historyState();
    check('a retired name sent by an AI tool removes its parts as one decision', JSON.stringify(M.groupsOf(s4.find(h => h.id === alpha.id))) === '[]', JSON.stringify(r1).slice(0, 160));
    const gamma = s4.find(h => h.id === seed[2].id);
    await sb.mcp('assign_group', { ...(await sb.aiRef(gamma)), group: 'Urgent, seo' });
    const s5 = await sb.historyState();
    check('a comma adds two tags', JSON.stringify(M.groupsOf(s5.find(h => h.id === gamma.id))) === JSON.stringify(['forge', 'Urgent', 'seo']), JSON.stringify(M.groupsOf(s5.find(h => h.id === gamma.id))));
    await sb.mcp('create_group', { name: 'AC/DC' });
    const s6 = read(sb.dataDir, 'clipboard-settings.json');
    check('a slash typed after the cutover is a plain character', (s6.groups || []).includes('AC/DC'), (s6.groups || []).join(','));
    check('and is recorded as one, so a late device never retires it', (s6.group_literals || []).some(r => r.name === 'AC/DC'), JSON.stringify(s6.group_literals || []));
    await sb.mcp('create_group', { name: 'FORGE' });
    const s7 = read(sb.dataDir, 'clipboard-settings.json');
    check('a twin spelling reuses the tag', (s7.groups || []).filter(g => g.toLowerCase() === 'forge').length === 1);
    const popup = await sb.popup();
    const del = await popup.eval(`window.api.groupDelete('forge')`);
    const s8 = await sb.historyState();
    check('delete returns what Undo needs, touching only its clips', del && del.ok && Array.isArray(del.ids) && del.ids.length >= 1 && !s8.some(h => M.groupsOf(h).includes('forge')), JSON.stringify(del).slice(0, 160));
    await popup.eval(`window.api.groupRestore(${JSON.stringify(del)})`);
    const s9 = await sb.historyState();
    const s9settings = read(sb.dataDir, 'clipboard-settings.json');
    check('Undo puts the tag back on those clips and keeps it (a re-create beats the delete)', del.ids.every(id => M.groupsOf(s9.find(h => h.id === id)).includes('forge')) && (s9settings.groups || []).includes('forge')
      && Object.values(M.groupTombstoneIndex(s9settings.group_tombstones)).filter(v => v instanceof Map).every(m => [...m.values()].every(t => t.recreated)));
    const finish1 = await sb.finish();
    ok = ok && finish1.ok;
    sb = null;

    // ---- 2: restart on what the first start wrote ----
    sb = await qa.launch({ name: 'flat-tags-2', ai: true, settings: { ...s1, diagnostics_enabled: true }, history: h1 });
    await qa.sleep(2500);
    const h2 = read(sb.dataDir, 'clipboard-history.json');
    const s2 = read(sb.dataDir, 'clipboard-settings.json');
    check('restart: history unchanged', JSON.stringify(tagsById(h2)) === JSON.stringify(tagsById(h1)));
    check('restart: tag list and share list unchanged', JSON.stringify(s2.groups) === JSON.stringify(s1.groups) && JSON.stringify(s2.groups_shared_with_ai) === JSON.stringify(s1.groups_shared_with_ai));
    check('restart: no second copy, no flatten event', !fs.existsSync(path.join(sb.dataDir, 'clipboard-RECOVERED')) && !sb.diagnostics().some(d => JSON.stringify(d).includes('"groups.flatten"')));
    const finish2 = await sb.finish();
    ok = ok && finish2.ok;
    sb = null;

    // ---- 3: crash between the writes (settings flat, history still nested) ----
    sb = await qa.launch({ name: 'flat-tags-3', ai: true, settings: { ...s1, diagnostics_enabled: true }, history: seedHistory() });
    await qa.waitFor(() => { try { return !slashNames(read(sb.dataDir, 'clipboard-history.json'), {}).length; } catch { return false; } }, 'torn state healed', 30000);
    const h3 = read(sb.dataDir, 'clipboard-history.json');
    check('torn state: history finished from the retired-names record', JSON.stringify(tagsById(h3)) === JSON.stringify(tagsById(h1)), JSON.stringify(tagsById(h3)).slice(0, 160));
    const finish3 = await sb.finish();
    ok = ok && finish3.ok;
    sb = null;
  } catch (error) {
    ok = false;
    console.log(`FAIL  run aborted: ${error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : error}`);
  } finally {
    if (sb) { const f = await sb.finish(); ok = ok && f.ok; }
  }
  const s = summary();
  process.exit(ok && !s.failed ? 0 : 1);
})();
