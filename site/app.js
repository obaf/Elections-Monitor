/* Osun Election Monitoring Portal — front page.
   Plain ES modules-free JS so the site deploys as static files with no build. */

const API = '/api';
const BATCH = 150;               // rows rendered per scroll step
let DATA = null;                 // { lgas, wards, pus }
let SUMMARY = { totals: {}, counts: {} };
let filtered = [];
let rendered = 0;
let pendingPu = null;            // polling unit awaiting a file pick
const OCR = {};                  // uploadId -> figures as Textract read them

/* The admin sees the ordinary page plus approve controls, rather than a
   separate screen, so the thing being approved is viewed in its real context.
   Same storage key as admin.html, so a login on either carries across. */
let adminToken = sessionStorage.getItem('irev2-admin') || '';
const isAdmin = () => !!adminToken;

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

/* ------------------------------- totals --------------------------------- */

function renderTotals() {
  const entries = Object.entries(SUMMARY.totals || {}).sort((a, b) => b[1] - a[1]);
  const el = $('#totals');
  if (!entries.length) {
    el.innerHTML = '<p class="muted">No verified results yet. Totals appear here once two matching photos ' +
                   'from two different phones are uploaded for a polling unit.</p>';
    return;
  }
  el.innerHTML = entries
    .map(([p, v]) => `<div class="tile"><div class="p">${esc(p)}</div><div class="v">${nf.format(v)}</div></div>`)
    .join('');
}

/* -------------------------------- grid ---------------------------------- */

function uploadLabel(code) {
  const [n = 0, counted = 0] = SUMMARY.counts[code] || [];
  if (counted) return `<span class="done-note">${n} uploads done – no need for further uploads</span>`;
  return `${n} upload${n === 1 ? '' : 's'} done`;
}

function rowHtml(pu) {
  const [code, name, wardIdx] = pu;
  const [wardName, lgaIdx] = DATA.wards[wardIdx];
  const lga = DATA.lgas[lgaIdx];
  const [n = 0] = SUMMARY.counts[code] || [];
  return `<tr data-code="${esc(code)}">
    <td class="col-upload">
      <button class="btn btn-primary btn-up" data-act="upload" data-code="${esc(code)}">Upload photo</button>
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
  if (!isAdmin() || counted) return '';
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
  const figures = {};
  for (const tr of tbl.querySelectorAll('tbody tr')) {
    const party = tr.querySelector('.p-in').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Thousands separators and stray spaces are how people actually type
    // figures off a sheet, so accept them instead of rejecting the row.
    const raw = tr.querySelector('.v-in').value.trim().replace(/[,\s]/g, '');
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
    data = await (await fetch(`${API}/pu?code=${encodeURIComponent(code)}`)).json();
  } catch {
    row.innerHTML = `<td colspan="4">Could not load results. Please try again.</td>`;
    return;
  }

  if (!data.uploads?.length) {
    row.innerHTML = `<td colspan="4"><p class="muted">No photos uploaded for this polling unit yet.</p></td>`;
    return;
  }

  const cards = data.uploads.map((u, i) => {
    const rows = Object.entries(u.extracted || {}).sort((a, b) => b[1] - a[1]);
    const table = rows.length
      ? `<table><tbody>${rows.map(([p, v]) =>
          `<tr><th>${esc(p)}</th><td>${nf.format(v)}</td></tr>`).join('')}</tbody></table>`
      : `<p class="muted">No party figures could be read from this photo.</p>`;
    const badge = u.inOsun
      ? '<span class="badge badge-ok">location in Osun</span>'
      : '<span class="badge badge-no">no Osun location data</span>';
    // Remember what OCR read, so "reset" can put it back after edits.
    OCR[u.uploadId] = u.extracted || {};
    // For an admin about to approve, the editable table replaces the static one
    // rather than sitting under a duplicate of the same numbers.
    const editing = isAdmin() && !data.counted;
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
    const { url, key } = await (await fetch(`${API}/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ puCode: code }),
    })).json();

    const putRes = await fetch(url, { method: 'PUT', body: file });
    if (!putRes.ok) throw new Error('upload failed');

    toast('Reading the result sheet…', 60000);
    const done = await (await fetch(`${API}/upload-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ puCode: code, key, deviceId }),
    })).json();

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
  const [n = 0] = SUMMARY.counts[code] || [];
  tr.querySelector('.link-extract').textContent = n ? 'view extracted result' : 'no result yet';
}

/* --------------------------------- admin --------------------------------- */

function refreshAdminUi() {
  $('#admin-flag').hidden = !isAdmin();
  $('#admin-login-btn').hidden = isAdmin();
  $('#admin-logout-btn').hidden = !isAdmin();
  // Hidden for visitors. The pages behind these also check the token, and the
  // endpoints they call require it, so hiding the buttons is presentation
  // rather than the access control itself.
  $('#upload-count-btn').hidden = !isAdmin();
  $('#admin-msgs-btn').hidden = !isAdmin();
}

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

  const { figures, error } = collectFigures(uploadId);
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

(async function init() {
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
