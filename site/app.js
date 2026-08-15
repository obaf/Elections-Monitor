/* Osun Election Monitoring Portal — front page.
   Plain ES modules-free JS so the site deploys as static files with no build. */

const API = '/api';
const BATCH = 150;               // rows rendered per scroll step
let DATA = null;                 // { lgas, wards, pus }
let SUMMARY = { totals: {}, counts: {} };
let filtered = [];
let rendered = 0;
let pendingPu = null;            // polling unit awaiting a file pick

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
    </div>`;
  }).join('');

  const status = data.counted
    ? '<p class="done-note">Verified — this result has been added to the totals above.</p>'
    : '<p class="muted">Not yet added to totals: needs two matching photos from two different phones, both with Osun location data.</p>';

  row.innerHTML = `<td colspan="4">${status}${cards}</td>`;
}

/* -------------------------------- upload --------------------------------- */

$('#file').addEventListener('change', async (e) => {
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
});

function refreshRow(code) {
  const tr = document.querySelector(`tr[data-code="${CSS.escape(code)}"]`);
  if (!tr) return;
  tr.querySelector('.uploads-done').innerHTML = uploadLabel(code);
  const [n = 0] = SUMMARY.counts[code] || [];
  tr.querySelector('.link-extract').textContent = n ? 'view extracted result' : 'no result yet';
}

/* -------------------------------- wiring --------------------------------- */

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const code = btn.dataset.code;
  if (btn.dataset.act === 'upload') {
    pendingPu = code;
    $('#file').click();
  } else if (btn.dataset.act === 'extract') {
    toggleExtract(code, btn.closest('tr'));
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
  try {
    DATA = await (await fetch('/polling-units.json')).json();
  } catch {
    $('#count-line').textContent = 'Could not load the polling unit list.';
    return;
  }
  await loadSummary();
  applyFilter();
})();
