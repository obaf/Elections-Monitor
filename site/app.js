/* Osun Election Monitoring Portal — front page.
   Plain ES modules-free JS so the site deploys as static files with no build. */

const API = '/api';
const BATCH = 150;               // rows rendered per scroll step
let DATA = null;                 // { lgas, wards, pus }
let SUMMARY = { totals: {}, counts: {} };
let filtered = [];
let rendered = 0;
let pendingPu = null;            // polling unit awaiting a file pick

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

function adminBox(u, counted, code) {
  if (!isAdmin() || counted) return '';
  const why = u.inOsun
    ? 'This photo has Osun location data but has not been matched by a second phone yet.'
    : 'This photo carries no Osun location data, so it cannot be counted automatically.';
  return `<div class="admin-box">
    <p>${why} Approving adds these figures to the totals for this polling unit.</p>
    <button class="btn btn-primary" data-act="approve"
            data-code="${esc(code)}" data-upload="${esc(u.uploadId)}">
      Approve this photo into the totals
    </button>
  </div>`;
}

async function toggleExtract(code, tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  document.querySelectorAll('tr.detail').forEach((d) => d.remove());

  const row = document.createElement('tr');
  row.className = 'detail';
  row.innerHTML = `<td colspan="4">Loading…</td>`;
  tr.after(row);

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
    return `<div class="card">
      <div><strong>Photo ${i + 1}</strong> · ${new Date(u.ts).toLocaleString()} · ${badge}
           · <span class="pu-code">phone ${esc(u.device)}</span></div>
      <img src="${esc(u.url)}" alt="Result sheet photo ${i + 1}" loading="lazy"
           oncontextmenu="return false">
      ${table}
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
    await loadSummary();
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
  // Hidden for visitors. The page behind it also checks the token server-side,
  // so hiding the button is presentation, not the access control.
  $('#upload-count-btn').hidden = !isAdmin();
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
  btn.disabled = true;
  btn.textContent = 'Approving…';
  try {
    const r = await fetch(`${API}/admin/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ puCode: code, uploadId }),
    });
    if (r.status === 401) {
      adminToken = '';
      sessionStorage.removeItem('irev2-admin');
      refreshAdminUi();
      toast('Your admin session expired. Please log in again.');
      return;
    }
    if (!r.ok) throw new Error('approve failed');
    toast('Approved — the figures have been added to the totals.');
    await loadSummary();
    refreshRow(code);
    // Reopen the panel so it redraws with the verified state.
    const tr = document.querySelector(`tr[data-code="${CSS.escape(code)}"]`);
    if (tr) { document.querySelectorAll('tr.detail').forEach((d) => d.remove()); toggleExtract(code, tr); }
  } catch {
    btn.disabled = false;
    btn.textContent = 'Approve this photo into the totals';
    toast('Could not approve that photo. Please try again.');
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

  if (btn.dataset.act === 'upload') {
    pendingPu = code;
    const pu = DATA?.pus.find((p) => p[0] === code);
    $('#source-pu').textContent = pu ? `${pu[1]} · ${code}` : code;
    $('#source-dlg').showModal();
  } else if (btn.dataset.act === 'extract') {
    toggleExtract(code, btn.closest('tr'));
  } else if (btn.dataset.act === 'approve') {
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

async function loadSummary() {
  try {
    SUMMARY = await (await fetch(`${API}/summary`)).json();
  } catch { /* totals stay as they were; the grid still works */ }
  renderTotals();
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
