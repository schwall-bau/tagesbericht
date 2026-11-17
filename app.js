'use strict';
/* Schwall Tagesbericht – Polier-App (PWA)
   Läuft komplett im Browser des Handys, auch offline.
   Erzeugt Tagesbericht- und Bautagebuch-PDF + Daten (JSON) + Lohn-CSV
   und versendet sie per E-Mail (Teilen-Menü) oder optional direkt an Power Automate. */
const APP_VERSION = '1.0.0';
const FIRMA = { name: 'Schwall', zusatz: 'Bauunternehmung GmbH', adr: 'Neue Welt 50 · 88471 Laupheim', tel: 'Tel. (073 92) 9703-0' };

// ---------------------------------------------------------------- Speicher (IndexedDB)
const DB = {
  db: null,
  open() { return this.db ? Promise.resolve(this.db) : new Promise((res, rej) => { const r = indexedDB.open('schwall-tb', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { this.db = r.result; res(this.db) }; r.onerror = () => rej(r.error) }) },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) }) },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error) }) },
  async del(k) { const db = await this.open(); return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res() }) }
};

// ---------------------------------------------------------------- Hilfsfunktionen
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n };
const fmt = n => (Math.round(n * 100) / 100).toString().replace('.', ',');
const fq = n => num(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f2 = n => num(n) ? fq(n) : '';
const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const PAUSEN = ['0:00', '0:15', '0:30', '0:45', '1:00', '1:15', '1:30'];
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10) };
const toMin = t => { if (!t) return 0; const [a, b] = t.split(':').map(Number); return a * 60 + (b || 0) };
const dauer = r => Math.max(0, (toMin(r.ende) - toMin(r.beginn) - toMin(r.pause)) / 60);
const dateDe = s => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}.${m}.${y}` };
const dShort = (s, sep) => { if (!s) return ''; const [y, m, d] = s.split('-'); return [d, m, y.slice(2)].join(sep) };
const yymmdd = s => s ? s.slice(2).replace(/-/g, '') : '';
const wtag = s => s ? WT[new Date(s + 'T12:00').getDay()] : '';
const sumH = o => Object.values(o.h || {}).reduce((a, b) => a + num(b), 0);
const zusText = z => ({ Ur: 'Urlaub', Kr: 'Krank', SW: 'Schlechtwetter', SU: 'Sonderurlaub', FE: 'Feiertag', FU: 'Fortbildung/Unterweisung' })[z] || z;
function toast(t, ms = 2800) { const e = document.createElement('div'); e.className = 'toast'; e.textContent = t; document.body.appendChild(e); setTimeout(() => e.remove(), ms) }
function wrapLines(t, max) { const out = []; String(t || '').split(/\n/).forEach(par => { let l = ''; par.split(/\s+/).forEach(w => { if (!w) return; if ((l + ' ' + w).trim().length > max) { if (l) out.push(l); l = w } else l = (l + ' ' + w).trim() }); if (l) out.push(l) }); return out }
const clone = o => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- Zustand
let SD = null;            // Stammdaten
let SET = { polier: '', email: '', uploadUrl: '' };
let HIST = [];            // gesendete Berichte (ohne Dateien)
let QUEUE = [];           // Upload-Warteschlange (nur Direktversand)
const S = { view: 'home', step: 0, r: null, doc: 'tb', prepared: null };
let saveTimer = null;
function saveDraft() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (S.r) DB.set('draft', S.r) }, 400) }
const flushDraft = () => { clearTimeout(saveTimer); if (S.r) DB.set('draft', S.r) };
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDraft() });
window.addEventListener('pagehide', flushDraft);

function neuerBericht() {
  return { id: uid(), datum: today(), von: SET.polier || '', baustelle: '', bauteil: '', baunr: '', bauherr: '', wetter: '', temp: '', wasser: '',
    beginn: '07:00', ende: '16:30', pause: '0:30', aps: [{ id: uid(), nr: '', text: '' }], personal: [], geraete: [], material: [], bem: '', vork: '', sig: '' };
}

// ---------------------------------------------------------------- Stammdaten-Import (Excel-Vorlage oder JSON)
function parseStammdatenRows(rows, quelle) {
  const c = (r, i) => (rows[r] && rows[r][i] != null) ? rows[r][i] : null;
  const ma = [], ge = [], mat = [], lief = new Set(['DAM']), wetter = [], zus = [];
  for (let r = 1; r < rows.length; r++) {
    const n = c(r, 0); if (n && String(n).trim() !== '-') { let nr = c(r, 1); nr = nr == null ? '' : (typeof nr === 'number' ? String(nr).padStart(5, '0') : String(nr)); ma.push([String(n).trim(), nr]) }
    const w = c(r, 10); if (w) wetter.push(String(w).trim());
    const z = c(r, 18); if (z) zus.push(String(z).trim());
  }
  let grp = '';
  for (let r = 1; r < rows.length; r++) { const d = c(r, 3); if (!d) continue; const s = String(d).trim(); if (s.startsWith('---')) { grp = s.replace(/-/g, ''); continue } ge.push([s, String(c(r, 4) ?? ''), String(c(r, 5) ?? ''), grp]) }
  grp = '';
  for (let r = 1; r < rows.length; r++) {
    const h = c(r, 7); if (!h) continue; const s = String(h).trim();
    if (s.startsWith('---')) { grp = s.replace(/-/g, ''); if (grp === 'MKB' || grp === 'BSR') lief.add(grp); continue }
    if (s === '*') continue;
    if (grp === 'Nachunternehmer' || grp === 'Lieferanten') { lief.add(s); continue }
    const m = s.match(/\[(.+?)\]/); mat.push([s.replace(/\s*\[.+?\]/, ''), String(c(r, 8) ?? ''), m ? m[1] : '', grp]);
  }
  if (ma.length < 3 || ge.length < 3) throw new Error('In der Datei wurden keine Mitarbeiter-/Gerätelisten gefunden.');
  return { stand: today(), quelle, ma, ge, mat, lief: [...lief].sort((a, b) => a.localeCompare(b, 'de')), wetter: wetter.length ? wetter : ['sonnig', 'bedeckt', 'Regen'], zus: zus.length ? zus : ['Ur', 'Kr', 'SW', 'SU', 'FE', 'FU'] };
}
async function importStammdaten(file) {
  if (/\.json$/i.test(file.name)) { const d = JSON.parse(await file.text()); if (!d.ma || !d.ge) throw new Error('JSON enthält keine Stammdaten.'); return d }
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets['DropDown']; if (!ws) throw new Error('Blatt „DropDown“ nicht gefunden. Bitte eine Tagesbericht-Excel wählen.');
  return parseStammdatenRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }), file.name);
}

// ---------------------------------------------------------------- Start
async function init() {
  try {
    SD = await DB.get('stammdaten'); SET = Object.assign(SET, await DB.get('settings') || {});
    HIST = await DB.get('history') || []; QUEUE = await DB.get('queue') || [];
    if (!SD) { try { const r = await fetch('stammdaten.json', { cache: 'no-store' }); if (r.ok) { SD = await r.json(); await DB.set('stammdaten', SD) } } catch (e) { } }
  } catch (e) { console.error(e) }
  S.view = SD ? 'home' : 'setup';
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
  window.addEventListener('online', () => sendQueue(true));
  if (QUEUE.length && navigator.onLine) sendQueue(true);
}
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (S.view === 'home') render() });
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------- Rendering
const STEPS = [['Kopf', '📋'], ['Pakete', '🛣️'], ['Personal', '👷'], ['Geräte', '🚜'], ['Material', '🧾'], ['Abschluss', '✅']];
function render() {
  const hb = $('#hbtn'); hb.style.display = 'none';
  $('#steps').style.display = 'none'; $('#foot').style.display = 'none'; $('#hsub').textContent = '';
  if (S.view === 'erfassung') {
    const r = S.r, res = pruefe(r);
    $('#htitle').textContent = 'Tagesbericht'; $('#hsub').textContent = (r.datum ? wtag(r.datum) + ', ' + dateDe(r.datum) : '') + (r.baunr ? ' · ' + r.baunr : '');
    hb.style.display = ''; hb.textContent = '‹ Start'; hb.onclick = () => { S.view = 'home'; render() };
    $('#steps').style.display = 'flex';
    $('#steps').innerHTML = STEPS.map((s, i) => `<button class="${i === S.step ? 'on' : ''} ${i < S.step && !res.some(x => x.t === 'e' && x.s === i) ? 'done' : ''}" data-step="${i}"><b>${s[1]}</b>${s[0]}</button>`).join('');
    $('#main').innerHTML = [vKopf, vAps, vPers, vGer, vMat, vAbschluss][S.step]();
    $('#foot').style.display = 'flex';
    $('#foot').innerHTML = (S.step > 0 ? `<button class="btn ghost" data-act="prev">‹ Zurück</button>` : '') + (S.step < 5 ? `<button class="btn orange" data-act="next">Weiter ›</button>` : `<button class="btn orange" data-act="prepare">PDF erstellen & senden</button>`);
  } else {
    $('#htitle').textContent = { home: 'Tagesbericht', setup: 'Einrichtung', settings: 'Einstellungen', verlauf: 'Gesendete Berichte' }[S.view] || 'Tagesbericht';
    if (S.view !== 'home' && S.view !== 'setup') { hb.style.display = ''; hb.textContent = '‹ Start'; hb.onclick = () => { S.view = 'home'; render() } }
    $('#main').innerHTML = ({ home: vHome, setup: vSetup, settings: vSettings, verlauf: vVerlauf })[S.view]();
  }
  fitA4(); initSig();
}

// ---------------------------------------------------------------- Startseite / Einrichtung / Einstellungen
function vHome() {
  const draft = S.r && S.r._draft !== false && (S.r.baustelle || S.r.personal.length) ? S.r : null;
  return `${!standalone() ? `<div class="demo"><b>Als App installieren:</b> ${isIOS() ? 'In Safari unten auf <b>Teilen</b> (□↑) tippen → <b>„Zum Home-Bildschirm“</b>.' : installEvt ? '<button class="btn small orange" data-act="install">Jetzt installieren</button>' : 'Im Chrome-Menü <b>⋮</b> → <b>„App installieren“</b> bzw. „Zum Startbildschirm hinzufügen“.'}</div>` : ''}
  ${QUEUE.length ? `<div class="demo" style="background:#fdecea;border-color:#f5c2c0;color:#8a1c1c"><b>${QUEUE.length} Bericht(e) warten auf Versand</b> (kein Netz). <button class="btn small" data-act="sendqueue">Jetzt senden</button></div>` : ''}
  <div class="home-hero">
    <h2 style="margin-top:0">Hallo${SET.polier ? ' ' + esc(SET.polier.split(',').reverse().join(' ').trim()) : ''}</h2>
    ${draft ? `<button class="btn orange full big" data-act="weiter">Entwurf fortsetzen<br><small style="font-weight:400">${wtag(draft.datum)}, ${dateDe(draft.datum)} ${esc(draft.baunr)} ${esc(draft.baustelle)}</small></button>
      <div class="row" style="margin-top:8px"><button class="btn ghost" data-act="neu">Neuer Bericht</button><button class="btn danger" data-act="verwerfen">Entwurf löschen</button></div>`
      : `<button class="btn orange full big" data-act="neu">＋ Neuer Tagesbericht</button>`}
    ${HIST.length ? `<button class="btn ghost full" style="margin-top:8px" data-act="vorlage">↺ Wie letzter Bericht (${esc(HIST[0].baunr)} ${dateDe(HIST[0].datum)})</button>` : ''}
  </div>
  <div class="card"><div class="prow"><b>Gesendete Berichte</b><button class="btn small ghost" data-view="verlauf">Alle</button></div>
   <div class="lst">${HIST.slice(0, 5).map(histItem).join('') || '<div class="hint">Noch keine.</div>'}</div></div>
  <div class="card"><div class="prow"><div><b>Einstellungen</b><div class="small">Empfänger: ${esc(SET.email) || '<span style="color:var(--rot)">nicht festgelegt</span>'}<br>Stammdaten: ${SD ? SD.ma.length + ' Mitarbeiter, ' + SD.ge.length + ' Geräte · Stand ' + dateDe(SD.stand) : '–'}</div></div><button class="btn small ghost" data-view="settings">Ändern</button></div></div>
  <p class="small" style="text-align:center">Version ${APP_VERSION}</p>`;
}
function histItem(h) { return `<div class="it"><div><b>${wtag(h.datum)}, ${dateDe(h.datum)}</b> · ${esc(h.baunr)}<br><span class="small">${esc(h.baustelle)} · ${h.weg === 'upload' ? 'direkt übertragen' : 'per E-Mail geteilt'} ${h.gesendet ? new Date(h.gesendet).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span></div><button class="btn small ghost" data-resend="${h.id}">Erneut</button></div>` }
function vVerlauf() { return `<div class="card"><div class="lst">${HIST.map(histItem).join('') || '<div class="hint">Noch keine Berichte gesendet.</div>'}</div></div><p class="small">„Erneut“ erzeugt die PDFs neu und öffnet den Versand noch einmal. Gespeichert werden die letzten 30 Berichte auf diesem Handy.</p>` }
function vSetup() {
  return `<div class="home-hero"><h2 style="margin-top:0">Willkommen 👷</h2>
  <p>Einmalig einrichten – danach funktioniert die App auch ohne Netz.</p>
  <label>1. Dein Name (Polier)</label><input id="s_polier" value="${esc(SET.polier)}" placeholder="Nachname, Vorname">
  <label>2. E-Mail-Adresse für die Berichte (Büro)</label><input id="s_email" type="email" value="${esc(SET.email)}" placeholder="tagesbericht@schwall-bau.de">
  <label>3. Stammdaten laden</label><p class="hint">Die aktuelle <b>Tagesbericht-Excel</b> (mit Blatt „DropDown“) oder die Datei <b>stammdaten-schwall.json</b> vom Büro auswählen.</p>
  <span class="btn ghost full fotobtn">📂 Datei auswählen<input type="file" id="s_file" accept=".xlsx,.xlsm,.json,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></span>
  <div id="s_info" class="hint">${SD ? `✓ ${SD.ma.length} Mitarbeiter, ${SD.ge.length} Geräte, ${SD.mat.length} Materialien geladen` : ''}</div>
  <button class="btn orange full big" style="margin-top:14px" data-act="setupdone">Fertig</button></div>`;
}
function vSettings() {
  return `<div class="card"><label style="margin-top:0">Name (Polier)</label><input id="s_polier" value="${esc(SET.polier)}">
  <label>E-Mail-Empfänger (Büro)</label><input id="s_email" type="email" value="${esc(SET.email)}">
  <label>Direktversand – Power-Automate-Adresse (optional)</label><input id="s_url" value="${esc(SET.uploadUrl)}" placeholder="leer lassen = Versand per E-Mail">
  <p class="hint">Nur ausfüllen, wenn das Büro einen Power-Automate-Flow „Bei Eingang einer HTTP-Anforderung“ eingerichtet hat. Dann werden Berichte ohne E-Mail-App übertragen.</p>
  <button class="btn orange full" data-act="savesettings">Speichern</button></div>
  <div class="card"><b>Stammdaten</b><div class="hint">${SD ? `${SD.ma.length} Mitarbeiter, ${SD.ge.length} Geräte, ${SD.mat.length} Materialien · Stand ${dateDe(SD.stand)}<br>Quelle: ${esc(SD.quelle || '')}` : 'nicht geladen'}</div>
  <span class="btn ghost full fotobtn">📂 Neue Excel/JSON laden<input type="file" id="s_file" accept=".xlsx,.xlsm,.json"></span><div id="s_info" class="hint"></div></div>
  <div class="card"><b>Daten auf diesem Handy</b><p class="hint">Entwurf, Verlauf und Stammdaten liegen nur auf diesem Gerät.</p><button class="btn danger full" data-act="reset">Alles auf diesem Handy löschen</button></div>`;
}

// ---------------------------------------------------------------- Erfassung (wie Prototyp)
function vKopf() {
  const r = S.r; const bs = [...new Map(HIST.filter(h => h.baunr).map(h => [h.baunr, h])).values()];
  return `<h2>Baustelle & Tag</h2>
<div class="card">
 <label style="margin-top:0">Ausgestellt von (Polier)</label>${pickBtn('von', r.von || 'Polier auswählen …')}
 <div class="grid2"><div><label>Datum</label><input type="date" data-f="datum" value="${r.datum}"></div><div><label>Tag</label><input value="${wtag(r.datum)}" disabled></div></div>
 <label>Baustellen-Nr.</label><input data-f="baunr" list="bslist" inputmode="numeric" value="${esc(r.baunr)}" placeholder="z. B. 26025">
 <datalist id="bslist">${bs.map(h => `<option value="${esc(h.baunr)}">${esc(h.baustelle)}</option>`).join('')}</datalist>
 <label>Baustelle (Ort, Auftraggeber)</label><input data-f="baustelle" value="${esc(r.baustelle)}" placeholder="z. B. Laupheim, Diehl Aviation">
 <label>Bauteil / Bezeichnung</label><input data-f="bauteil" value="${esc(r.bauteil)}" placeholder="z. B. Leichtbauhalle bei Geb. 21 Ost">
 <label>Bauherr (Bautagebuch)</label><input data-f="bauherr" value="${esc(r.bauherr)}" placeholder="z. B. Diehl Aviation">
</div>
<div class="card">
 <label style="margin-top:0">Wetter</label><div class="chips">${SD.wetter.map(w => `<button class="chip ${r.wetter === w ? 'on' : ''}" data-wetter="${esc(w)}">${esc(w)}</button>`).join('')}</div>
 <div class="grid2"><div><label>Temperatur °C</label><input data-f="temp" inputmode="decimal" value="${esc(r.temp)}" placeholder="12"></div>
 <div><label>(Grund-)Wasserstand</label><input data-f="wasser" value="${esc(r.wasser)}" placeholder="optional"></div></div>
</div>`;
}
function apVorschlaege(r) { const m = new Map(); HIST.filter(x => !r.baunr || x.baunr === r.baunr).forEach(x => (x.aps || []).forEach(a => { if (a.nr && !m.has(a.nr)) m.set(a.nr, a.text) })); return [...m] }
function vAps() {
  const r = S.r; return `<h2>Arbeitspakete</h2>
<p class="hint">Jede Tätigkeit als eigenes Arbeitspaket (max. 7). Die AP-Nr. ist Pflicht.</p>
${r.aps.map((a, i) => `<div class="card"><div class="prow"><span class="ap-tag">Paket ${i + 1}</span>${r.aps.length > 1 ? `<button class="x" data-delap="${a.id}">✕</button>` : ''}</div>
<label>Arbeitspaket (AP-Nr.)</label><input list="aplist" data-ap="${a.id}" data-k="nr" value="${esc(a.nr)}" placeholder="z. B. 10 – auswählen oder eintippen">
<label>Arbeitsbeschreibung</label><textarea data-ap="${a.id}" data-k="text" placeholder="z. B. Planie zum Asphalteinbau hergestellt">${esc(a.text)}</textarea>
<div class="mic">🎤 Mikrofon auf der Handy-Tastatur antippen und sprechen.</div></div>`).join('')}
${r.aps.length < 7 ? `<button class="btn ghost full" data-act="addap">＋ Weiteres Arbeitspaket</button>` : ''}
<datalist id="aplist">${apVorschlaege(r).map(([n, t]) => `<option value="${esc(n)}">${esc(t)}</option>`).join('')}</datalist>`;
}
const apLbl = (a, i) => `<span class="ap-tag">AP ${esc(a.nr) || '?'}</span><span>${esc(a.text || 'ohne Beschreibung')}</span>`;
const stepper = (kind, id, ap, val) => `<div class="step"><button data-st="${kind}|${id}|${ap}|-0.25">−</button><input inputmode="decimal" data-hin="${kind}|${id}|${ap}" value="${val ? fmt(val) : ''}" placeholder="0"><button data-st="${kind}|${id}|${ap}|0.25">＋</button></div>`;
function vPers() {
  const r = S.r, d = dauer(r); return `<h2>Personal</h2>
<div class="grid2" style="margin-bottom:10px"><button class="btn" data-act="addma">＋ Mitarbeiter</button><button class="btn ghost" data-act="kolonne">↺ Kolonne vom letzten Bericht</button></div>
${r.personal.length ? `<div class="card" style="background:#f6f6f6"><div class="prow"><div class="hint" style="margin:0">Arbeitszeit lt. Abschluss: <b>${fq(d)} h</b></div><button class="btn small ghost" data-act="copyh">Stunden der 1. Person für alle</button></div></div>` : `<div class="empty">Noch niemand eingetragen.</div>`}
${r.personal.map(p => { const s = sumH(p); const warn = !p.zus && Math.abs(s - d) > 0.01; return `<div class="card">
 <div class="prow"><div><div class="pname">${esc(p.name)}</div><div class="pnr">Pers.-Nr. ${esc(p.nr) || '–'}</div></div><div style="display:flex;align-items:center"><span class="sum ${warn ? 'warn' : ''}">${p.zus ? esc(p.zus) : fq(s) + ' h'}</span><button class="x" data-del="personal|${p.id}">✕</button></div></div>
 <div class="chips" style="margin:8px 0">${SD.zus.map(z => `<button class="chip zus ${p.zus === z ? 'on' : ''}" data-zus="${p.id}|${z}">${z}</button>`).join('')}</div>
 ${p.zus ? `<div class="hint">${zusText(p.zus)}: keine Stunden auf Arbeitspakete.</div>` : r.aps.map((a, i) => `<div class="hrow"><div class="lbl">${apLbl(a, i)}</div>${stepper('personal', p.id, a.id, p.h[a.id])}</div>`).join('')}
</div>` }).join('')}`;
}
function vGer() {
  const r = S.r; return `<h2>Geräte</h2>
<button class="btn full" data-act="addge" style="margin-bottom:10px">＋ Gerät hinzufügen</button>
${r.geraete.length ? '' : `<div class="empty">Noch keine Geräte. Suche z. B. „walze“, „bw 100“ oder „6923“.</div>`}
${r.geraete.map(g => `<div class="card"><div class="prow"><div><div class="pname">${esc(g.name)}</div><div class="pnr">Artikel ${esc(g.nr) || '–'} · KST ${esc(g.ks) || '–'}</div></div><div style="display:flex;align-items:center"><span class="sum">${fq(sumH(g))} h</span><button class="x" data-del="geraete|${g.id}">✕</button></div></div>
${/miet/i.test(g.name) ? `<label>Mietfirma</label><input data-g="${g.id}" value="${esc(g.firma || '')}" placeholder="z. B. Haid">` : ''}
${r.aps.map((a, i) => `<div class="hrow"><div class="lbl">${apLbl(a, i)}</div>${stepper('geraete', g.id, a.id, g.h[a.id])}</div>`).join('')}</div>`).join('')}`;
}
function vMat() {
  const r = S.r; return `<h2>Material & Lieferscheine</h2>
<p class="hint">Pro Lieferschein ein Eintrag. Foto mit der Kamera – es wird als Anlage zum Tagesbericht abgelegt.</p>
${r.material.length ? '' : `<div class="empty">Noch kein Material.</div>`}
${r.material.map(m => `<div class="card"><div class="prow"><b>${esc(m.mat) || 'Material wählen'}</b><button class="x" data-del="material|${m.id}">✕</button></div>
 <label>Für Arbeitspaket</label><select data-m="${m.id}" data-k="ap">${r.aps.map((a, i) => `<option value="${a.id}" ${m.ap === a.id ? 'selected' : ''}>AP ${esc(a.nr) || '?'} ${esc((a.text || '').slice(0, 30))}</option>`).join('')}</select>
 <div class="grid2"><div><label>Lieferant</label>${pickBtn('lief|' + m.id, m.lief || 'wählen …')}</div><div><label>Material</label>${pickBtn('mat|' + m.id, m.mat || 'wählen …')}</div></div>
 <div class="grid2"><div><label>Lieferschein-Nr.</label><input data-m="${m.id}" data-k="ls" value="${esc(m.ls)}" placeholder="43663"></div>
 <div><label>Menge ${m.einh ? '[' + esc(m.einh) + ']' : ''}</label><input inputmode="decimal" data-m="${m.id}" data-k="menge" value="${m.menge !== '' && m.menge != null ? fmt(num(m.menge)) : ''}" placeholder="0,00"></div></div>
 <div style="margin-top:10px"><span class="btn ghost small fotobtn">📷 Lieferschein fotografieren<input type="file" accept="image/*" capture="environment" data-foto="${m.id}"></span></div>
 <div class="thumbs">${m.fotos.map((f, i) => `<img src="${f}" data-delfoto="${m.id}|${i}" title="Antippen zum Löschen">`).join('')}</div>
</div>`).join('')}
<div class="row"><button class="btn" data-act="addmat">＋ Lieferschein</button>${r.material.length ? `<button class="btn ghost" data-act="dupmat">＋ Gleiches Material</button>` : ''}</div>`;
}
function vAbschluss() {
  const r = S.r, res = pruefe(r); const e = res.filter(x => x.t === 'e').length, w = res.filter(x => x.t === 'w').length; return `<h2>Abschluss</h2>
<div class="card"><div class="grid2"><div><label style="margin-top:0">Beginn</label><input type="time" data-f="beginn" value="${r.beginn}"></div><div><label style="margin-top:0">Ende</label><input type="time" data-f="ende" value="${r.ende}"></div></div>
<label>Pause</label><div class="chips">${PAUSEN.map(p => `<button class="chip ${r.pause === p ? 'on' : ''}" data-pause="${p}">${p}</button>`).join('')}</div>
<div class="hint" style="margin-top:8px">Dauer: <b>${fq(dauer(r))} h</b></div></div>
<div class="card"><label style="margin-top:0">Bemerkungen / abweichende Arbeitszeit</label><textarea data-f="bem" placeholder="z. B. Segmehl bis 16:00 Uhr">${esc(r.bem)}</textarea>
<label>Wichtige Vorkommnisse, Besprechungen (Bautagebuch)</label><textarea data-f="vork" placeholder="z. B. Abnahme mit Bauleitung">${esc(r.vork)}</textarea>
<div class="mic">🎤 Mikrofon auf der Tastatur antippen: diktieren statt tippen.</div></div>
<h3>Prüfung ${e ? `<span class="badge" style="background:#fdecea;color:var(--rot)">${e} Fehler</span>` : ''} ${w ? `<span class="badge b-pr">${w} Hinweise</span>` : ''}</h3>
<div class="card">${res.length ? res.map(x => `<div class="check"><span class="dot ${x.t}">${x.t === 'e' ? '!' : '?'}</span><div>${x.m} <a href="#" data-go="${x.s}">ändern</a></div></div>`).join('') : `<div class="check"><span class="dot ok">✓</span><div>Alles vollständig.</div></div>`}</div>
<h3>Unterschrift Polier</h3><div class="card"><canvas class="sigpad" id="sig"></canvas><div class="prow" style="margin-top:6px"><span class="hint" style="margin:0">Mit dem Finger unterschreiben</span><button class="btn small ghost" data-act="sigclear">Löschen</button></div></div>
<h3>Vorschau</h3>${docViewer(r)}`;
}
function docViewer(r) { return `<div class="seg"><button class="${S.doc === 'tb' ? 'on' : ''}" data-doc="tb">Tagesbericht</button><button class="${S.doc === 'btb' ? 'on' : ''}" data-doc="btb">Bautagebuch</button></div><div class="a4wrap"><div class="a4box">${S.doc === 'tb' ? docTB(r) : docBTB(r)}</div></div>` }
const pickBtn = (k, label) => `<button class="btn ghost full" style="justify-content:space-between;font-weight:600" data-pick="${k}"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span><span>▾</span></button>`;

// ---------------------------------------------------------------- Prüfregeln
function pruefe(r) {
  const o = [], d = dauer(r);
  if (!r.von) o.push({ t: 'e', s: 0, m: 'Polier (ausgestellt von) fehlt.' });
  if (!r.baunr) o.push({ t: 'e', s: 0, m: 'Baustellen-Nr. fehlt.' });
  if (!r.baustelle) o.push({ t: 'e', s: 0, m: 'Baustelle fehlt.' });
  if (!r.wetter) o.push({ t: 'e', s: 0, m: 'Wetter fehlt (Pflicht fürs Bautagebuch).' });
  if (r.temp === '') o.push({ t: 'w', s: 0, m: 'Temperatur fehlt.' });
  r.aps.forEach((a, i) => {
    if (!a.nr) o.push({ t: 'e', s: 1, m: `Paket ${i + 1}: Arbeitspaket (AP-Nr.) muss ausgewählt oder eingetragen werden.` });
    if (!a.text) o.push({ t: 'e', s: 1, m: `Paket ${i + 1}: Beschreibung fehlt.` });
    const t = r.personal.reduce((x, p) => x + num(p.h[a.id]), 0); if (r.personal.length && !t) o.push({ t: 'w', s: 2, m: `AP ${esc(a.nr) || i + 1}: keine Personalstunden.` });
  });
  if (r.aps.length > 7) o.push({ t: 'e', s: 1, m: 'Maximal 7 Arbeitspakete pro Tagesbericht.' });
  if (!r.personal.length) o.push({ t: 'e', s: 2, m: 'Kein Personal eingetragen.' });
  if (r.personal.length > 14) o.push({ t: 'w', s: 2, m: 'Mehr als 14 Personen – Formular wird länger als eine Seite.' });
  r.personal.forEach(p => { if (p.zus) return; const s = sumH(p); if (!s) o.push({ t: 'e', s: 2, m: `${esc(p.name)}: keine Stunden und kein Kürzel.` }); else if (Math.abs(s - d) > 0.01) o.push({ t: 'w', s: 2, m: `${esc(p.name)}: ${fq(s)} h, Arbeitszeit ist ${fq(d)} h.` }) });
  r.geraete.forEach(g => { if (!sumH(g)) o.push({ t: 'w', s: 3, m: `${esc(g.name)}: keine Stunden.` }); if (/miet/i.test(g.name) && !g.firma) o.push({ t: 'w', s: 3, m: `${esc(g.name)}: Mietfirma fehlt.` }) });
  r.material.forEach(m => { if (!m.mat) o.push({ t: 'e', s: 4, m: 'Material ohne Bezeichnung.' }); if (!num(m.menge)) o.push({ t: 'e', s: 4, m: `${esc(m.mat || 'Material')}: Menge fehlt.` }); if (!m.ls) o.push({ t: 'w', s: 4, m: `${esc(m.mat || 'Material')}: Lieferschein-Nr. fehlt.` }); else if (!m.fotos.length) o.push({ t: 'w', s: 4, m: `Lieferschein ${esc(m.ls)}: kein Foto.` }) });
  const p = toMin(r.pause), netto = (toMin(r.ende) - toMin(r.beginn) - p) / 60;
  if (netto > 9 && p < 45) o.push({ t: 'w', s: 5, m: 'Über 9 h Arbeitszeit: mind. 45 Min. Pause (ArbZG).' }); else if (netto > 6 && p < 30) o.push({ t: 'w', s: 5, m: 'Über 6 h Arbeitszeit: mind. 30 Min. Pause (ArbZG).' });
  if (toMin(r.ende) <= toMin(r.beginn)) o.push({ t: 'e', s: 5, m: 'Ende liegt vor Beginn.' });
  if (!r.sig) o.push({ t: 'w', s: 5, m: 'Unterschrift fehlt.' });
  return o;
}

// ---------------------------------------------------------------- A4-Dokumente (Aufbau wie Papiervorlage)
const dauerTxt = r => fq(dauer(r)) + ' h';
const COLS_L = '<col style="width:34px"><col style="width:42px"><col style="width:42px"><col style="width:44px"><col style="width:26px"><col style="width:40px">';
const rot = (txt, w, h, cls = '') => `<div class="rot ${cls}" style="width:${w}px;height:${h}px">${txt}</div>`;
function kopfLinks(r, sep, title) {
  return [
    `<td colspan="6" rowspan="2" class="tt">${title}</td>`, null,
    `<td colspan="6" rowspan="3" class="lg"><img src="icons/logo-dark.png" alt="Schwall Bauunternehmung GmbH"></td>`, '', '',
    `<td colspan="6" class="sm">${FIRMA.adr} · ${FIRMA.tel}</td>`,
    `<td colspan="3" class="g">Datum:</td><td colspan="3" class="g">Tag:</td>`,
    `<td colspan="3" rowspan="2" class="bi c">${dShort(r.datum, sep)}</td><td colspan="3" rowspan="2" class="bi c">${wtag(r.datum)}</td>`, '',
    `<td colspan="6" class="g">Baustelle:</td>`,
    `<td colspan="6" class="bi">${esc(r.baustelle)}</td>`,
    `<td colspan="6" class="bi">${esc(r.bauteil)}</td>`,
    `<td colspan="3" class="g">Baustellen-Nr.:</td><td colspan="3" class="g">Wetter:</td>`,
    `<td colspan="3" rowspan="2" class="bi c">${esc(r.baunr)}</td><td colspan="3" class="bi c">${r.temp !== '' ? esc(r.temp) + ' °C' : ''}</td>`,
    `<td colspan="3" class="bi c">${esc(r.wetter)}</td>`];
}
function zeitRows(r, a, b, c) {
  return [`<td colspan="6" class="g">Arbeitszeit</td>${a}`,
    `<td class="g sm" style="padding:0 1px;font-size:8px">Beginn:</td><td class="g sm">Ende:</td><td class="g sm">Pausen:</td><td colspan="3" class="g">Dauer:</td>${b}`,
    `<td class="bi c">${r.beginn}</td><td class="bi c">${r.ende}</td><td class="bi c">${r.pause}</td><td colspan="3" class="bi c">${dauerTxt(r)}</td>${c}`];
}
function matLines(r) {
  const L = [], aps = r.aps, multi = new Set(r.material.map(m => m.ap)).size > 1; let la = null, ll = null, lm = null;
  r.material.slice().sort((x, y) => aps.findIndex(a => a.id === x.ap) - aps.findIndex(a => a.id === y.ap)).forEach(m => {
    if (multi && m.ap !== la) { const a = aps.find(a => a.id === m.ap); L.push({ t: 'AP ' + (a && a.nr || '?'), cls: 'g' }); la = m.ap; ll = lm = null }
    if (m.lief !== ll) { L.push({ t: '---' + m.lief + '---' }); ll = m.lief; lm = null }
    if (m.mat !== lm) { L.push({ t: m.mat + (m.einh ? ' [' + m.einh + ']' : '') }); lm = m.mat }
    L.push({ ls: m.ls, mg: fq(m.menge) + (m.einh ? ' ' + m.einh : '') });
  });
  r.geraete.filter(g => g.firma).forEach(g => L.push({ t: g.firma + ' (' + g.name.replace(/\s*\/\s*Miet/i, '') + ')' }));
  return L;
}
function sigFoot(r, bau) {
  return `<div class="foot"><div>Ausgestellt:<div class="sigline">${r.sig ? `<img src="${r.sig}">` : ''}</div><div style="font-size:9px">${esc(r.von)}</div></div>
 ${bau ? `<div>Anerkannt Bauleitung:<div class="sigline"></div></div>` : `<div style="padding-bottom:16px"><span class="box"></span>Lohn <span class="box"></span>Aufwand</div>`}</div>`;
}
function docTB(r) {
  const aps = r.aps.slice(0, 7); while (aps.length < 7) aps.push(null);
  const ML = matLines(r);
  const M = row => { const l = ML[row - 3]; if (!l) return '<td></td><td></td>'; if (l.ls !== undefined) return `<td class="bi">${esc(l.ls)}</td><td class="bi r">${esc(l.mg)}</td>`; return `<td colspan="2" class="bi ${l.cls || ''}">${esc(l.t)}</td>` };
  const K = kopfLinks(r, '/', 'Tagesbericht'); const rows = [];
  rows[1] = K[0] + `<td rowspan="12" class="g vl">${rot('Arbeitsbeschreibung', 224, 17, 'sm')}</td>` + aps.map(a => `<td rowspan="12" class="apcol">${rot(a ? esc(a.text) : '', 224, 44, 'vt')}</td>`).join('') + `<td colspan="2" class="g">Baustoff/Lieferant</td>`;
  rows[2] = `<td class="g">Lieferschein</td><td class="g r">Menge</td>`;
  for (let i = 3; i <= 12; i++) rows[i] = (K[i - 1] || '') + M(i);
  rows[13] = K[12] + `<td rowspan="3" class="g vl">${rot('AP', 56, 17, 'sm')}</td>` + aps.map(a => `<td rowspan="3" class="c bi" style="font-size:12px">${a ? esc(a.nr) : ''}</td>`).join('') + M(13);
  rows[14] = K[13] + M(14); rows[15] = K[14] + M(15);
  const apSum = a => r.personal.reduce((x, p) => x + (p.zus ? 0 : num(p.h[a.id])), 0);
  rows[16] = `<td colspan="4" class="g">Name</td><td class="g"></td><td class="g r">Std.</td><td></td>` + aps.map(a => `<td class="r">${a ? fq(apSum(a)) : ''}</td>`).join('') + M(16);
  const P = r.personal.slice(); while (P.length < 14) P.push(null);
  P.forEach((p, i) => { rows[17 + i] = `<td colspan="4" class="bi">${p ? esc(p.name) : ''}</td><td class="red c">${p && p.zus ? esc(p.zus) : ''}</td><td class="bi r">${p ? (p.zus ? '0,00' : fq(sumH(p))) : ''}</td><td></td>` + aps.map(a => `<td class="r">${p && a && !p.zus ? f2(p.h[a.id]) : ''}</td>`).join('') + M(17 + i) });
  const o = 17 + P.length;
  rows[o] = `<td class="g sm">Geräte</td><td colspan="4" class="g">Bezeichnung:</td><td class="g r">Std.</td><td></td>` + aps.map(() => '<td></td>').join('') + M(o);
  const G = r.geraete.slice(); while (G.length < 13) G.push(null);
  G.forEach((g, i) => { rows[o + 1 + i] = `<td>${g ? esc(g.ks) : ''}</td><td colspan="4" class="bi" style="font-size:9.5px">${g ? esc(g.name) : ''}</td><td class="bi r">${g ? fq(sumH(g)) : ''}</td><td></td>` + aps.map(a => `<td class="r">${g && a ? f2(g.h[a.id]) : ''}</td>`).join('') + M(o + 1 + i) });
  const e = o + 1 + G.length;
  const Z = zeitRows(r, `<td colspan="10" class="g">Bemerkungen / Abweichende Arbeitszeit:</td>`, `<td colspan="10" rowspan="2" class="bi wrap">${esc(r.bem)}</td>`, '');
  rows[e] = Z[0]; rows[e + 1] = Z[1]; rows[e + 2] = Z[2];
  return `<div class="a4"><table><colgroup>${COLS_L}<col style="width:18px">${'<col style="width:45px">'.repeat(7)}<col style="width:94px"><col style="width:49px"></colgroup>
  ${rows.filter(x => x !== undefined).map(x => `<tr>${x}</tr>`).join('')}</table>${sigFoot(r, false)}</div>`;
}
function docBTB(r) {
  const K = kopfLinks(r, '.', 'Bautagebuch');
  const arb = []; r.aps.forEach((a, i) => { if (!a.text) return; if (arb.length) arb.push(''); arb.push(...wrapLines(a.text, 82)) });
  const vork = wrapLines(r.vork, 82); const rows = [];
  rows[1] = K[0] + `<td class="g">Bauherr:</td>`;
  rows[2] = `<td rowspan="11" class="bh">${esc(r.bauherr)}</td>`;
  for (let i = 3; i <= 12; i++) rows[i] = K[i - 1] || '';
  rows[13] = K[12] + `<td class="g">(Grund)-Wasserstände:</td>`;
  rows[14] = K[13] + `<td rowspan="2" class="bi">${esc(r.wasser)}</td>`; rows[15] = K[14];
  rows[16] = `<td colspan="5" class="g">Name</td><td class="g r">Std.</td><td class="g">Art der geleisteten Arbeiten, einschl. Stundenlohnarbeiten, besondere</td>`;
  const P = r.personal.slice(); while (P.length < 14) P.push(null);
  const right = []; right[17] = `<td class="g">Arbeitsschichten und Leistungen des Auftraggebers:</td>`;
  const o = 17 + P.length, G = r.geraete.slice(); while (G.length < 13) G.push(null); const e = o + 1 + G.length;
  const vRow = Math.min(e - 2, Math.max(o + 3, 18 + arb.length + 1));
  for (let i = 18; i < vRow; i++) right[i] = `<td class="bi">${esc(arb[i - 18] || '')}</td>`;
  right[vRow] = `<td class="g">Wichtige Vorkommnisse, Besprechungen:</td>`;
  for (let i = vRow + 1; i < e; i++) right[i] = `<td class="bi">${esc(vork[i - vRow - 1] || '')}</td>`;
  P.forEach((p, i) => { rows[17 + i] = `<td colspan="5" class="bi">${p ? esc(p.name) : ''}</td><td class="bi r ${p && p.zus ? 'red' : ''}">${p ? (p.zus ? esc(p.zus) : fq(sumH(p))) : ''}</td>` + (right[17 + i] || '') });
  rows[o] = `<td class="g sm">Geräte</td><td colspan="4" class="g">Bezeichnung:</td><td class="g r">Std.</td>` + (right[o] || '');
  G.forEach((g, i) => { rows[o + 1 + i] = `<td class="bi">${g ? esc(g.ks) : ''}</td><td colspan="4" class="bi" style="font-size:9.5px">${g ? esc(g.name + (g.firma ? ' (' + g.firma + ')' : '')) : ''}</td><td class="bi r">${g ? f2(sumH(g)) : ''}</td>` + (right[o + 1 + i] || '') });
  const Z = zeitRows(r, '<td class="nob"></td>', '<td class="nob"></td>', '<td class="nob"></td>');
  rows[e] = Z[0]; rows[e + 1] = Z[1]; rows[e + 2] = Z[2];
  return `<div class="a4"><table><colgroup>${COLS_L}<col></colgroup>
  ${rows.filter(x => x !== undefined).map(x => `<tr>${x}</tr>`).join('')}</table>${sigFoot(r, true)}</div>`;
}
function fitA4() { document.querySelectorAll('.a4box').forEach(b => { const a = b.querySelector('.a4'); const s = b.clientWidth / 794; a.style.transform = `scale(${s})`; b.style.height = (a.offsetHeight * s) + 'px' }) }
window.addEventListener('resize', fitA4);

// ---------------------------------------------------------------- Unterschrift
function initSig() {
  const c = $('#sig'); if (!c) return; const dpr = window.devicePixelRatio || 1; c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr); x.lineWidth = 2.4; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#111';
  if (S.r.sig) { const im = new Image(); im.onload = () => x.drawImage(im, 0, 0, c.clientWidth, c.clientHeight); im.src = S.r.sig }
  let on = false; const pt = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top] };
  c.onpointerdown = e => { on = true; c.setPointerCapture(e.pointerId); const [a, b] = pt(e); x.beginPath(); x.moveTo(a, b) };
  c.onpointermove = e => { if (!on) return; const [a, b] = pt(e); x.lineTo(a, b); x.stroke() };
  c.onpointerup = c.onpointercancel = () => { if (!on) return; on = false; S.r.sig = c.toDataURL('image/png'); saveDraft(); const box = document.querySelector('.a4box'); if (box) { box.innerHTML = S.doc === 'tb' ? docTB(S.r) : docBTB(S.r); fitA4() } };
}

// ---------------------------------------------------------------- Auswahl mit Suche
function openPicker(kind, cb, selected = []) {
  let items, title, multi = false;
  if (kind === 'ma' || kind === 'polier') { title = kind === 'ma' ? 'Mitarbeiter' : 'Polier'; multi = kind === 'ma'; items = SD.ma.map(m => ({ v: m[0], sub: m[1], g: m[0][0].toUpperCase(), raw: m })) }
  if (kind === 'ge') { title = 'Geräte'; multi = true; items = SD.ge.map(g => ({ v: g[0], sub: g[2] ? 'KST ' + g[2] : '', g: g[3], raw: g })) }
  if (kind === 'mat') { title = 'Material'; items = SD.mat.map(m => ({ v: m[0], sub: (m[2] ? m[2] + ' · ' : '') + m[1], g: m[3], raw: m })) }
  if (kind === 'lief') { title = 'Lieferant'; items = SD.lief.map(l => ({ v: l, sub: '', g: '', raw: [l] })) }
  const sel = new Set(selected), el = document.createElement('div'); el.className = 'sheet';
  el.innerHTML = `<div class="in"><div class="top"><div class="prow"><b style="font-size:18px">${title} ${multi ? '<span class="hint">(mehrere möglich)</span>' : ''}</b><button class="btn small" data-close>${multi ? 'Fertig' : '✕'}</button></div><input type="search" placeholder="Suchen … Name, Teil davon oder Nummer" autocomplete="off"></div><div class="list"></div></div>`;
  document.body.appendChild(el);
  const inp = el.querySelector('input'), list = el.querySelector('.list');
  const draw = () => {
    const q = inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean); let h = '', lg = null, n = 0;
    for (const it of items) {
      const hay = (it.v + ' ' + it.sub).toLowerCase(); if (!q.every(t => hay.includes(t))) continue;
      if (it.g !== lg && it.g) { h += `<div class="grp">${esc(it.g)}</div>`; lg = it.g }
      let lab = esc(it.v); q.forEach(t => { lab = lab.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>') });
      h += `<div class="it ${sel.has(it.v) ? 'sel' : ''}" data-v="${esc(it.v)}"><span>${lab}</span><small>${esc(it.sub)}</small></div>`; n++;
      if (n > 300) break;
    }
    if (inp.value.trim() && (kind === 'lief' || kind === 'mat' || kind === 'ge')) h += `<div class="it" data-free="1"><span>„${esc(inp.value.trim())}“ als eigenen Eintrag übernehmen</span></div>`;
    else if (!n) h = '<div class="hint" style="padding:14px">Nichts gefunden.</div>';
    list.innerHTML = h;
  };
  draw(); inp.addEventListener('input', draw); setTimeout(() => inp.focus(), 50);
  const close = () => { el.remove(); saveDraft(); render() };
  el.addEventListener('click', e => {
    if (e.target === el || e.target.closest('[data-close]')) { close(); return }
    const it = e.target.closest('.it'); if (!it) return;
    if (it.dataset.free) { cb([inp.value.trim(), '', '', ''], true); if (multi) { inp.value = ''; draw() } else close(); return }
    const obj = items.find(x => x.v === it.dataset.v);
    if (multi) { if (sel.has(obj.v)) { sel.delete(obj.v); cb(obj.raw, false) } else { sel.add(obj.v); cb(obj.raw, true) } draw() } else { cb(obj.raw, true); close() }
  });
}

// ---------------------------------------------------------------- Daten für Büro (JSON + CSV)
function berichtDaten(r) {
  const apNr = id => (r.aps.find(a => a.id === id) || {}).nr || '';
  const perAp = h => Object.entries(h || {}).filter(([, v]) => num(v)).map(([k, v]) => ({ ap: apNr(k), std: num(v) }));
  const lohn = [];
  r.personal.forEach(p => { if (p.zus) lohn.push({ datum: r.datum, persnr: p.nr, name: p.name, ap: '', std: 0, kuerzel: p.zus, baustelle_nr: r.baunr }); else perAp(p.h).forEach(x => lohn.push({ datum: r.datum, persnr: p.nr, name: p.name, ap: x.ap, std: x.std, kuerzel: '', baustelle_nr: r.baunr })) });
  return {
    format: 'schwall-tagesbericht', version: 1, app_version: APP_VERSION, id: r.id, erstellt: new Date().toISOString(),
    datum: r.datum, wochentag: wtag(r.datum), polier: r.von,
    baustelle_nr: r.baunr, baustelle: r.baustelle, bauteil: r.bauteil, bauherr: r.bauherr,
    wetter: r.wetter, temperatur: r.temp === '' ? null : num(r.temp), wasserstand: r.wasser,
    beginn: r.beginn, ende: r.ende, pause_std: toMin(r.pause) / 60, dauer_std: dauer(r),
    bemerkungen: r.bem, vorkommnisse: r.vork,
    arbeitspakete: r.aps.map(a => ({ ap: a.nr, beschreibung: a.text })),
    arbeitspakete_text: r.aps.map(a => `AP ${a.nr}: ${a.text}`).join('\n'),
    personal: r.personal.map(p => ({ name: p.name, persnr: p.nr, kuerzel: p.zus || '', stunden_gesamt: p.zus ? 0 : sumH(p), stunden: p.zus ? [] : perAp(p.h) })),
    geraete: r.geraete.map(g => ({ bezeichnung: g.name, artikel: g.nr, kostenstelle: g.ks, mietfirma: g.firma || '', stunden_gesamt: sumH(g), stunden: perAp(g.h) })),
    material: r.material.map(m => ({ ap: apNr(m.ap), lieferant: m.lief, material: m.mat, materialnr: m.matnr, einheit: m.einh, lieferschein: m.ls, menge: num(m.menge), fotos: m.fotos.length })),
    lohnzeilen: lohn
  };
}
function lohnCsv(d) {
  const q = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s };
  const L = ['Datum;Baustellen-Nr.;Pers.-Nr.;Name;AP;Stunden;Kürzel'];
  d.lohnzeilen.forEach(z => L.push([dateDe(z.datum), z.baustelle_nr, z.persnr, z.name, z.ap, z.std ? fq(z.std) : '', z.kuerzel].map(q).join(';')));
  d.geraete.forEach(g => g.stunden.forEach(s => L.push([dateDe(d.datum), d.baustelle_nr, 'KST ' + g.kostenstelle, g.bezeichnung + (g.mietfirma ? ' (' + g.mietfirma + ')' : ''), s.ap, fq(s.std), 'Gerät'].map(q).join(';'))));
  return '﻿' + L.join('\r\n');
}

// ---------------------------------------------------------------- PDF-Erzeugung auf dem Handy
async function seitenBild(html) {
  const off = $('#offscreen'); off.innerHTML = html;
  const el = off.querySelector('.a4');
  await Promise.all([...el.querySelectorAll('img')].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r })));
  const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, width: 794, height: 1123, windowWidth: 794 });
  off.innerHTML = '';
  return canvas.toDataURL('image/jpeg', 0.9);
}
async function pdfErzeugen(r, art) {
  const { jsPDF } = window.jspdf; const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  pdf.setProperties({ title: `${art === 'tb' ? 'Tagesbericht' : 'Bautagebuch'} ${r.baunr} ${dateDe(r.datum)}`, author: r.von, creator: 'Schwall Tagesbericht-App ' + APP_VERSION });
  pdf.addImage(await seitenBild(art === 'tb' ? docTB(r) : docBTB(r)), 'JPEG', 0, 0, 210, 297);
  if (art === 'tb') {   // Anlage: Lieferschein-Fotos, 2 pro Seite
    const fotos = r.material.flatMap(m => m.fotos.map(f => [m, f]));
    for (let i = 0; i < fotos.length; i++) {
      if (i % 2 === 0) { pdf.addPage(); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.text('Anlage Lieferscheine', 12, 16); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.text(`Baustelle ${r.baunr} ${r.baustelle} · ${dateDe(r.datum)} · ${r.von}`, 12, 22); pdf.setDrawColor(237, 113, 7); pdf.setLineWidth(0.6); pdf.line(12, 25, 198, 25) }
      const [m, f] = fotos[i]; const p = pdf.getImageProperties(f); const maxW = 186, maxH = 122; let w = maxW, h = p.height * w / p.width; if (h > maxH) { h = maxH; w = p.width * h / p.height }
      const y0 = i % 2 === 0 ? 30 : 160; pdf.addImage(f, 'JPEG', 12 + (maxW - w) / 2, y0, w, h);
      pdf.setFontSize(9); pdf.text(`${m.lief} · ${m.mat} · Lieferschein ${m.ls} · ${fq(m.menge)} ${m.einh}`, 12, y0 + h + 5);
    }
  }
  return pdf.output('blob');
}
async function dateienErzeugen(r) {
  const base = `${r.baunr || 'ohneNr'}-%-${yymmdd(r.datum)}`, d = berichtDaten(r);
  return [
    new File([await pdfErzeugen(r, 'tb')], base.replace('%', 'TB') + '.pdf', { type: 'application/pdf' }),
    new File([await pdfErzeugen(r, 'btb')], base.replace('%', 'BTB') + '.pdf', { type: 'application/pdf' }),
    new File([lohnCsv(d)], base.replace('%', 'LOHN') + '.csv', { type: 'text/csv' }),
    new File([JSON.stringify(d, null, 1)], base.replace('%', 'DATEN') + '.txt', { type: 'text/plain' })
  ];
}
const betreff = r => `Tagesbericht ${r.baunr} ${dateDe(r.datum)} – ${r.von}`;
const mailText = r => `Tagesbericht und Bautagebuch\nBaustelle: ${r.baunr} ${r.baustelle}\nDatum: ${wtag(r.datum)}, ${dateDe(r.datum)}\nPolier: ${r.von}\nPersonal: ${r.personal.length} · Geräte: ${r.geraete.length} · Lieferscheine: ${r.material.length}\n\n(automatisch erstellt mit der Schwall Tagesbericht-App)`;

// ---------------------------------------------------------------- Versand
function overlay(html) { let o = $('#ov'); if (!o) { o = document.createElement('div'); o.id = 'ov'; o.className = 'overlay'; document.body.appendChild(o) } o.innerHTML = `<div class="box2">${html}</div>`; return o }
function closeOverlay() { const o = $('#ov'); if (o) o.remove() }
async function prepare(r) {
  overlay(`<div class="spin"></div><b>PDFs werden erstellt …</b><p class="small">Das dauert ein paar Sekunden.</p>`);
  try {
    const files = await dateienErzeugen(r); S.prepared = { r, files };
    if (SET.uploadUrl) return uploadSenden();
    zeigeVersand();
  } catch (e) { console.error(e); overlay(`<b>Fehler beim Erstellen</b><p class="small">${esc(e.message || e)}</p><button class="btn full" data-act="ovclose">Schließen</button>`) }
}
function zeigeVersand(hinweis = '') {
  const { r, files } = S.prepared, kann = !!(navigator.canShare && navigator.canShare({ files }));
  overlay(`<b style="font-size:18px">Bericht ist fertig ✓</b>${hinweis}
  <div class="files">${files.map(f => `<div>📄 ${esc(f.name)} <span class="small">(${Math.ceil(f.size / 1024)} KB)</span></div>`).join('')}</div>
  ${kann ? `<p class="small">Tippe auf <b>Senden</b>, wähle <b>Outlook</b> oder <b>Mail</b> und schicke die Nachricht an:<br><b>${esc(SET.email || 'Büro-Adresse')}</b></p>
    <button class="btn orange full big" data-act="share">📤 Senden</button>`
    : `<p class="small">Dieses Gerät kann Dateien nicht direkt teilen. Die Dateien werden heruntergeladen – bitte an <b>${esc(SET.email)}</b> anhängen.</p><button class="btn orange full big" data-act="download">⬇ Dateien speichern & E-Mail öffnen</button>`}
  <button class="btn ghost full" style="margin-top:8px" data-act="ovclose">Abbrechen</button>`);
}
async function share() {
  const { r, files } = S.prepared;
  try { await navigator.share({ files, title: betreff(r), text: mailText(r) }); await abgeschlossen('mail') }
  catch (e) { if (e.name === 'AbortError') return; toast('Teilen nicht möglich: ' + e.message); }
}
function download() {
  const { r, files } = S.prepared;
  files.forEach((f, i) => setTimeout(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove() }, i * 400));
  setTimeout(() => { location.href = `mailto:${encodeURIComponent(SET.email)}?subject=${encodeURIComponent(betreff(r))}&body=${encodeURIComponent(mailText(r) + '\n\nBitte die heruntergeladenen Dateien anhängen.')}` }, files.length * 400 + 300);
  abgeschlossen('mail');
}
const b64 = f => new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(',')[1]); rd.onerror = rej; rd.readAsDataURL(f) });
async function uploadPayload(r, files) { return JSON.stringify({ betreff: betreff(r), daten: berichtDaten(r), dateien: await Promise.all(files.map(async f => ({ name: f.name, typ: f.type, inhalt_base64: await b64(f) }))) }) }
async function uploadSenden() {
  const { r, files } = S.prepared;
  overlay(`<div class="spin"></div><b>Wird übertragen …</b>`);
  const body = await uploadPayload(r, files);
  try {
    if (!navigator.onLine) throw new Error('offline');
    await fetch(SET.uploadUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body });
    await abgeschlossen('upload');
  } catch (e) {
    QUEUE.push({ id: r.id, body, r: kurz(r) }); await DB.set('queue', QUEUE); await abgeschlossen('upload', true);
  }
}
async function sendQueue(silent) {
  if (!SET.uploadUrl || !QUEUE.length || !navigator.onLine) return;
  const rest = [];
  for (const q of QUEUE) { try { await fetch(SET.uploadUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: q.body }) } catch (e) { rest.push(q) } }
  const n = QUEUE.length - rest.length; QUEUE = rest; await DB.set('queue', QUEUE);
  if (n) { toast(`${n} wartende(r) Bericht(e) übertragen ✓`); if (S.view === 'home') render() }
}
const kurz = r => ({ id: r.id, datum: r.datum, baunr: r.baunr, baustelle: r.baustelle, aps: r.aps.map(a => ({ nr: a.nr, text: a.text })) });
async function abgeschlossen(weg, wartet) {
  const r = S.prepared.r;
  // Verlauf: kompletter Bericht (für „erneut senden“ und „wie letzter Bericht“), max. 30
  HIST = HIST.filter(h => h.id !== r.id); HIST.unshift(Object.assign(clone(r), { weg, gesendet: Date.now() })); HIST = HIST.slice(0, 30);
  await DB.set('history', HIST); await DB.del('draft'); S.r = null; S.prepared = null;
  overlay(`<div style="font-size:44px">✅</div><b style="font-size:18px">${wartet ? 'Gespeichert – wird gesendet, sobald Netz da ist' : weg === 'upload' ? 'Übertragen' : 'Versand geöffnet'}</b>
  <p class="small">${weg === 'mail' && !wartet ? 'Bitte prüfen, dass die E-Mail in deinem Mail-Programm wirklich abgeschickt wurde.' : ''}</p><button class="btn orange full" data-act="ovhome">Zur Startseite</button>`);
}

// ---------------------------------------------------------------- Ereignisse
document.addEventListener('click', async e => {
  const t = e.target.closest('button,[data-go],[data-delfoto]'); if (!t) return; const ds = t.dataset; const r = S.r;
  if (ds.view) { S.view = ds.view; render(); scrollTo(0, 0); return }
  if (ds.step) { S.step = +ds.step; render(); scrollTo(0, 0); return }
  if (ds.go) { e.preventDefault(); S.step = +ds.go; render(); scrollTo(0, 0); return }
  if (ds.doc) { S.doc = ds.doc; render(); return }
  if (ds.pause) { r.pause = ds.pause; saveDraft(); render(); return }
  if (ds.wetter) { r.wetter = r.wetter === ds.wetter ? '' : ds.wetter; saveDraft(); render(); return }
  if (ds.delap) { r.aps = r.aps.filter(a => a.id !== ds.delap); saveDraft(); render(); return }
  if (ds.del) { const [k, id] = ds.del.split('|'); r[k] = r[k].filter(x => x.id !== id); saveDraft(); render(); return }
  if (ds.delfoto) { const [id, i] = ds.delfoto.split('|'); const m = r.material.find(x => x.id === id); m.fotos.splice(+i, 1); saveDraft(); render(); return }
  if (ds.zus) { const [id, z] = ds.zus.split('|'); const p = r.personal.find(x => x.id === id); p.zus = p.zus === z ? '' : z; saveDraft(); render(); return }
  if (ds.st) { const [k, id, ap, dv] = ds.st.split('|'); const it = r[k].find(x => x.id === id); it.h[ap] = Math.max(0, num(it.h[ap]) + num(dv)); saveDraft(); render(); return }
  if (ds.resend) { const h = HIST.find(x => x.id === ds.resend); if (h) prepare(clone(h)); return }
  if (ds.pick) {
    const [k, id] = ds.pick.split('|');
    if (k === 'von') openPicker('polier', m => { r.von = m[0] });
    if (k === 'lief') openPicker('lief', l => { r.material.find(x => x.id === id).lief = l[0] });
    if (k === 'mat') openPicker('mat', m => { const x = r.material.find(x => x.id === id); x.mat = m[0]; x.matnr = m[1] || ''; x.einh = m[2] || ''; if (!x.lief && ['MKB', 'BSR'].includes(m[3])) x.lief = m[3] });
    return;
  }
  const a = ds.act; if (!a) return;
  if (a === 'install' && installEvt) { installEvt.prompt(); installEvt = null }
  if (a === 'neu') { S.r = neuerBericht(); S.step = 0; S.view = 'erfassung'; saveDraft(); render(); scrollTo(0, 0) }
  if (a === 'weiter') { S.view = 'erfassung'; render() }
  if (a === 'verwerfen') { if (await bestaetigen('Entwurf wirklich löschen?')) { S.r = null; await DB.del('draft'); render() } }
  if (a === 'vorlage') { const h = clone(HIST[0]); const n = neuerBericht(); Object.assign(n, { baunr: h.baunr, baustelle: h.baustelle, bauteil: h.bauteil, bauherr: h.bauherr, beginn: h.beginn, ende: h.ende, pause: h.pause, aps: h.aps, personal: h.personal.map(p => Object.assign(p, { h: {}, zus: '' })), geraete: h.geraete.map(g => Object.assign(g, { h: {} })) }); S.r = n; S.step = 0; S.view = 'erfassung'; saveDraft(); render(); toast('Baustelle, Pakete, Kolonne und Geräte übernommen – Stunden bitte neu eintragen') }
  if (a === 'next') { S.step = Math.min(5, S.step + 1); render(); scrollTo(0, 0) }
  if (a === 'prev') { S.step = Math.max(0, S.step - 1); render(); scrollTo(0, 0) }
  if (a === 'addap') { r.aps.push({ id: uid(), nr: '', text: '' }); saveDraft(); render() }
  if (a === 'addma') openPicker('ma', (m, add) => { if (add) r.personal.push({ id: uid(), name: m[0], nr: m[1], zus: '', h: {} }); else r.personal = r.personal.filter(p => p.name !== m[0]) }, r.personal.map(p => p.name));
  if (a === 'addge') openPicker('ge', (g, add) => { if (add) r.geraete.push({ id: uid(), name: g[0], nr: g[1], ks: g[2], firma: '', h: {} }); else r.geraete = r.geraete.filter(x => x.name !== g[0]) }, r.geraete.map(g => g.name));
  if (a === 'addmat') { r.material.push({ id: uid(), ap: r.aps[0].id, lief: '', mat: '', matnr: '', einh: '', ls: '', menge: '', fotos: [] }); saveDraft(); render() }
  if (a === 'dupmat') { const l = r.material[r.material.length - 1]; r.material.push({ id: uid(), ap: l.ap, lief: l.lief, mat: l.mat, matnr: l.matnr, einh: l.einh, ls: '', menge: '', fotos: [] }); saveDraft(); render(); setTimeout(() => { const i = document.querySelectorAll('[data-k=ls]'); i[i.length - 1].focus() }, 50) }
  if (a === 'kolonne') {
    const h = HIST[0]; if (!h) { toast('Noch kein früherer Bericht vorhanden'); return }
    h.personal.forEach(p => { if (!r.personal.some(x => x.name === p.name)) r.personal.push({ id: uid(), name: p.name, nr: p.nr, zus: '', h: {} }) });
    h.geraete.forEach(g => { if (!r.geraete.some(x => x.name === g.name)) r.geraete.push({ id: uid(), name: g.name, nr: g.nr, ks: g.ks, firma: g.firma || '', h: {} }) });
    saveDraft(); toast(`${h.personal.length} Mitarbeiter und ${h.geraete.length} Geräte übernommen`); render();
  }
  if (a === 'copyh') { const f = r.personal.find(p => !p.zus); if (!f) return; r.personal.forEach(p => { if (!p.zus) p.h = { ...f.h } }); saveDraft(); toast('Stunden von ' + f.name + ' für alle übernommen'); render() }
  if (a === 'sigclear') { r.sig = ''; saveDraft(); render() }
  if (a === 'prepare') {
    const err = pruefe(r).filter(x => x.t === 'e'); if (err.length) { toast(`Noch ${err.length} Fehler – bitte korrigieren`); return }
    if (!SET.email && !SET.uploadUrl) { toast('Bitte zuerst in den Einstellungen die E-Mail des Büros eintragen'); return }
    const w = pruefe(r).filter(x => x.t === 'w'); if (w.length && !(await bestaetigen(`${w.length} Hinweis(e) offen (z. B. ${w[0].m}). Trotzdem senden?`))) return;
    prepare(r);
  }
  if (a === 'share') share();
  if (a === 'download') download();
  if (a === 'ovclose') closeOverlay();
  if (a === 'ovhome') { closeOverlay(); S.view = 'home'; render(); scrollTo(0, 0) }
  if (a === 'sendqueue') sendQueue();
  if (a === 'setupdone' || a === 'savesettings') {
    SET.polier = $('#s_polier').value.trim(); SET.email = $('#s_email').value.trim(); if ($('#s_url')) SET.uploadUrl = $('#s_url').value.trim();
    if (!SD) { toast('Bitte zuerst die Stammdaten (Excel) laden'); return }
    if (!SET.email && !SET.uploadUrl) { toast('Bitte E-Mail-Adresse des Büros eintragen'); return }
    await DB.set('settings', SET); toast('Gespeichert ✓'); S.view = 'home'; render();
  }
  if (a === 'reset') { if (await bestaetigen('Wirklich alle Daten auf diesem Handy löschen (Entwurf, Verlauf, Stammdaten, Einstellungen)?')) { for (const k of ['draft', 'history', 'queue', 'stammdaten', 'settings']) await DB.del(k); location.reload() } }
});
function bestaetigen(text) { return new Promise(res => { const o = overlay(`<p style="font-size:16px">${esc(text)}</p><div class="row"><button class="btn ghost" id="cn">Nein</button><button class="btn orange" id="cy">Ja</button></div>`); o.querySelector('#cn').onclick = () => { closeOverlay(); res(false) }; o.querySelector('#cy').onclick = () => { closeOverlay(); res(true) } }) }

document.addEventListener('input', e => {
  const t = e.target, ds = t.dataset, r = S.r; if (!r) return;
  if (ds.f) {
    r[ds.f] = t.value;
    if (ds.f === 'baunr') { const h = HIST.find(x => x.baunr === t.value.trim()); if (h && !r.baustelle) { r.baustelle = h.baustelle; r.bauteil = h.bauteil; r.bauherr = h.bauherr; ['baustelle', 'bauteil', 'bauherr'].forEach(k => { const i = document.querySelector(`[data-f=${k}]`); if (i) i.value = r[k] }); toast('Baustellendaten vom letzten Bericht übernommen') } }
  }
  if (ds.ap) r.aps.find(a => a.id === ds.ap)[ds.k] = t.value;
  if (ds.m) { const m = r.material.find(x => x.id === ds.m); m[ds.k] = ds.k === 'menge' ? t.value.replace(',', '.') : t.value }
  if (ds.hin) { const [k, id, ap] = ds.hin.split('|'); r[k].find(x => x.id === id).h[ap] = num(t.value) }
  if (ds.g) r.geraete.find(x => x.id === ds.g).firma = t.value;
  saveDraft();
});
document.addEventListener('change', async e => {
  const t = e.target, ds = t.dataset;
  if (t.id === 's_file' && t.files[0]) {
    const info = $('#s_info'); info.textContent = 'Wird gelesen …';
    try { SD = await importStammdaten(t.files[0]); await DB.set('stammdaten', SD); info.innerHTML = `<span class="ok">✓ ${SD.ma.length} Mitarbeiter, ${SD.ge.length} Geräte, ${SD.mat.length} Materialien geladen</span>` }
    catch (err) { info.innerHTML = `<span style="color:var(--rot)">${esc(err.message)}</span>` }
    return;
  }
  if (!S.r) return;
  if (ds.f && ['datum', 'beginn', 'ende'].includes(ds.f)) render();
  if (ds.k === 'ap' && ds.m) render();
  if (ds.hin) render();
  if (ds.foto && t.files[0]) {
    const m = S.r.material.find(x => x.id === ds.foto), f = t.files[0];
    try {
      const bmp = await createImageBitmap(f); const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      m.fotos.push(c.toDataURL('image/jpeg', 0.72)); saveDraft(); render();
    } catch (err) { toast('Foto konnte nicht gelesen werden') }
  }
});

// Entwurf beim Start laden
DB.get('draft').then(d => { if (d) S.r = d }).catch(() => { }).finally(init);
