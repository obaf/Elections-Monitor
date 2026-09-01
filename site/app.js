/* Osun Election Monitoring Portal — front page.
   Plain ES modules-free JS so the site deploys as static files with no build. */

const API = '/api';
const BATCH = 150;               // rows rendered per scroll step
let DATA = null;                 // { lgas, wards, pus }
let SUMMARY = { totals: {}, counts: {}, elections: {}, current: 'presidential', uploadsEnabled: false };
let filtered = [];
let rendered = 0;
let pendingPu = null;            // polling unit awaiting a file pick
const OCR = {};                  // uploadId -> figures as Textract read them

/* The admin sees the ordinary page plus approve controls, rather than a
   separate screen, so the thing being approved is viewed in its real context.
   Same storage key as admin.html, so a login on either carries across. */
let adminToken = sessionStorage.getItem('irev2-admin') || '';
const isAdmin = () => !!adminToken;

/* Which election the grid is showing. The front page is the live contest by
   default; ?election=osun turns the same page into the Osun archive, so the
   finished election's result sheets stay reachable and viewable through the
   familiar polling-unit list rather than needing a second screen. */
const FORCED = (new URLSearchParams(location.search).get('election') || '').toLowerCase() === 'osun'
  ? 'osun' : null;
const IS_ARCHIVE = FORCED === 'osun';

/* Which election the grid is bound to. Not a constant: while test mode is on
   the server reports the test election as current, and the grid follows it, so
   a tester sees their own upload appear in the counts without any of it
   touching the real election's keys. */
const VIEW = () => FORCED || SUMMARY.current || 'presidential';

/* Stable per-browser id. The "two different phones" rule needs to tell
   devices apart; this is the cheapest honest signal available client-side. */
const deviceId = (() => {
  let d = localStorage.getItem('irev2-device');
  if (!d) {
    d = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    localStorage.setItem('irev2-device', d);
  }
  return d;
})();

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = new Intl.NumberFormat('en-NG');

function toast(msg, ms = 7000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// Same canonical form the server uses to decide whether two photos agree, so
// "these differ" means the same thing on both sides.
const signatureOf = (r) =>
  Object.keys(r || {}).sort().map((k) => `${k}=${r[k]}`).join(',');

/* ------------------------------- totals --------------------------------- */

/* Each election gets its own labelled row, so the finished Osun figures and
   the live presidential ones are never read as one number. A row keeps its
   shape before any result exists: the parties on the ballot are shown with a
   placeholder rather than the row collapsing to a sentence. */
const ZERO = '000';

function tile(party, votes) {
  const v = votes === null || votes === undefined ? ZERO : nf.format(votes);
  return `<div class="tile"><div class="p">${esc(party)}</div><div class="v">${v}</div></div>`;
}

function electionRow(e) {
  const totals = e.totals || {};
  const scored = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  /* With figures, show them highest first. Without, show the expected parties
     as 000 -- the row still says which contest it is and who is on it. */
  const tiles = scored.length
    ? scored.map(([p, v]) => tile(p, v)).join('')
    : (e.display || []).map((p) => tile(p, null)).join('');

  return `<div class="totals-row" data-election="${esc(e.id)}">
    <div class="totals-label">${esc(e.label)}:</div>
    <div class="tiles">${tiles}</div>
  </div>`;
}

function renderTotals() {
  const el = $('#totals');
  const order = [SUMMARY.current, ...Object.keys(SUMMARY.elections || {})]
    .filter((id, i, a) => id && a.indexOf(id) === i && SUMMARY.elections?.[id]);

  if (!order.length) {
    el.innerHTML = '<p class="muted">No verified results yet. Totals appear here once two matching photos ' +
                   'from two different phones are uploaded for a polling unit.</p>';
    return;
  }
  /* Fixed order: the finished contest, then the test row if one is showing,
     then the live election. This is the order the specified layout is drawn in,
     and it is stated explicitly rather than left to the order the server
     happens to serialise the elections in. */
  const RANK = { archived: 0, ephemeral: 1, live: 2 };
  const rankOf = (id) => {
    const e = SUMMARY.elections[id];
    if (e.archived) return RANK.archived;
    if (e.ephemeral) return RANK.ephemeral;
    return RANK.live;
  };
  const ids = order.slice().sort((a, b) => rankOf(a) - rankOf(b));
  el.innerHTML = ids.map((id) => electionRow(SUMMARY.elections[id])).join('');
}

/* -------------------------------- grid ---------------------------------- */

const viewCounts = () => SUMMARY.elections?.[VIEW()]?.counts || {};

function uploadLabel(code) {
  const [n = 0, counted = 0] = viewCounts()[code] || [];
  if (counted) return `<span class="done-note">${n} uploads done – no need for further uploads</span>`;
  return `${n} upload${n === 1 ? '' : 's'} done`;
}

function rowHtml(pu) {
  const [code, name, wardIdx] = pu;
  const [wardName, lgaIdx] = DATA.wards[wardIdx];
  const lga = DATA.lgas[lgaIdx];
  const [n = 0] = viewCounts()[code] || [];
  return `<tr data-code="${esc(code)}">
    <td class="col-upload">
      ${IS_ARCHIVE ? '' :
        `<button class="btn btn-primary btn-up" data-act="upload" data-code="${esc(code)}">Upload photo</button>`}
      <button class="uploads-done" data-act="extract" data-code="${esc(code)}">${uploadLabel(code)}</button>
    </td>
    <td>
      <div class="pu-name">${esc(name)}</div>
      <div class="pu-code">${esc(code)}</div>
    </td>
    <td class="col-ward">${esc(wardName)}<br><span class="pu-code">${esc(lga)}</span></td>
    <td class="col-extract">
      <button class="link-extract" data-act="extract" data-code="${esc(code)}">
        ${n ? 'view extracted result' : 'no result yet'}
      </button>
    </td>
  </tr>`;
}

function renderMore() {
  const slice = filtered.slice(rendered, rendered + BATCH);
  if (!slice.length) { $('#more').textContent = ''; return; }
  $('#rows').insertAdjacentHTML('beforeend', slice.map(rowHtml).join(''));
  rendered += slice.length;
  refreshUploadUi();   // the rows just added carry their own upload buttons
  $('#more').textContent = rendered < filtered.length
    ? `Showing ${nf.format(rendered)} of ${nf.format(filtered.length)} — scroll for more`
    : '';
}

function applyFilter() {
  const qp = $('#q-pu').value.trim().toUpperCase();
  const qw = $('#q-ward').value.trim().toUpperCase();
  filtered = DATA.pus.filter(([code, name, wi]) => {
    if (qp && !name.toUpperCase().includes(qp) && !code.includes(qp)) return false;
    if (qw && !DATA.wards[wi][0].toUpperCase().includes(qw)) return false;
    return true;
  });
  rendered = 0;
  $('#rows').innerHTML = '';
  $('#count-line').textContent = `${nf.format(filtered.length)} polling unit${filtered.length === 1 ? '' : 's'}`;
  renderMore();
}

/* ------------------------------- extracts -------------------------------- */

const editRow = (party, votes) => `<tr>
  <td><input class="p-in" type="text" value="${esc(party)}" maxlength="12"
             placeholder="PARTY" autocapitalize="characters" list="party-list"></td>
  <td><input class="v-in" type="number" min="0" step="1" value="${esc(votes)}" placeholder="0"></td>
  <td><button class="row-x" data-act="delrow" title="remove this party">&times;</button></td>
</tr>`;

/* OCR gets figures wrong and misses parties entirely, so an admin approving a
 * photo edits the numbers here rather than accepting whatever Textract read.
 * The edit is validated again server-side and recorded in the audit trail
 * alongside what OCR originally said. */
function adminBox(u, counted, code) {
  if (!isAdmin() || counted || IS_ARCHIVE) return '';
  const why = u.inOsun
    ? 'This photo has Osun location data but has not been matched by a second phone yet.'
    : 'This photo carries no Osun location data, so it cannot be counted automatically.';
  const entries = Object.entries(u.extracted || {}).sort((a, b) => b[1] - a[1]);
  const body = entries.length
    ? entries.map(([p, v]) => editRow(p, v)).join('')
    : editRow('', '');

  return `<div class="admin-box">
    <p>${why} Check the figures below against the photo, correct anything misread,
       add any party that was missed, then approve.</p>
    <table class="edit-tbl" data-edit="${esc(u.uploadId)}">
      <thead><tr><th>Party</th><th>Votes</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="edit-err" data-err="${esc(u.uploadId)}" hidden></p>
    <div class="row">
      <button class="btn" data-act="addrow" data-upload="${esc(u.uploadId)}">+ add a party</button>
      <button class="btn" data-act="resetrows" data-upload="${esc(u.uploadId)}">reset to what was read</button>
      <button class="btn btn-primary" data-act="approve"
              data-code="${esc(code)}" data-upload="${esc(u.uploadId)}">
        Approve these figures into the totals
      </button>
    </div>
  </div>`;
}

// Reads the form back out. Rejects blank party names, duplicates and negatives
// rather than quietly dropping them -- a silently discarded row would look like
// it had been counted.
function collectFigures(uploadId) {
  const tbl = document.querySelector(`[data-edit="${CSS.escape(uploadId)}"]`);
  if (!tbl) return { error: 'Could not read the table.' };

  /* Scope to this table's OWN body rows.
   *
   * `tbl.querySelectorAll('tbody tr')` looks equivalent and is not: a
   * descendant combinator is resolved against the whole document, not against
   * tbl. This table is rendered inside the main grid's <tbody id="rows">, so
   * that selector also matched this table's <thead> row -- whose cells are
   * <th> with no inputs. Reading .value off null threw before any request was
   * sent, so approving appeared to do nothing at all, silently. */
  const bodyRows = tbl.tBodies?.length
    ? [...tbl.tBodies[0].rows]
    : [...tbl.querySelectorAll(':scope > tbody > tr')];

  const figures = {};
  for (const tr of bodyRows) {
    const pIn = tr.querySelector('.p-in');
    const vIn = tr.querySelector('.v-in');
    if (!pIn || !vIn) continue;            // not an editable row; never throw here
    const party = pIn.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Thousands separators and stray spaces are how people actually type
    // figures off a sheet, so accept them instead of rejecting the row.
    const raw = vIn.value.trim().replace(/[,\s]/g, '');
    if (!party && raw === '') continue;                       // blank row, ignore
    if (!party) return { error: 'Every row needs a party name.' };
    if (raw === '') return { error: `Enter a score for ${party} — digits only.` };
    const votes = Number(raw);
    if (!Number.isInteger(votes) || votes < 0) {
      return { error: `“${raw}” is not a valid score for ${party}. Use a whole number, zero or more.` };
    }
    if (figures[party] !== undefined) return { error: `${party} appears twice.` };
    figures[party] = votes;
  }
  if (!Object.keys(figures).length) return { error: 'Enter at least one party and score.' };
  return { figures };
}

async function toggleExtract(code, tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  document.querySelectorAll('tr.detail').forEach((d) => d.remove());

  const row = document.createElement('tr');
  row.className = 'detail';
  row.innerHTML = `<td colspan="4">Loading…</td>`;
  tr.after(row);
  loadPartyList();

  let data;
  try {
    data = await (await fetch(
      `${API}/pu?code=${encodeURIComponent(code)}&election=${encodeURIComponent(VIEW())}`)).json();
  } catch {
    row.innerHTML = `<td colspan="4">Could not load results. Please try again.</td>`;
    return;
  }

  if (!data.uploads?.length) {
    row.innerHTML = `<td colspan="4"><p class="muted">No photos uploaded for this polling unit yet.</p></td>`;
    return;
  }

  /* Once a unit is counted, the figures under the photo are the ones that were
     APPROVED, not the ones OCR read. Extraction is often wrong and the admin
     corrects it before approving; showing the raw extraction afterwards would
     contradict the totals the same page is displaying. */
  const approved = data.counted ? (data.results || {}) : null;

  const cards = data.uploads.map((u, i) => {
    const ocr = u.extracted || {};
    const shown = approved || ocr;
    const rows = Object.entries(shown).sort((a, b) => b[1] - a[1]);
    const amended = approved && signatureOf(approved) !== signatureOf(ocr);

    const caption = approved
      ? `<p class="fig-caption">Approved figures${amended ? ' — corrected before approval' : ''}</p>`
      : '';
    const wasRead = amended
      ? `<p class="fig-was muted">Originally read: ${
          Object.entries(ocr).sort((a, b) => b[1] - a[1])
            .map(([p, v]) => `${esc(p)} ${nf.format(v)}`).join(', ') || 'nothing'}</p>`
      : '';

    const table = rows.length
      ? caption + `<table><tbody>${rows.map(([p, v]) =>
          `<tr><th>${esc(p)}</th><td>${nf.format(v)}</td></tr>`).join('')}</tbody></table>` + wasRead
      : `<p class="muted">No party figures could be read from this photo.</p>`;
    const badge = u.inOsun
      ? '<span class="badge badge-ok">location in Osun</span>'
      : '<span class="badge badge-no">no Osun location data</span>';
    // Remember what OCR read, so "reset" can put it back after edits.
    OCR[u.uploadId] = u.extracted || {};
    // For an admin about to approve, the editable table replaces the static one
    // rather than sitting under a duplicate of the same numbers.
    const editing = isAdmin() && !data.counted && !IS_ARCHIVE;
    return `<div class="card">
      <div><strong>Photo ${i + 1}</strong> · ${new Date(u.ts).toLocaleString()} · ${badge}
           · <span class="pu-code">phone ${esc(u.device)}</span></div>
      <img src="${esc(u.url)}" alt="Result sheet photo ${i + 1}" loading="lazy"
           oncontextmenu="return false">
      ${editing ? '' : table}
      ${adminBox(u, data.counted, code)}
    </div>`;
  }).join('');

  const status = data.counted
    ? '<p class="done-note">Verified — this result has been added to the totals above.</p>'
    : '<p class="muted">Not yet added to totals: needs two matching photos from two different phones, both with Osun location data.</p>';

  row.innerHTML = `<td colspan="4">${status}${cards}</td>`;
}

/* -------------------------------- upload --------------------------------- */

// Both inputs feed the same handler; they differ only in whether `capture`
// sends the phone straight to the camera.
['#file-camera', '#file-library'].forEach((sel) => {
  $(sel).addEventListener('change', (e) => handleFile(e));
});

async function handleFile(e) {
  const file = e.target.files?.[0];
  const code = pendingPu;
  e.target.value = '';
  if (!file || !code) return;

  toast('Uploading photo…', 60000);
  try {
    /* The response was previously read straight into { url, key } without
       checking the status, so a refusal -- uploads closed, bad polling unit --
       produced an undefined url, a PUT to "undefined", and the generic "that
       upload did not go through". Read the status first and say what the
       server actually said. */
    const r = await fetch(`${API}/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ puCode: code }),
    });
    let payload = {};
    try { payload = await r.json(); } catch { payload = {}; }
    if (!r.ok) {
      toast(payload.error || `Could not start the upload (HTTP ${r.status}).`, 10000);
      await loadSummary({ fresh: true });   // pick up an uploads-closed switch
      return;
    }
    const { url, key } = payload;

    const putRes = await fetch(url, { method: 'PUT', body: file });
    if (!putRes.ok) throw new Error('upload failed');

    toast('Reading the result sheet…', 60000);
    const doneRes = await fetch(`${API}/upload-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ puCode: code, key, deviceId }),
    });
    let done = {};
    try { done = await doneRes.json(); } catch { done = {}; }
    if (!doneRes.ok) {
      toast(done.error || `The photo was uploaded but could not be read (HTTP ${doneRes.status}).`, 10000);
      await loadSummary({ fresh: true });
      return;
    }

    toast(done.message, 12000);
    await loadSummary({ fresh: true });
    refreshRow(code);
  } catch (err) {
    console.error(err);
    toast('Sorry, that upload did not go through. Please try again.');
  }
}

function refreshRow(code) {
  const tr = document.querySelector(`tr[data-code="${CSS.escape(code)}"]`);
  if (!tr) return;
  tr.querySelector('.uploads-done').innerHTML = uploadLabel(code);
  const [n = 0] = viewCounts()[code] || [];
  tr.querySelector('.link-extract').textContent = n ? 'view extracted result' : 'no result yet';
}

/* --------------------------------- admin --------------------------------- */

/* One place decides what "uploads are closed" looks like, so the banner, the
   location hint and the buttons cannot drift out of step with each other. */
function refreshUploadUi() {
  // An archived election never accepts uploads, whatever the site-wide switch
  // says -- the contest is finished, not merely paused. Test mode opens
  // uploads on its own, since exercising the flow is the whole point of it.
  const on = !IS_ARCHIVE && (!!SUMMARY.uploadsEnabled || !!SUMMARY.testMode);
  $('#test-banner').hidden = !SUMMARY.testMode || IS_ARCHIVE;

  const tt = $('#test-toggle-btn');
  tt.hidden = !isAdmin() || IS_ARCHIVE;
  tt.textContent = SUMMARY.testMode ? 'Disable test mode' : 'Enable test mode';
  tt.classList.toggle('btn-danger', !!SUMMARY.testMode);
  $('#uploads-closed').hidden = on || IS_ARCHIVE || !!SUMMARY.testMode;
  $('#location-notice').hidden = !on;
  document.querySelectorAll('.btn-up').forEach((b) => {
    b.disabled = !on;
    b.title = on ? '' : 'Uploads are currently closed';
  });

  /* "N uploads" counts POLLING UNITS with photos, not photos. Twenty photos of
     one unit is one decision to make, and the number an admin needs is how many
     decisions are waiting. Read straight off the summary the page already has,
     so the line costs no extra request. */
  const withUploads = Object.values(viewCounts()).filter(([n = 0]) => n > 0).length;
  const line = $('#approve-line');
  line.hidden = !isAdmin() || IS_ARCHIVE;
  $('#approve-link').textContent = `${nf.format(withUploads)} upload${withUploads === 1 ? '' : 's'}`;

  const t = $('#uploads-toggle-btn');
  t.hidden = !isAdmin() || IS_ARCHIVE;
  /* The label reports the UPLOADS SWITCH, not whether uploading happens to be
     possible. Test mode permits uploads without touching that switch, so
     reading the effective state here made the button claim uploads were open
     while the switch was still closed. */
  t.textContent = `Disable uploads: ${SUMMARY.uploadsEnabled ? 'OFF' : 'ON'}`;
}

function refreshAdminUi() {
  $('#admin-flag').hidden = !isAdmin();
  $('#admin-login-btn').hidden = isAdmin();
  $('#admin-logout-btn').hidden = !isAdmin();
  // Hidden for visitors. The pages behind these also check the token, and the
  // endpoints they call require it, so hiding the buttons is presentation
  // rather than the access control itself.
  $('#upload-count-btn').hidden = !isAdmin();
  $('#admin-msgs-btn').hidden = !isAdmin();
  refreshUploadUi();
}

/* Test mode, from the front page. Switching it OFF destroys everything done
   while it was on, so it asks first and names what will go. Switching it ON is
   harmless and does not ask. */
$('#test-toggle-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const turningOff = !!SUMMARY.testMode;

  if (turningOff && !confirm(
    'Switch test mode OFF?\n\nEverything uploaded or approved during test mode ' +
    'will be permanently erased. Real election results are not affected.')) return;

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = turningOff ? 'Erasing test data…' : 'Enabling…';
  try {
    const r = await fetch(`${API}/admin/test-mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ enabled: !SUMMARY.testMode }),
    });
    if (r.status === 401) {
      adminToken = '';
      sessionStorage.removeItem('irev2-admin');
      refreshAdminUi();
      toast('Your admin session expired. Please log in again.');
      return;
    }
    if (!r.ok) {
      let msg = `Could not change test mode (HTTP ${r.status}).`;
      try { msg = (await r.json()).error || msg; } catch { /* keep the status message */ }
      toast(msg, 10000);
      btn.textContent = original;
      return;
    }
    const j = await r.json();
    toast(j.testMode
      ? 'Test mode is ON. Uploads go to an isolated test area and are deleted when it is switched off.'
      : `Test mode is OFF. Removed ${j.removed?.items ?? 0} test record(s) and ` +
        `${j.removed?.photos ?? 0} photo(s). Real results are unchanged.`, 12000);

    // The live election has just changed underneath the grid, so redraw it.
    await loadSummary({ fresh: true });
    applyFilter();
  } catch {
    toast('Could not reach the server. Test mode was not changed.');
    btn.textContent = original;
  } finally {
    btn.disabled = false;
    refreshUploadUi();
  }
});

$('#safe-harbour-btn').addEventListener('click', () => {
  $('#safe-harbour-dlg').showModal();
});

/* Opening and closing uploads. The portal stays up between elections -- results
   remain viewable -- but nothing new can be sent in, which is what stops the
   archive being polluted while no election is running. */
$('#uploads-toggle-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const next = !SUMMARY.uploadsEnabled;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = next ? 'Enabling…' : 'Disabling…';
  try {
    const r = await fetch(`${API}/admin/uploads-enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ enabled: next }),
    });
    if (r.status === 401) {
      adminToken = '';
      sessionStorage.removeItem('irev2-admin');
      refreshAdminUi();
      toast('Your admin session expired. Please log in again.');
      return;
    }
    if (!r.ok) {
      let msg = `Could not change uploads (HTTP ${r.status}).`;
      try { msg = (await r.json()).error || msg; } catch { /* keep the status message */ }
      toast(msg, 10000);
      btn.textContent = original;
      return;
    }
    SUMMARY.uploadsEnabled = (await r.json()).uploadsEnabled;
    toast(SUMMARY.uploadsEnabled
      ? 'Uploads are now OPEN — the public can send in result photos.'
      : 'Uploads are now CLOSED — the public can view results but cannot upload.', 9000);
  } catch {
    toast('Could not reach the server. Uploads were not changed.');
    btn.textContent = original;
  } finally {
    btn.disabled = false;
    refreshUploadUi();
  }
});

$('#admin-login-btn').addEventListener('click', () => {
  $('#login-err').hidden = true;
  $('#login-dlg').showModal();
});

$('#admin-logout-btn').addEventListener('click', () => {
  adminToken = '';
  sessionStorage.removeItem('irev2-admin');
  refreshAdminUi();
  document.querySelectorAll('tr.detail').forEach((d) => d.remove());
  toast('Logged out of admin.');
});

$('#admin-go').addEventListener('click', async () => {
  const err = $('#login-err');
  err.hidden = true;
  try {
    const r = await fetch(`${API}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('#admin-u').value, password: $('#admin-p').value }),
    });
    if (!r.ok) { err.textContent = 'Invalid username or password.'; err.hidden = false; return; }
    adminToken = (await r.json()).token;
    sessionStorage.setItem('irev2-admin', adminToken);
    $('#admin-p').value = '';
    $('#login-dlg').close();
    refreshAdminUi();
    toast('Logged in as admin. Open a polling unit to approve a photo.');
  } catch {
    err.textContent = 'Could not reach the server. Please try again.';
    err.hidden = false;
  }
});

async function approve(code, uploadId, btn) {
  const err = document.querySelector(`[data-err="${CSS.escape(uploadId)}"]`);
  const fail = (msg) => {
    // Loud on both channels: an inline line alone is easy to miss, and a
    // silent failure here reads as "approving does nothing".
    if (err) { err.textContent = msg; err.hidden = false; }
    toast(msg, 10000);
  };

  // Wrapped: this ran outside the try below, so an unexpected throw in here
  // became an unhandled rejection -- the button did nothing and said nothing.
  let figures, error;
  try {
    ({ figures, error } = collectFigures(uploadId));
  } catch (e) {
    console.error('collectFigures', e);
    fail(`Could not read the figures table (${e.message}). Please reload and try again.`);
    return;
  }
  if (error) { fail(error); return; }
  if (err) err.hidden = true;

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Approving…';
  try {
    const r = await fetch(`${API}/admin/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ puCode: code, uploadId, figures }),
    });

    // An HTML body here means something between the browser and the API
    // rewrote the response, so say that rather than showing markup.
    let payload = {};
    const text = await r.text();
    try { payload = JSON.parse(text); }
    catch { payload = { error: `Unexpected reply from the server (HTTP ${r.status}).` }; }

    if (r.status === 401) {
      adminToken = '';
      sessionStorage.removeItem('irev2-admin');
      refreshAdminUi();
      fail('Your admin session expired. Please log in again, then approve.');
      return;
    }
    if (!r.ok) {
      // Surface what the server actually said rather than a generic message.
      fail(payload.error || `Approve failed (HTTP ${r.status}).`);
      btn.disabled = false;
      btn.textContent = original;
      return;
    }

    const added = Object.entries(payload.added || figures)
      .map(([p, v]) => `${p} ${nf.format(v)}`).join(', ');
    toast(`Approved — added to the totals: ${added}`, 12000);

    await loadSummary({ fresh: true });
    refreshRow(code);
    // Reopen the panel so it redraws with the verified state.
    const tr = document.querySelector(`tr[data-code="${CSS.escape(code)}"]`);
    if (tr) { document.querySelectorAll('tr.detail').forEach((d) => d.remove()); toggleExtract(code, tr); }
  } catch (e) {
    console.error('approve', e);
    btn.disabled = false;
    btn.textContent = original;
    fail('Could not reach the server. Nothing was changed — please try again.');
  }
}

/* -------------------------------- wiring --------------------------------- */

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) {
    e.target.closest('dialog')?.close();
    return;
  }

  const src = e.target.closest('[data-source]');
  if (src) {
    $('#source-dlg').close();
    $(src.dataset.source === 'camera' ? '#file-camera' : '#file-library').click();
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const code = btn.dataset.code;
  const act = btn.dataset.act;

  if (act === 'addrow') {
    const tbl = document.querySelector(`[data-edit="${CSS.escape(btn.dataset.upload)}"]`);
    tbl?.querySelector('tbody').insertAdjacentHTML('beforeend', editRow('', ''));
    tbl?.querySelector('tbody tr:last-child .p-in')?.focus();
    return;
  }
  if (act === 'delrow') {
    const tr = btn.closest('tr');
    const tbody = tr.parentElement;
    tr.remove();
    if (!tbody.children.length) tbody.insertAdjacentHTML('beforeend', editRow('', ''));
    return;
  }
  if (act === 'resetrows') {
    const id = btn.dataset.upload;
    const tbl = document.querySelector(`[data-edit="${CSS.escape(id)}"]`);
    const entries = Object.entries(OCR[id] || {}).sort((a, b) => b[1] - a[1]);
    tbl.querySelector('tbody').innerHTML = entries.length
      ? entries.map(([p, v]) => editRow(p, v)).join('')
      : editRow('', '');
    const err = document.querySelector(`[data-err="${CSS.escape(id)}"]`);
    if (err) err.hidden = true;
    return;
  }

  if (act === 'upload') {
    // Checked here as well as server-side: the button is disabled when uploads
    // are closed, but a page left open across a toggle would still be clickable.
    if (!SUMMARY.uploadsEnabled) {
      toast('Uploads are currently closed. Please come back when the administrator opens them.');
      return;
    }
    pendingPu = code;
    const pu = DATA?.pus.find((p) => p[0] === code);
    $('#source-pu').textContent = pu ? `${pu[1]} · ${code}` : code;
    $('#source-dlg').showModal();
  } else if (act === 'extract') {
    toggleExtract(code, btn.closest('tr'));
  } else if (act === 'approve') {
    approve(code, btn.dataset.upload, btn);
  }
});

let debounce;
['#q-pu', '#q-ward'].forEach((sel) => {
  $(sel).addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyFilter, 140);
  });
});

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && DATA) renderMore();
}, { rootMargin: '400px' }).observe($('#sentinel'));

/* /summary carries max-age=15 so ordinary page loads stay cheap. Straight after
   an approve that cache is a liability: the browser can serve the pre-approve
   copy and the totals look unchanged, which reads as "it didn't work". So a
   post-mutation read explicitly bypasses it. */
async function loadSummary({ fresh = false } = {}) {
  try {
    const url = fresh ? `${API}/summary?t=${Date.now()}` : `${API}/summary`;
    SUMMARY = await (await fetch(url, fresh ? { cache: 'no-store' } : undefined)).json();
  } catch { /* totals stay as they were; the grid still works */ }
  renderTotals();
  refreshUploadUi();
}

/* The known-party set grows as sheets are read and as admins type corrections,
   so the suggestion list is fetched rather than hardcoded -- a party learned
   from yesterday's upload is offered today. */
async function loadPartyList() {
  if (!isAdmin() || $('#party-list').childElementCount) return;
  try {
    const { parties } = await (await fetch(`${API}/parties`)).json();
    $('#party-list').innerHTML = (parties || [])
      .map((p) => `<option value="${esc(p)}"></option>`).join('');
  } catch { /* the field still accepts free text */ }
}

/* The archive is the same page with a different subject, so it says which
   election is on screen instead of leaving the reader to notice the figures
   changed. */
function paintView() {
  if (!IS_ARCHIVE) return;
  document.title = 'Osun election archive — irev2.com';
  $('#archive-banner').hidden = false;
  $('#live-link').hidden = false;
  $('#archive-link').hidden = true;
}

(async function init() {
  paintView();
  refreshAdminUi();
  try {
    DATA = await (await fetch('/polling-units.json')).json();
  } catch {
    $('#count-line').textContent = 'Could not load the polling unit list.';
    return;
  }
  await loadSummary();
  applyFilter();
})();
