/* Polling unit data, shared by every page that needs to name a polling unit.
 *
 * Nigeria has 176,595 polling units. Shipping them as one file is 1.8 MB over
 * the wire even gzipped -- a quarter-minute of waiting on the mobile
 * connections this portal is actually used on. So the data is split:
 *
 *   /polling-units.json   states + LGAs + wards. ~80 KB gzipped, always loaded.
 *   /pu/<state>.json      one state's units. Fetched only when something needs
 *                         it, and remembered once fetched.
 *
 * The split works because a PU code BEGINS with its state: "29-30-04-003" is
 * Osun. The first thing a searcher types already says which file to fetch, so
 * a typical visit downloads the index plus one state -- about 119 KB -- rather
 * than the whole country.
 *
 * Units are stored as [serial, name, wardIndex] and the full code is rebuilt
 * from the ward's own prefix. Storing "29-30-04-003" on all 176k rows would add
 * roughly 2 MB for information already implied by the ward.
 */
(function (global) {
  'use strict';

  const INDEX_URL = '/polling-units.json';
  const stateUrl = (code) => `/pu/${code}.json`;

  let index = null;              // { states, lgas, wards, counts }
  let indexPromise = null;
  const stateData = new Map();   // stateCode -> [ [serial, name, wardIdx], ... ]
  const statePromises = new Map();

  const pad2 = (n) => String(n).padStart(2, '0');

  /* The state a PU code belongs to. Tolerates a partial code, because this is
     called on every keystroke while someone is still typing one. */
  function stateOf(code) {
    const m = String(code || '').trim().match(/^(\d{1,2})/);
    return m ? pad2(m[1]) : null;
  }

  async function loadIndex() {
    if (index) return index;
    if (!indexPromise) {
      indexPromise = fetch(INDEX_URL)
        .then((r) => {
          if (!r.ok) throw new Error(`polling unit index: HTTP ${r.status}`);
          return r.json();
        })
        .then((d) => { index = d; return d; });
    }
    return indexPromise;
  }

  /* One state's units. Cached both as data and as an in-flight promise, so a
     page that asks for the same state three times in one render fetches once. */
  async function loadState(stateCode) {
    const code = pad2(stateCode);
    if (stateData.has(code)) return stateData.get(code);
    if (!statePromises.has(code)) {
      statePromises.set(code, fetch(stateUrl(code))
        .then((r) => {
          if (!r.ok) throw new Error(`polling units for state ${code}: HTTP ${r.status}`);
          return r.json();
        })
        .then((d) => {
          const pus = d.pus || [];
          stateData.set(code, pus);
          return pus;
        })
        .catch((e) => {
          // Do not cache a failure: a flaky network should not permanently
          // blank a state's names for the rest of the session.
          statePromises.delete(code);
          throw e;
        }));
    }
    return statePromises.get(code);
  }

  // Load whatever states a set of PU codes needs, in one go.
  async function ensureFor(codes) {
    await loadIndex();
    const wanted = new Set();
    for (const c of codes || []) {
      const s = stateOf(c);
      if (s) wanted.add(s);
    }
    await Promise.all([...wanted].map((s) => loadState(s).catch(() => null)));
  }

  const wardOfUnit = (u) => index.wards[u[2]];
  const codeOfUnit = (u) => `${index.wards[u[2]][2]}-${u[0]}`;

  function describe(u) {
    const ward = index.wards[u[2]];
    const lga = index.lgas[ward[1]];
    const state = index.states[lga[1]];
    return {
      code: `${ward[2]}-${u[0]}`,
      name: u[1],
      ward: ward[0],
      lga: lga[0],
      state: state[0],
      stateCode: state[1],
    };
  }

  /* A single unit by its full code. Returns null when the state is not loaded
     yet -- callers that need it resolved should ensureFor() first, which is
     cheaper than this discovering it one code at a time. */
  function unit(code) {
    if (!index) return null;
    const s = stateOf(code);
    const pus = s && stateData.get(s);
    if (!pus) return null;
    const want = String(code).trim();
    for (const u of pus) {
      if (codeOfUnit(u) === want) return describe(u);
    }
    return null;
  }

  // Name for a code, falling back to the code itself so a row never renders
  // blank while its state is still loading.
  function nameOf(code) {
    return unit(code)?.name || code;
  }

  /* Search.
   *
   * `code` is matched against the full PU code, which is what the page now
   * asks people to type. `ward` is matched against ward names in the index,
   * which is loaded for the whole country -- so a ward search can find matches
   * in states whose units are not downloaded yet, and those states are fetched
   * before the results are returned.
   */
  async function search({ code = '', ward = '', maxStates = 3 } = {}) {
    await loadIndex();
    const q = String(code).trim().toUpperCase();
    const qw = String(ward).trim().toUpperCase();
    if (!q && !qw) return { units: [], needsNarrowing: false, states: [] };

    let states = [];
    if (q) {
      const s = stateOf(q);
      if (s && index.counts[s]) states = [s];
    }
    if (!states.length && qw) {
      // Which states contain a ward matching this text?
      const hit = new Set();
      index.wards.forEach((w) => {
        if (w[0].toUpperCase().includes(qw)) hit.add(index.states[index.lgas[w[1]][1]][1]);
      });
      states = [...hit];
    }

    if (!states.length) return { units: [], needsNarrowing: false, states: [] };
    if (states.length > maxStates) {
      // Refuse to pull half the country to answer a two-letter ward search.
      return { units: [], needsNarrowing: true, states };
    }

    await Promise.all(states.map((s) => loadState(s).catch(() => null)));

    const out = [];
    for (const s of states) {
      for (const u of stateData.get(s) || []) {
        const c = codeOfUnit(u);
        if (q && !c.includes(q) && !u[1].toUpperCase().includes(q)) continue;
        if (qw && !index.wards[u[2]][0].toUpperCase().includes(qw)) continue;
        out.push(describe(u));
      }
    }
    return { units: out, needsNarrowing: false, states };
  }

  // Everything loaded so far, for pages that render a list of known codes.
  function loadedUnits() {
    const out = [];
    for (const pus of stateData.values()) for (const u of pus) out.push(describe(u));
    return out;
  }

  global.PU = {
    loadIndex, loadState, ensureFor, search, unit, nameOf, loadedUnits, stateOf,
    get index() { return index; },
    get total() {
      return index ? Object.values(index.counts).reduce((a, b) => a + b, 0) : 0;
    },
    get states() { return index ? index.states : []; },
  };
})(window);
