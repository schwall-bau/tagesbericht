'use strict';
/* Schwall Tagesbericht – Polier-App (PWA)
   Läuft komplett im Browser des Handys, auch offline.
   Erzeugt Tagesbericht- und Bautagebuch-PDF + Daten (JSON) + Lohn-CSV
   und versendet sie per E-Mail (Teilen-Menü) oder optional direkt an Power Automate. */
const APP_VERSION = '1.16.1';
const FIRMA = { name: 'Schwall', zusatz: 'Bauunternehmung GmbH', adr: 'Neue Welt 50 · 88471 Laupheim', tel: 'Tel. (073 92) 9703-0' };

// ---------------------------------------------------------------- Speicher (IndexedDB)
const DB = {
  db: null,
  open() { return this.db ? Promise.resolve(this.db) : new Promise((res, rej) => { const r = indexedDB.open('schwall-tb', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { this.db = r.result; res(this.db) }; r.onerror = () => rej(r.error) }) },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) }) },
  async set(k, v) { if (LADEFEHLER && ['history', 'slhistory', 'queue', 'lsliste'].includes(k)) throw new Error('Gespeicherte Daten konnten beim Start nicht gelesen werden – bitte App neu öffnen.'); const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Speichern abgebrochen (Speicher voll?)')) }) },
  async del(k) { const db = await this.open(); return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = t.onabort = () => res() }) }
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
const S = { view: 'home', step: 0, r: null, doc: 'tb', prepared: null, sl: null, tb: null };   // r = gerade bearbeiteter Bericht (Tagesbericht oder Stundenlohn); tb/sl = geparkte Entwürfe
let SLHIST = [];          // gesendete Stundenlohnberichte
let BERUF = {};
let FAV = {}, HAEUFIG = {};   // Favoriten und Zähler „häufig gewählt“ je Liste (Mitarbeiter, Geräte, Material, Lieferant)           // zuletzt gewählter Beruf je Mitarbeiter (Stundenlohn)
let saveTimer = null, NOFLUSH = false, LADEFEHLER = false;
const hatInhalt = r => !!r && !!(r.baunr || r.baustelle || r.personal.length || r.geraete.length || r.material.length || r.aps.some(a => a.nr || a.text) || r.bem || r.vork);
const draftKey = r => r && r.typ === 'sl' ? 'draft_sl' : 'draft';
function saveDraft() { clearTimeout(saveTimer); if (S.r) S.r._t = Date.now(); saveTimer = setTimeout(() => { if (S.r && !NOFLUSH) DB.set(draftKey(S.r), S.r) }, 400) }
const flushDraft = () => { clearTimeout(saveTimer); if (S.r && !NOFLUSH) DB.set(draftKey(S.r), S.r); if (window.__lst) { clearTimeout(window.__lst); window.__lst = null; lsSpeichern() } };
// Neu laden ohne den Entwurf im Speicher zurückzuschreiben (nach Datenimport / Löschen)
const neuLadenOhneSichern = () => { NOFLUSH = true; clearTimeout(saveTimer); S.r = S.tb = S.sl = null; location.reload() };
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDraft() });
window.addEventListener('pagehide', flushDraft);

function neuerBericht() {
  return { id: uid(), datum: today(), von: SET.polier || '', baustelle: '', bauteil: '', baunr: '', bauherr: '', wetter: '', temp: '', wasser: '',
    beginn: '07:00', ende: '17:00', pause: '0:45', aps: [{ id: uid(), nr: '', text: '' }], personal: [], geraete: [], material: [], bem: '', vork: '', sig: '' };
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
    SD = sdErgaenzen(await DB.get('stammdaten')); SET = Object.assign(SET, await DB.get('settings') || {});
    LSL = (await DB.get('lsliste') || []).filter(e => !(e.uebernommen && Date.now() - e.zeit > 90 * 864e5)); LSL.forEach(e => { if (e.uebernommen && Date.now() - e.zeit > 30 * 864e5) e.fotos = [] });
    FAV = await DB.get('favoriten') || {}; HAEUFIG = await DB.get('haeufig') || {}; SLHIST = await DB.get('slhistory') || []; BERUF = await DB.get('berufe') || {}; S.sl = await DB.get('draft_sl') || null;
    HIST = await DB.get('history') || []; QUEUE = await DB.get('queue') || []; LERN = Object.assign({ alias: {}, lief: {} }, await DB.get('lernen') || {});
    if (!SD) { try { const r = await fetch('stammdaten.json', { cache: 'no-store' }); if (r.ok) { SD = sdErgaenzen(await r.json()); await DB.set('stammdaten', SD) } } catch (e) { } }
  } catch (e) { console.error(e); LADEFEHLER = true; setTimeout(() => toast('⚠️ Gespeicherte Daten konnten nicht gelesen werden. Bitte App schließen und neu öffnen, bevor du sendest.', 8000), 500) }
  S.view = SD ? 'home' : 'setup';
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hatteSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => { reg.update(); setInterval(() => reg.update(), 30 * 60000) }).catch(() => { });
    // neue Version aktiv → einmal neu laden (Entwurf ist gespeichert)
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hatteSW || window._reloaded) return; const neu = () => { window._reloaded = true; flushDraft(); location.reload() }; if (S.view === 'home' && !document.querySelector('.sheet')) neu(); else { window._updateWartet = neu; toast('Neue Version geladen – wird aktiv, sobald du zur Startseite gehst.', 4000) } });
  }
  window.addEventListener('online', () => { sendQueue(true); ocrVorladen() });
  if (SD) setTimeout(ocrVorladen, 3000);
  if (QUEUE.length && navigator.onLine) sendQueue(true);
}
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (S.view === 'home') render() });
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------- Rendering
const STEPS = [['Kopf', '📋'], ['Pakete', '🛣️'], ['Personal', '👷'], ['Geräte', '🚜'], ['Material', '🧾'], ['Abschluss', '✅']];
const STEPS_SL = [['Kopf', '📋'], ['Arbeiten', '🛠️'], ['Personal', '👷'], ['Geräte', '🚜'], ['Material', '🧾'], ['Abschluss', '✅']];
function render() {
  if (window._updateWartet && S.view === 'home' && !document.querySelector('.sheet')) { const f = window._updateWartet; window._updateWartet = null; return f() }
  if (S.r && S.r.typ === 'sl' && !['sl', 'erfassung'].includes(S.view)) { S.sl = S.r; S.r = S.tb || null; S.tb = null; S.doc = 'tb' }   // Stundenlohn verlassen → Tagesbericht-Entwurf wieder aktiv
  const hb = $('#hbtn'); hb.style.display = 'none';
  $('#steps').style.display = 'none'; $('#foot').style.display = 'none'; $('#hsub').textContent = '';
  if (S.view === 'telefon') {
    $('#htitle').textContent = '📞 Tagesbericht per Gespräch'; $('#hsub').textContent = S.r ? (wtag(S.r.datum) + ', ' + dateDe(S.r.datum) + (S.r.baunr ? ' · ' + S.r.baunr : '')) : '';
    hb.style.display = ''; hb.textContent = 'Formular'; hb.onclick = () => telEnde(true);
    return telRender();
  }
  if (S.view === 'erfassung') {
    const r = S.r, res = pruefe(r);
    const sl = r.typ === 'sl';
    $('#htitle').textContent = sl ? '⏱️ Stundenlohnbericht' : 'Tagesbericht'; $('#hsub').textContent = (r.datum ? wtag(r.datum) + ', ' + dateDe(r.datum) : '') + (r.baunr ? ' · ' + r.baunr : '');
    hb.style.display = ''; hb.textContent = sl ? '‹ Zurück' : '‹ Start'; hb.onclick = () => { S.view = sl ? 'sl' : 'home'; render(); scrollTo(0, 0) };
    $('#steps').style.display = 'flex';
    $('#steps').innerHTML = (sl ? STEPS_SL : STEPS).map((s, i) => `<button class="${i === S.step ? 'on' : ''} ${i < S.step && !res.some(x => x.t === 'e' && x.s === i) ? 'done' : ''}" data-step="${i}"><b>${s[1]}</b>${s[0]}</button>`).join('');
    $('#main').innerHTML = (sl ? [vKopfSL, vAps, vPers, vGer, vMat, vAbschlussSL] : [vKopf, vAps, vPers, vGer, vMat, vAbschluss])[S.step]();
    $('#foot').style.display = 'flex';
    $('#foot').innerHTML = (S.step > 0 ? `<button class="btn ghost" data-act="prev">‹ Zurück</button>` : '') + (S.step < 5 ? `<button class="btn orange" data-act="next">Weiter ›</button>` : `<button class="btn orange" data-act="prepare">PDF erstellen & senden</button>`);
  } else {
    $('#htitle').textContent = { home: 'Tagesbericht', setup: 'Einrichtung', settings: 'Einstellungen', verlauf: 'Gesendete Berichte', lieferscheine: '🧾 Lieferschein-Liste', sl: '⏱️ Stundenlohnarbeiten' }[S.view] || 'Tagesbericht';
    if (S.view !== 'home' && S.view !== 'setup') { hb.style.display = ''; hb.textContent = '‹ Start'; hb.onclick = () => { S.view = 'home'; render() } }
    $('#main').innerHTML = ({ home: vHome, setup: vSetup, settings: vSettings, verlauf: vVerlauf, lieferscheine: vLieferscheine, sl: vSLStart })[S.view]();
  }
  fitA4(); initSig();
}

// ---------------------------------------------------------------- Startseite / Einrichtung / Einstellungen
function vHome() {
  const draft = S.r && S.r._draft !== false && hatInhalt(S.r) ? S.r : null;
  return `${!standalone() ? `<div class="demo"><b>Als App installieren:</b> ${isIOS() ? 'In Safari unten auf <b>Teilen</b> (□↑) tippen → <b>„Zum Home-Bildschirm“</b>.' : installEvt ? '<button class="btn small orange" data-act="install">Jetzt installieren</button>' : 'Im Chrome-Menü <b>⋮</b> → <b>„App installieren“</b> bzw. „Zum Startbildschirm hinzufügen“.'}</div>` : ''}
  ${QUEUE.length ? `<div class="demo" style="background:#fdecea;border-color:#f5c2c0;color:#8a1c1c"><b>${QUEUE.length} Bericht(e) warten auf Versand</b> (kein Netz). <button class="btn small" data-act="sendqueue">Jetzt senden</button></div>` : ''}
  <div class="home-hero">
    <h2 style="margin-top:0">Hallo${SET.polier ? ' ' + esc(SET.polier.split(',').reverse().join(' ').trim()) : ''}</h2>
    ${draft ? `<button class="btn orange full big" style="flex-direction:column" data-act="weiter">Entwurf fortsetzen<br><small style="font-weight:400">${wtag(draft.datum)}, ${dateDe(draft.datum)} ${esc(draft.baunr)} ${esc(draft.baustelle)}</small></button>
      <div class="row" style="margin-top:8px"><button class="btn ghost" data-act="neu">Neuer Bericht</button><button class="btn danger" data-act="verwerfen">Entwurf löschen</button></div>`
      : `<button class="btn orange full big" data-act="neu">＋ Neuer Tagesbericht</button>`}
    <button class="btn full big" style="margin-top:8px;background:#2b2b2b;flex-direction:column" data-act="telefon">📞 Bericht per Gespräch<br><small style="font-weight:400">Die App fragt, du antwortest mit Sprache</small></button>
    ${HIST.length ? `<button class="btn ghost full" style="margin-top:8px" data-act="vorlage">↺ Wie letzter Bericht (${esc(HIST[0].baunr)} ${dateDe(HIST[0].datum)})</button>` : ''}
    ${HIST.length > 1 ? `<button class="btn ghost full" style="margin-top:8px;border-style:dashed" data-act="vorlagewahl">📚 Älteren Bericht als Vorlage wählen …</button>` : ''}
    ${(() => { const h = LSL.filter(e => e.datum === today()), sl = S.sl && (S.sl.baustelle || S.sl.personal.length); return `<div class="grid2" style="margin-top:8px"><button class="btn ghost" style="flex-direction:column" data-act="lsliste">🧾 Lieferscheine<small style="font-weight:400">${h.length ? 'heute ' + h.length + ' LS · ' + matSummen(h) : 'Liste, Tonnage'}</small></button><button class="btn ghost" style="flex-direction:column" data-act="slstart">⏱️ Stundenlohn<small style="font-weight:400">${sl ? 'Entwurf ' + esc(S.sl.baunr || '') + ' offen' : 'Berichte, Regie'}</small></button></div>` })()}
  </div>
  <div class="card"><div class="prow"><b>Gesendete Berichte</b><button class="btn small ghost" data-view="verlauf">Alle</button></div>
   <div class="lst">${HIST.slice(0, 5).map(histItem).join('') || '<div class="hint">Noch keine.</div>'}</div></div>
  <div class="card"><div class="prow"><div><b>Einstellungen</b><div class="small">Empfänger: ${esc(SET.email) || '<span style="color:var(--rot)">nicht festgelegt</span>'}<br>Stammdaten: ${SD ? SD.ma.length + ' Mitarbeiter, ' + SD.ge.length + ' Geräte · Stand ' + dateDe(SD.stand) : '–'}</div></div><button class="btn small ghost" data-view="settings">Ändern</button></div>
   <button class="btn ghost small full" style="margin-top:8px" data-act="sync">🔄 Daten übertragen (PC ⇄ Handy)</button>
   <button class="btn ghost small full" style="margin-top:8px" data-act="update">⬆️ Nach Update suchen (Version ${APP_VERSION})</button></div>
  <p class="small" style="text-align:center">Version ${APP_VERSION}</p>`;
}
function histItem(h) { return `<div class="it"><div><b>${wtag(h.datum)}, ${dateDe(h.datum)}</b> · ${esc(h.baunr)}<br><span class="small">${esc(h.baustelle)} · ${h.weg === 'upload' ? 'direkt übertragen' : 'per E-Mail geteilt'} ${h.gesendet ? new Date(h.gesendet).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span></div><div style="display:flex;gap:6px;flex:none"><button class="btn small ghost" data-vorlage="${h.id}">Vorlage</button><button class="btn small ghost" data-resend="${h.id}">Erneut</button></div></div>` }
function vVerlauf() { return `<div class="card"><div class="lst">${HIST.map(histItem).join('') || '<div class="hint">Noch keine Berichte gesendet.</div>'}</div></div><p class="small">„Vorlage“ startet einen neuen Bericht mit Baustelle, Paketen, Kolonne und Geräten dieses Berichts. „Erneut“ erzeugt die PDFs neu und öffnet den Versand noch einmal. Gespeichert werden die letzten 30 Berichte auf diesem Handy.</p>` }
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
  <div class="card"><b>Gelernte Lieferscheine</b><div class="hint">${Object.keys(LERN.lief).length} Lieferanten, ${Object.keys(LERN.alias).length} Briefköpfe zugeordnet. Die App lernt aus jedem gesendeten Bericht: welcher Briefkopf zu welchem Lieferanten gehört und welches Material dort meist geliefert wird.</div><button class="btn small ghost" data-act="lernreset">Gelerntes zurücksetzen</button></div>
  <div class="card"><b>Senden testen (Android)</b><p class="hint">Falls beim Senden „Permission denied“ kommt: jeden Knopf einmal antippen und das Teilen-Fenster wieder schließen. Das Ergebnis bitte ans Büro schicken.</p>
  <div class="grid3"><button class="btn small ghost" data-tst="text">Nur Text</button><button class="btn small ghost" data-tst="pdf">1 PDF</button><button class="btn small ghost" data-tst="txt">1 TXT</button></div><div id="tstout" class="hint" style="white-space:pre-wrap"></div></div>
  <div class="card"><b>Daten auf diesem Handy</b><p class="hint">Entwurf, Verlauf und Stammdaten liegen nur auf diesem Gerät.</p><button class="btn danger full" data-act="reset">Alles auf diesem Handy löschen</button></div>`;
}

// ---------------------------------------------------------------- Erfassung (wie Prototyp)
function vKopf() {
  const r = S.r; const bs = [...new Map(HIST.filter(h => h.baunr).map(h => [h.baunr, h])).values()];
  return `<h2>Baustelle & Tag</h2>
<div class="card">
 <label style="margin-top:0">Ausgestellt von (Polier)</label>${pickBtn('von', r.von || 'Polier auswählen …')}
 <div class="grid2"><div><label>Datum</label><input type="date" data-f="datum" value="${r.datum}"></div><div><label>Tag</label><input value="${wtag(r.datum)}" disabled></div></div>
 <label>Baustellen-Nr.</label>${bnrFeld(`data-f="baunr" list="bslist"`, r.baunr, 'z. B. 26025')}
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
  const r = S.r, sl = r.typ === 'sl'; return `${sl ? `<h2>Ausgeführte Arbeiten</h2>
<p class="hint">Was wurde im Stundenlohn gemacht? Steht später unter „Kennzeichnung der Arbeit“. AP-Nr. nur, wenn es eine gibt.</p>` : `<h2>Arbeitspakete</h2>
<p class="hint">Jede Tätigkeit als eigenes Arbeitspaket (max. 7). Die AP-Nr. ist Pflicht.</p>`}
${r.aps.map((a, i) => `<div class="card"><div class="prow"><span class="ap-tag">${sl ? 'Arbeit' : 'Paket'} ${i + 1}</span>${r.aps.length > 1 ? `<button class="x" data-delap="${a.id}">✕</button>` : ''}</div>
<label>${sl ? 'AP-Nr. / Position (optional)' : 'Arbeitspaket (AP-Nr.)'}</label><input list="aplist" data-ap="${a.id}" data-k="nr" value="${esc(a.nr)}" placeholder="${sl ? 'optional' : 'z. B. 10 – auswählen oder eintippen'}">
<label>${sl ? 'Kennzeichnung der Arbeit' : 'Arbeitsbeschreibung'}</label><textarea data-ap="${a.id}" data-k="text" placeholder="${sl ? 'z. B. Lampenmast an der Baustraße abgebaut, Betonplombe entfernt' : 'z. B. Planie zum Asphalteinbau hergestellt'}" ${sl ? 'style="min-height:110px"' : ''}>${esc(a.text)}</textarea>
<div class="mic">🎤 Mikrofon auf der Handy-Tastatur antippen und sprechen.</div></div>`).join('')}
${r.aps.length < 7 ? `<button class="btn ghost full" data-act="addap">＋ ${sl ? 'Weitere Arbeit' : 'Weiteres Arbeitspaket'}</button>` : ''}
<datalist id="aplist">${apVorschlaege(r).map(([n, t]) => `<option value="${esc(n)}">${esc(t)}</option>`).join('')}</datalist>`;
}
const apLbl = (a, i) => `<span class="ap-tag">AP ${esc(a.nr) || '?'}</span><span>${esc(a.text || 'ohne Beschreibung')}</span>`;
const stepper = (kind, id, ap, val) => `<div class="step"><button data-st="${kind}|${id}|${ap}|-0.25">−</button><input inputmode="decimal" data-hin="${kind}|${id}|${ap}" value="${val ? fmt(val) : ''}" placeholder="0"><button data-st="${kind}|${id}|${ap}|0.25">＋</button></div>`;
function vPers() {
  const r = S.r, d = dauer(r), sl = r.typ === 'sl'; return `<h2>Personal</h2>
<div class="grid2" style="margin-bottom:6px"><button class="btn" data-act="addma">＋ Mitarbeiter</button><button class="btn ghost" data-act="kolonne">↺ Kolonne + Stunden vom letzten Bericht</button></div>
${HIST.length > 1 ? `<button class="btn ghost small full" style="margin-bottom:10px;border-style:dashed" data-act="kolonnewahl">Kolonne aus älterem Bericht …</button>` : ''}
${r.personal.length ? `<div class="card" style="background:#f6f6f6"><div class="prow"><div class="hint" style="margin:0">${sl ? `Stundenlohn gesamt: <b>${fq(r.personal.reduce((x, p) => x + sumH(p), 0))} h</b>` : `Arbeitszeit lt. Abschluss: <b>${fq(d)} h</b>`}</div><button class="btn small ghost" data-act="copyh">Stunden der 1. Person für alle</button></div></div>` : `<div class="empty">Noch niemand eingetragen.</div>`}
${r.personal.map(p => { const s = sumH(p); const warn = !sl && !p.zus && Math.abs(s - d) > 0.01; return `<div class="card">
 <div class="prow"><div><div class="pname">${esc(p.name)}</div>${p.nr || !p.neu ? `<div class="pnr">Pers.-Nr. ${esc(p.nr) || '–'}${p.neu ? '<span class="newp">neu</span>' : ''}</div>` : `<div class="pnr">Neu, nicht in der Liste <span class="newp">neu</span></div><input data-pnr="${p.id}" inputmode="numeric" placeholder="Pers.-Nr. (falls bekannt)" style="margin-top:6px;padding:7px 9px;font-size:15px">`}</div><div style="display:flex;align-items:center"><span class="sum ${warn ? 'warn' : ''}">${p.zus ? esc(p.zus) : fq(s) + ' h'}</span><button class="x" data-del="personal|${p.id}">✕</button></div></div>
 ${sl ? `<div class="chips" style="margin:8px 0">${BERUFE.map(b => `<button class="chip ${p.beruf === b ? 'on' : ''}" data-beruf="${p.id}|${b}">${b}</button>`).join('')}</div>` : `<div class="chips" style="margin:8px 0">${SD.zus.map(z => `<button class="chip zus ${p.zus === z ? 'on' : ''}" data-zus="${p.id}|${z}">${z}</button>`).join('')}</div>`}
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
<div class="card" style="background:#fff4ea;border:1.5px solid #f6c89a"><b>📷 Lieferschein scannen</b><p class="hint" style="margin:4px 0 8px">Foto machen – Lieferschein-Nr., Menge, Material und Lieferant werden automatisch eingetragen. Lieferschein flach hinlegen, gut ausleuchten, ganz aufs Bild.</p>
<div class="row"><span class="btn orange fotobtn">📷 Kamera<input type="file" accept="image/*" capture="environment" data-scan="1"></span><span class="btn ghost fotobtn">🖼️ Mehrere aus Galerie<input type="file" accept="image/*" multiple data-scan="1"></span></div></div>
${r.material.length ? '' : `<div class="empty">Noch kein Material.</div>`}
${r.material.map(m => `<div class="card"><div class="prow"><b>${esc(m.mat) || 'Material wählen'}</b><button class="x" data-del="material|${m.id}">✕</button></div>
 <label>${r.typ === 'sl' ? 'Für Arbeit' : 'Für Arbeitspaket'}</label><select data-m="${m.id}" data-k="ap">${r.aps.map((a, i) => `<option value="${a.id}" ${m.ap === a.id ? 'selected' : ''}>AP ${esc(a.nr) || '?'} ${esc((a.text || '').slice(0, 30))}</option>`).join('')}</select>
 <div class="grid2"><div class="${ocrF(m, 'lief')}"><label>Lieferant</label>${pickBtn('lief|' + m.id, m.lief || 'wählen …')}</div><div class="${ocrF(m, 'mat')}"><label>Material</label>${pickBtn('mat|' + m.id, m.mat || 'wählen …')}</div></div>
 <div class="grid2"><div><label>Lieferschein-Nr.</label><input class="${ocrF(m, 'ls')}" data-m="${m.id}" data-k="ls" value="${esc(m.ls)}" placeholder="43663"></div>
 <div><label>Menge ${m.einh ? '[' + esc(m.einh) + ']' : ''}</label><input class="${ocrF(m, 'menge')}" inputmode="decimal" data-m="${m.id}" data-k="menge" value="${m.menge !== '' && m.menge != null ? fmt(num(m.menge)) : ''}" placeholder="0,00"></div></div>
 ${m.ocr ? ocrHinweis(m) : ''}
 <div style="margin-top:10px"><span class="btn ghost small fotobtn">📷 ${m.fotos.length ? 'Weiteres Foto' : 'Foto + automatisch erkennen'}<input type="file" accept="image/*" capture="environment" data-foto="${m.id}"></span></div>
 <div class="thumbs">${m.fotos.map((f, i) => `<img src="${f}" data-delfoto="${m.id}|${i}" title="Antippen zum Löschen">`).join('')}</div>
</div>`).join('')}
${LSL.some(e => lsFrei(e) && !r.material.some(m => m.lsid === e.id)) ? `<button class="btn ghost full" style="margin-bottom:8px;border-color:var(--orange)" data-act="lsimport">📋 Aus Lieferschein-Liste übernehmen (${LSL.filter(e => lsFrei(e) && !r.material.some(m => m.lsid === e.id)).length} offen)</button>` : ''}
<div class="row"><button class="btn" data-act="addmat">＋ Von Hand</button>${r.material.length ? `<button class="btn ghost" data-act="dupmat">＋ Gleiches Material</button>` : ''}</div>`;
}
function vAbschluss() {
  const r = S.r, res = pruefe(r); const e = res.filter(x => x.t === 'e').length, w = res.filter(x => x.t === 'w').length; return `<h2>Abschluss</h2>
<div class="card"><div class="grid2"><div><label style="margin-top:0">Beginn</label><input type="time" data-f="beginn" value="${r.beginn}"></div><div><label style="margin-top:0">Ende</label><input type="time" data-f="ende" value="${r.ende}"></div></div>
<label>Pause</label><div class="chips">${PAUSEN.map(p => `<button class="chip ${r.pause === p ? 'on' : ''}" data-pause="${p}">${p}</button>`).join('')}</div>
<div class="hint" style="margin-top:8px">Dauer: <b>${fq(dauer(r))} h</b></div></div>
<div class="card"><label style="margin-top:0">Bemerkungen / abweichende Arbeitszeit</label><textarea data-f="bem" placeholder="z. B. Mustermann bis 16:00 Uhr">${esc(r.bem)}</textarea>
<label>Wichtige Vorkommnisse, Besprechungen (Bautagebuch)</label><textarea data-f="vork" placeholder="z. B. Baubesprechung mit Mustermann">${esc(r.vork)}</textarea>
<div class="mic">🎤 Mikrofon auf der Tastatur antippen: diktieren statt tippen.</div></div>
<h3>Prüfung ${e ? `<span class="badge" style="background:#fdecea;color:var(--rot)">${e} Fehler</span>` : ''} ${w ? `<span class="badge b-pr">${w} Hinweise</span>` : ''}</h3>
<div class="card">${res.length ? res.map(x => `<div class="check"><span class="dot ${x.t}">${x.t === 'e' ? '!' : '?'}</span><div>${x.m} <a href="#" data-go="${x.s}">ändern</a></div></div>`).join('') : `<div class="check"><span class="dot ok">✓</span><div>Alles vollständig.</div></div>`}</div>
<h3>Unterschrift Polier</h3><div class="card"><canvas class="sigpad" id="sig"></canvas><div class="prow" style="margin-top:6px"><span class="hint" style="margin:0">Mit dem Finger unterschreiben</span><button class="btn small ghost" data-act="sigclear">Löschen</button></div></div>
<h3>Vorschau</h3>${docViewer(r)}`;
}
function docViewer(r) { if (r.typ === 'sl') return `<div class="a4wrap"><div class="a4box">${docSL(r)}</div></div>`; return `<div class="seg"><button class="${S.doc === 'tb' ? 'on' : ''}" data-doc="tb">Tagesbericht</button><button class="${S.doc === 'btb' ? 'on' : ''}" data-doc="btb">Bautagebuch</button></div><div class="a4wrap"><div class="a4box">${S.doc === 'tb' ? docTB(r) : docBTB(r)}</div></div>` }
// Baustellen-Nr.: Zahlen-Tastatur zuerst; „ABC“ schaltet auf Buchstaben um (z. B. 26025A)
const bnrFeld = (attr, v, ph) => `<div class="bnrfeld"><input ${attr} inputmode="${S.bnrABC ? 'text' : 'numeric'}" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" value="${esc(v)}" placeholder="${ph}"><button type="button" class="btn small ghost" data-kbd="1" title="Tastatur umschalten">${S.bnrABC ? '123' : 'ABC'}</button></div>`;
document.addEventListener('pointerdown', e => { const b = e.target.closest('[data-kbd]'); if (!b) return; e.preventDefault(); const i = b.previousElementSibling; S.bnrABC = !S.bnrABC; i.inputMode = S.bnrABC ? 'text' : 'numeric'; b.textContent = S.bnrABC ? '123' : 'ABC'; i.blur(); setTimeout(() => i.focus(), 30) });
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-tst]'); if (!b) return; const k = b.dataset.tst, out = $('#tstout');
  const pdf = 'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+CiUlRU9G';
  const files = k === 'pdf' ? [new File([Uint8Array.from(atob(pdf), c => c.charCodeAt(0))], 'test.pdf', { type: 'application/pdf' })] : k === 'txt' ? [new File(['Test'], 'test.txt', { type: 'text/plain' })] : null;
  const info = `${k}: share=${!!navigator.share} canShare=${files ? !!(navigator.canShare && navigator.canShare({ files })) : '-'}`;
  try { await navigator.share(files ? { files, title: 'Test' } : { title: 'Test', text: 'Test' }); out.textContent += info + ' → OK\n' }
  catch (err) { out.textContent += `${info} → ${err.name}: ${err.message}\n` }
  if (!out.dataset.ua) { out.dataset.ua = 1; out.textContent += navigator.userAgent + ' · App ' + APP_VERSION + ' · ' + (standalone() ? 'installiert' : 'Browser') + '\n' }
});
const pickBtn = (k, label) => `<button class="btn ghost full" style="justify-content:space-between;font-weight:600" data-pick="${k}"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span><span>▾</span></button>`;

const ocrF = (m, k) => m.ocr && m.ocr.auto.some(f => f.replace(/[~^]/, '') === k) ? 'ocr' : '';
function ocrHinweis(m) {
  const o = m.ocr, n = { ls: 'Lieferschein-Nr.', menge: 'Menge', mat: 'Material', lief: 'Lieferant' };
  const erk = o.auto.filter(f => !/[~^]$/.test(f)).map(f => n[f]), uebern = o.auto.filter(f => f.endsWith('~')).map(f => n[f.replace('~', '')]), gel = o.auto.filter(f => f.endsWith('^')).map(f => n[f.replace('^', '')]);
  const dw = o.datum && o.datum !== S.r.datum ? `<br>⚠️ Datum auf dem Lieferschein: <b>${dateDe(o.datum)}</b> – passt nicht zum Bericht.` : '';
  const chips = o.chips ? `<div class="chips" style="margin:6px 0 2px">${o.chips.map((c, i) => `<button class="chip ${m.mat === c[1] ? 'on' : ''}" data-matchip="${m.id}|${i}">${esc(c[0])}</button>`).join('')}</div>` : '';
  return `<div class="ocrbox">${o.profil ? `🏷️ Erkannt als: <b>${esc(o.profil)}</b><br>` : ''}${o.miete ? 'Miete/Regie: Menge in <b>Stunden</b>, Fahrzeug unten antippen.' + chips : chips ? 'Material schnell wählen:' + chips : ''}${o.fehler ? 'Texterkennung fehlgeschlagen – bitte von Hand ausfüllen.' : erk.length ? `🔍 Automatisch erkannt: <b>${erk.join(', ')}</b> – bitte prüfen.` : 'Nichts sicher erkannt – bitte von Hand ausfüllen.'}${uebern.length ? `<br>↺ Vom vorherigen Lieferschein übernommen: ${uebern.join(', ')}` : ''}${gel.length ? `<br>🧠 Aus früheren Lieferscheinen dieses Lieferanten: ${gel.join(', ')}` : ''}${o.liefNeu ? '<br>🆕 Lieferant nicht in der Liste – Name aus dem Briefkopf übernommen. Bitte prüfen; die App merkt sich die Zuordnung.' : ''}${dw}
  ${o.text ? `<details><summary>Erkannten Text anzeigen</summary><pre>${esc(o.text)}</pre></details>` : ''}</div>`;
}
async function vorlageMitPruefung(h) { if (S.r && S.r._draft !== false && hatInhalt(S.r) && !(await bestaetigen('Der aktuelle Entwurf wird durch die Vorlage ersetzt. Fortfahren?'))) return; vorlageAus(h) }

// ---------------------------------------------------------------- Lieferschein-Texterkennung (OCR, läuft auf dem Handy, offline)
// Feste Ergänzungen der Stammdaten (bleiben auch nach Excel-Import erhalten)
const EXTRA_LIEF = ['a+b', 'SWK', 'Ehinger Beton', 'Kessler'];
const MIETE = ['LKW 3-Achser', 'LKW 4-Achser', 'Sattelzug', 'Traktor', 'Hängerzug', 'Bagger mit Bedienung'];
const EXTRA_MAT = [...MIETE.map(n => [n, '', 'Std', 'Miete / Regie']), ['Aushub (Anlieferung)', '', 'm3', 'MKB'], ['AC 11 DS', '', 'to', 'Asphalt']];
// Material-Nummern auf dem BSR Liefer- und Wiegeschein
const BSR_CODES = { '60': 'Ablagerung Asphalt', '65': 'Ablagerung Beton', '86': 'Zuschlag für Übergröße', '01': 'Moränesand 0/2 gew.', '02': 'Moränesand 0/4 gew.', '03': 'Moränesand 0/8 gew.', '08': 'Moränekiessand-Gemisch 0/16 gew.', '09': 'Moränekiessand-Gemisch 0/32 gew.', '10': 'Schwemmsand', '15': 'Moräne Auffüllkies 4/X', '16': 'Auffüllkies 0/X', '17': 'Frostschutzkies 0/32', '37': 'Wiegen mit geeichter Waage', '44': 'Gemisch 0/16 gebrochen', '46': 'Frostschutzkies 0/45 güteüberwacht', '75': 'Beton-Bruch 0/45', '79': 'Beton-Schroppen 45/X', '82': 'Asphalt-Bruch' };
function sdErgaenzen(sd) {
  if (!sd) return sd;
  EXTRA_LIEF.forEach(l => { if (!sd.lief.some(x => x.toLowerCase() === l.toLowerCase())) sd.lief.push(l) });
  sd.lief.sort((a, b) => a.localeCompare(b, 'de'));
  EXTRA_MAT.forEach(m => { if (!sd.mat.some(x => x[0] === m[0])) sd.mat.push(m) });
  return sd;
}

let ocrWorker = null, ocrProg = null;
async function ocrInit() {
  if (ocrWorker) return ocrWorker;
  const base = new URL('vendor/tesseract/', location.href).href;
  ocrWorker = await Tesseract.createWorker('deu', 1, {
    workerPath: base + 'worker.min.js', corePath: base, langPath: base.replace(/\/$/, ''), gzip: true, workerBlobURL: false,
    logger: m => { if (ocrProg && m.status === 'recognizing text') ocrProg(m.progress) }
  });
  return ocrWorker;
}
// Bild drehen, verkleinern und aufbereiten. mode 'c' = Kontrast, 'a' = adaptive Schwelle (für blassen Nadeldruck/Grauflächen)
function ocrCanvas(bmp, rot, mode, max) {
  const s = Math.min(2, max / Math.max(bmp.width, bmp.height)), W = Math.round(bmp.width * s), H = Math.round(bmp.height * s);
  const c = document.createElement('canvas'); if (rot % 180) { c.width = H; c.height = W } else { c.width = W; c.height = H }
  const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 180); x.filter = 'grayscale(1)'; x.drawImage(bmp, -W / 2, -H / 2, W, H); x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none';
  const w = c.width, h = c.height, d = x.getImageData(0, 0, w, h), p = d.data;
  if (mode === 'g') { }
  else if (mode === 'c') { for (let i = 0; i < p.length; i += 4) { const v = Math.max(0, Math.min(255, (p[i] - 128) * 1.6 + 128)); p[i] = p[i + 1] = p[i + 2] = v } }
  else {
    const g = new Uint32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let xx = 0; xx < w; xx++) { row += p[(y * w + xx) * 4]; g[(y + 1) * (w + 1) + xx + 1] = g[y * (w + 1) + xx + 1] + row } }
    const r = Math.max(8, Math.round(Math.max(w, h) / 80));
    for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1); for (let xx = 0; xx < w; xx++) { const x0 = Math.max(0, xx - r), x1 = Math.min(w, xx + r + 1); const sum = g[y1 * (w + 1) + x1] - g[y0 * (w + 1) + x1] - g[y1 * (w + 1) + x0] + g[y0 * (w + 1) + x0]; const i = (y * w + xx) * 4; const v = p[i] < sum / ((y1 - y0) * (x1 - x0)) * 0.88 ? 0 : 255; p[i] = p[i + 1] = p[i + 2] = v } }
  }
  x.putImageData(d, 0, 0); return c;
}
// Schnell lesen: erster Durchgang dient gleichzeitig als Lage-Prüfung. Weitere Durchgänge nur, solange Felder fehlen,
// und höchstens ca. 25 Sekunden. Gedrehte Fotos: nur dann alle vier Lagen prüfen, wenn der erste Durchgang kaum Wörter liefert.
async function ocrLesen(file, status) {
  const t0 = Date.now(), w = await ocrInit(), bmp = await createImageBitmap(file);
  const woerter = t => (t.match(/(^|\s)[A-ZÄÖÜa-zäöüß][a-zäöüß]{3,}[.,:]?(?=\s|$)/g) || []).length;
  const fertig = r => r.ls && r.menge != null && r.menge !== '' && (r.mat || r.miete);
  const lesen = async (rot, mode, psm, mx, nr, von) => {
    ocrProg = p => status(`Text wird gelesen (${nr}/${von}) … ${Math.round(p * 100)} %`);
    await w.setParameters({ tessedit_pageseg_mode: psm });
    const c = ocrCanvas(bmp, rot, mode, mx), d = (await w.recognize(c)).data; c.width = c.height = 0; return d;
  };
  status('Text wird gelesen …');
  // 1. Durchgang: adaptive Schwelle (am besten für Lieferscheine), aufrecht
  const d0 = await lesen(0, 'a', '6', 2000, 1, 3); let rot = 0, text = d0.text || '';
  if (woerter(text) < 8 || d0.confidence < 45) {
    // kaum lesbar → Lage prüfen (kleine, schnelle Probe-Bilder)
    status('Foto liegt evtl. gedreht – Lage wird geprüft …');
    await w.setParameters({ tessedit_pageseg_mode: '3' });
    const probe = async r => { const c = ocrCanvas(bmp, r, 'c', 1000), d = (await w.recognize(c)).data; c.width = c.height = 0; return { r, q: woerter(d.text || ''), cf: d.confidence } };
    const p = {}; for (const r of [0, 90, 180, 270]) p[r] = await probe(r);
    const sc = r => p[r].q * p[r].cf + p[(r + 90) % 360].q * p[(r + 90) % 360].cf;
    rot = [0, 90, 180, 270].reduce((a, b) => sc(b) > sc(a) ? b : a, 0);
    if (rot) text = (await lesen(rot, 'a', '6', 2000, 1, 3)).text || '';
  }
  let res = parseLieferschein(text);
  const weitere = [['c', '6', 2000], ['g', '11', 2400]];
  for (let i = 0; i < weitere.length && !fertig(res) && Date.now() - t0 < 25000; i++) {
    const [mode, psm, mx] = weitere[i];
    text += '\n' + ((await lesen(rot, mode, psm, mx, i + 2, 3)).text || '');
    res = parseLieferschein(text);
  }
  if (bmp.close) bmp.close();
  ocrProg = null; return { text, res, rot };
}

// Ausgeschriebene Firmennamen → Kürzel aus den Stammdaten (z. B. Moränekieswerk Baustetten → MKB)
const LIEF_ALIAS = { MKB: ['moränekieswerk', 'moranekieswerk', 'moraenekieswerk', 'moränekies baustetten', 'kieswerk baustetten'], BSR: ['baustoffrecycling', 'baustoff-recycling', 'baustoff recycling'],
  'a+b': ['a+b asphalt', 'asphalt- und betonmischwerke', 'asphalt und betonmischwerke', 'splittwerk ingoldingen'], SWK: ['schotterwerk kirchen'], GeRe: ['gere transporte', 'gerold rehm'],
  Mantz: ['hubert mantz', 'fuhrunternehmen mantz'], Kessler: ['paul kessler', 'baggerbetrieb kessler'], DAM: ['donau-asphalt', 'donau asphalt', 'asphalt-mischwerke', 'waage-dam'], 'Ehinger Beton': ['ehinger beton', 'tbw-ehingen', 'transportbetonwerk ehingen'] };
const MORPH = /(moräne|morane|kies|sand|splitt|schotter|werk|stoff|recycling|beton|asphalt|misch|bau|transport|handel|erd|tief|fuhr|unternehmen|gesellschaft)/gi;
function liefKurz(text) {   // findet zu einem Firmennamen das Kürzel aus den Stammdaten
  if (!text) return ''; const low = String(text).toLowerCase(), SDL = (SD && SD.lief) || [];
  const inSD = k => SDL.find(l => l.toLowerCase() === k.toLowerCase()) || k;
  for (const [k, al] of Object.entries(LIEF_ALIAS)) if (al.some(a => low.includes(a))) return inSD(k);
  const wort = SDL.filter(l => l.length >= 3).sort((a, b) => b.length - a.length).find(l => new RegExp('(^|[^a-zäöüß])' + l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-zäöüß])').test(low));
  if (wort) return wort;
  // Abkürzung aus Anfangsbuchstaben (auch von Wortteilen): „Baustoffrecycling Laupheim“ → B-S-R-L → BSR
  const ini = String(text).split(/[^A-Za-zÄÖÜäöüß]+/).filter(w => w.length >= 2 && !/^(gmbh|co|kg|ag|und|der|die|das)$/i.test(w)).flatMap(w => { const p = w.replace(MORPH, ' $1 ').trim().split(/\s+/).filter(Boolean); return p.map(x => x[0].toUpperCase()) }).join('');
  for (const l of SDL) {
    if (!/^[A-ZÄÖÜ]{3,4}$/.test(l) || ini[0] !== l[0]) continue; let i = 0; for (const ch of ini) if (ch === l[i]) i++; if (i === l.length) return l;
  }
  return '';
}
function zahlDe(s) { s = String(s).replace(/\s/g, ''); if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.')); if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, '')); return parseFloat(s) }
const r2 = v => Math.round(v * 100) / 100;
function wiegeNetto(t) {   // Brutto / Tara / Netto als drei Gewichte hintereinander → Netto
  const v = []; let m; const re = /(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(kg|t|to)\b/gi;
  while ((m = re.exec(t))) { let x = zahlDe(m[1]); if (/kg/i.test(m[2])) x /= 1000; else if (/^\d{1,3}\.\d{3}$/.test(m[1])) x = parseFloat(m[1]); v.push(x) }
  for (let i = 0; i + 2 < v.length; i++) if (v[i] > v[i + 1] && Math.abs(v[i] - v[i + 1] - v[i + 2]) < 0.05 && v[i + 2] > 0) return r2(v[i + 2]);
  return null;
}
const MIET_RE = [[/3\s*-?\s*achs/i, 'LKW 3-Achser'], [/4\s*-?\s*achs/i, 'LKW 4-Achser'], [/sattel/i, 'Sattelzug'], [/tra[ck]+tor/i, 'Traktor'], [/h[äa]nger|anh\./i, 'Hängerzug'], [/bagger|hydraulik/i, 'Bagger mit Bedienung']];
const mietChips = () => MIETE.map(n => [n.replace('LKW ', ''), n, 'Std']);
function regieStunden(t) {
  let m = t.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:std|stunden|h)\b/i); if (m) return zahlDe(m[1]);
  const z = [...t.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)].map(x => +x[1] + x[2] / 60).filter(x => x >= 5 && x <= 20);
  if (z.length >= 2 && z[1] > z[0]) return r2(z[1] - z[0]);
  return null;
}
// Ankreuzfelder „3-Achser / 4-Achser / Sattel“: leere Kästchen erscheinen im Text als [ ], [_], [1 …, das angekreuzte nicht
function angekreuzt(t) {
  const opt = [[/3\s*-?\s*a.?.?\s?s\s*er/gi, 'LKW 3-Achser'], [/4\s*-?\s*a.?.?\s?s\s*er/gi, 'LKW 4-Achser'], [/sattel/gi, 'Sattelzug'], [/tra[ck]+tor/gi, 'Traktor']];
  const score = {};
  for (const [re, n] of opt) for (const m of t.matchAll(re)) { const vor = t.slice(Math.max(0, m.index - 4), m.index); const leer = /[\[(][_\-—–1lI|\s]?[\])]?\s*$/.test(vor) && !/x/i.test(vor); score[n] = (score[n] || 0) + (leer ? -1 : 1) }
  const k = Object.entries(score).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return k.length && (k.length === 1 || k[0][1] > k[1][1]) ? k[0][0] : '';
}
function regieMaterial(t, def) { const f = MIET_RE.find(([re]) => re.test(t)); return f ? f[1] : def || '' }
// Asphaltsorte wie „AC 11 DS 50/70“ → Stammdaten-Material „AC 11 DS“ (bzw. nächstliegende Sorte)
function asphaltSorte(t) {
  const m = t.match(/\b(AC|SMA|MA|PA)\s?(\d{1,2})\s?([TBDSNL]{1,3})\b/); if (!m) return null;
  const code = `${m[1]} ${m[2]} ${m[3]}`, norm = s => s.replace(/\s+/g, '').toUpperCase();
  const sd = SD.mat.find(x => norm(x[0]) === norm(code)) || SD.mat.find(x => norm(x[0]).startsWith(norm(code))) || null;
  return sd ? { mat: sd[0], matnr: sd[1], einh: sd[2] || 'to' } : { mat: code, matnr: '', einh: 'to' };
}
// Regeln je Lieferant: erkennen am Briefkopf, dann gezielt LS-Nr., Menge und Material lesen
const LS_PROFILE = [
  { id: 'BSR', name: 'Baustoffrecycling Laupheim (BSR)', lief: 'BSR', re: /baustoff\s*-?\s*recycling|kies-\s*und\s*sandvertrieb/i, einh: 'to', nurMat: true,
    chips: () => ['60', '65', '82', '75', '46', '17', '16'].map(k => [k + ' ' + BSR_CODES[k], BSR_CODES[k], 'to']),
    lese(t) { const o = {}; let m;
      if ((m = t.match(/wiegeschein\D{0,25}(\d{5,7})/i) || t.match(/\b(2\d{5})\b/))) o.ls = m[1];
      if ((m = t.match(/\bN\s*[:;.]\s*(\d{3,6})\s*kg/i))) o.menge = r2(+m[1] / 1000);
      else if (wiegeNetto(t) != null) o.menge = wiegeNetto(t);
      else { const ks = [...t.matchAll(/\b(\d{4,6})\s*[k&xX]?\s?[g9]\b/g)].map(x => +x[1]).filter(x => x >= 1000); if (ks.length) o.menge = r2(Math.min(...ks) / 1000) }
      if ((m = t.match(/mat\.?\s*-?\s*nr\.?\s*[:.]?\s*(\d{2})\b/i)) && BSR_CODES[m[1]]) o.mat = BSR_CODES[m[1]];
      return o } },
  // DAM Donau-Asphalt-Mischwerke (Heim-Gruppe), Wiegeschein: Nummer 26-51-12092, Sorte, Netto = Brutto − Tara
  { id: 'DAM', name: 'DAM Donau-Asphalt-Mischwerke', lief: 'DAM', re: /donau\s*-?\s*asp\s*h?alt|asphalt-?\s*mischwerke|waage-dam|heim-gruppe|\bDAM\b/i, einh: 'to',
    lese(t) { const o = {}; let m;
      const nr = [...t.matchAll(/\b(\d{2}-\d{2}-\d{4,6})\b/g)].map(x => x[1]).sort((a, b) => b.length - a.length); if (nr.length) { o.ls = nr[0]; if (/-\d{4}$/.test(o.ls)) o.lsUnsicher = true }
      const tt = t.replace(/(\d{1,2})\s*[‚,.]\s*(\d{3})\s*(t|to)\b/g, '$1,$2 t');
      const w = [...tt.matchAll(/\b(\d{1,2},\d{3}) t\b/g)].map(x => zahlDe(x[1]));
      for (let i = 0; i + 1 < w.length && o.menge == null; i++) { const n = r2(w[i] - w[i + 1]); if (n > 0.5 && n < 35 && (w[i + 2] == null || Math.abs(w[i + 2] - n) < 0.05 || w[i] > 20)) o.menge = n }
      if ((m = tt.match(/netto\w*\s*:?[\s\S]{0,60}?\b(\d{1,2},\d{3}) t/i)) && o.menge == null) o.menge = zahlDe(m[1]);
      const s = asphaltSorte(t); if (s) Object.assign(o, s);
      return o } },
  // a+b Lieferschein/Rapport für LKW (Transportauftrag): Menge = Stunden, Material = angekreuzter LKW-Typ
  { id: 'a+b-Rapport', name: 'a+b Lieferschein/Rapport (LKW-Stunden)', lief: 'a+b', miete: true, chips: mietChips,
    re: /^(?=[\s\S]*(?:a\s*\+\s*b\s*asphalt|betonmischwerke|ingoldingen|winterstetter))(?=[\s\S]*(?:achser|sattel|spediteur|rapport|kennzeichen))(?![\s\S]*ausgangs\s*-?\s*lieferschein)/i,
    lese(t) { const o = {}; let m;
      const nr = [...t.matchAll(/\bnr\.?\s*:?\s*(\d{5,6})\b/gi)].map(x => x[1]); if (nr.length) o.ls = nr.sort((a, b) => nr.filter(x => x === b).length - nr.filter(x => x === a).length)[0];
      o.mat = angekreuzt(t) || ''; o.menge = regieStunden(t); return o } },
  { id: 'a+b', name: 'a+b Asphalt- und Betonmischwerke', lief: 'a+b', re: /a\s*\+\s*b\s*asphalt|asphalt-?\s*und\s*betonmischwerke|splittwerk\s*ingoldingen|ausgangslieferschein/i, einh: 'to',
    lese(t) { const o = {}; let m;
      if ((m = t.match(/ausgangs\s*-?\s*lieferschein\s*nr\.?\s*:?\s*(\d{5,7})/i))) o.ls = m[1];
      if ((m = t.match(/\bN\s*[:.]?\s*(\d{1,3}[.,]\d{2})\s*t/))) o.menge = zahlDe(m[1]);
      const s = asphaltSorte(t); if (s) Object.assign(o, s); else if ((m = t.match(/material\s*\w{0,6}\s*\n\s*([^\n]{4,45})/i))) o.mat = m[1].trim();
      return o } },
  { id: 'MKB', name: 'Moränekieswerk Baustetten (MKB)', lief: 'MKB', re: /mor[aä]nekies(?!sand)|splittwerke|kies\s*und\s*splitt/i, einh: 'to', nurProfil: true,
    chips: () => [['Aushub', 'Aushub (Anlieferung)', 'm3'], ...SD.mat.filter(m => m[3] === 'MKB' && !/aushub/i.test(m[0])).slice(0, 7).map(m => [m[0], m[0], m[2]])],
    lese(t) { const o = {}; let m;
      if ((m = t.match(/bon\s*-?\s*nr\.?\s*:?\s*(\d{3,})/i))) o.ls = m[1];
      else if ((m = t.match(/fahrzeug\s*:?\s*([A-ZÄÖÜ]{1,3}\s*-\s*[A-Z]{1,2}\s*\d{1,4})/i))) o.ls = 'Fzg ' + m[1].replace(/\s+/g, ' ').toUpperCase();
      const g = t.match(/gewicht\D{0,12}(\d+(?:[.,]\d+)?)\s*(m3|m³|m\s*3|t|to)?/i), n = t.match(/(\d{1,2})\s*fuhren/i) || t.match(/wiegungen\D{0,6}(\d{1,2})/i);
      if (g && g[2]) { o.menge = r2(zahlDe(g[1]) * (n ? +n[1] : 1)); if (/m/i.test(g[2])) o.einh = 'm3' }
      if (/aushub/i.test(t)) { o.mat = 'Aushub (Anlieferung)'; o.einh = 'm3' }
      return o } },
  { id: 'SWK', name: 'SWK Schotterwerk Kirchen', lief: 'SWK', re: /schotterwerk|\bswk\b/i, einh: 'to',
    lese(t) { const o = {}; let m;
      if ((m = t.match(/lieferschein[^\d]{0,40}?(\d{3}\.\d{3})\b/i) || t.match(/\b(\d{3}\.\d{3})\b(?!\s*(t|kg))/))) o.ls = m[1];
      if ((m = t.match(/\b0\d{3}\s*\n+\s*([A-ZÄÖÜ][A-Za-zÄÖÜäöüß. ]*\d+\/\d+)/))) o.mat = m[1].trim();
      else if ((m = t.match(/(schottertragschicht[^\n]{0,40}|frostschutz[^\n]{0,30})/i))) o.mat = m[1].trim();
      return o } },
  { id: 'Muffenrohr', name: 'Muffenrohr Tiefbauhandel', lief: 'Muffenrohr', re: /muffenrohr/i, einh: 'Stk',
    lese(t) { const o = {}; let m;
      if ((m = t.match(/\b(45\d{8})\b/) || t.match(/lieferschein[\s\S]{0,80}?(\d{8,12})/i))) o.ls = m[1];
      const pos = []; const re = /\b000[1-9]0\s+(\d{5,7})\s+(\d+(?:[.,]\d+)?)\s*(ST|STK|M|KG|T|PAL)\b[^\n]*\n\s*([^\n]+)/gi;
      while ((m = re.exec(t))) { const d = m[4].replace(/\s+(ACHTUNG|Positionsgewicht)[\s\S]*$/i, '').trim().replace(/\s+/g, ' '); if (/palette/i.test(d) || (d.match(/[a-zäöüß]/gi) || []).length < 4 || pos.some(x => x.matnr === m[1])) continue; pos.push({ mat: d, matnr: m[1], menge: zahlDe(m[2]), einh: /^st/i.test(m[3]) ? 'Stk' : m[3].toLowerCase() }) }
      if (pos.length) { Object.assign(o, pos[0]); o.pos = pos }
      return o } },
  { id: 'Ehinger', name: 'Ehinger Beton', lief: 'Ehinger Beton', re: /ehinger\s*beton|tbw-ehingen/i, einh: 'm3',
    lese(t) { const o = {}; let m;
      if ((m = t.match(/lieferschein\s*-?\s*n\S{0,3}\s*:?\s*(\d{5,7})/i))) o.ls = m[1];
      if ((m = t.match(/\bist\s*:?\s*(\d+[.,]\d{1,2})/i) || t.match(/menge\s*\(m.{0,2}\)[\s\S]{0,60}?(\d+[.,]\d{2})/i))) o.menge = zahlDe(m[1]);
      o.mat = (m = t.match(/\b(C\s?\d{1,2}\s?\/\s?\d{2}[^\n]{0,25})/)) ? 'Beton ' + m[1].trim() : 'Transportbeton';
      return o } },
  { id: 'GeRe', name: 'GeRe Transporte (Miete/Regie)', lief: 'GeRe', re: /gere\s*transporte|gerold\s*rehm/i, miete: true, chips: mietChips,
    lese(t) { const o = {}; let m; if ((m = t.match(/transportauftrag\s*nr[\s\S]{0,45}?\b(\d{5,8})\b/i) || t.match(/\b(00\d{4})\b/))) o.ls = m[1]; o.menge = regieStunden(t); o.mat = regieMaterial(t); return o } },
  { id: 'Mantz', name: 'Hubert Mantz Fuhrunternehmen (Miete/Regie)', lief: 'Mantz', re: /hubert\s*mantz|\bmantz\b/i, miete: true, chips: mietChips,
    lese(t) { const o = {}; let m; if ((m = t.match(/(?:regiebericht|rapport)[^\n]{0,15}?nr\.?\s*:?\s*(\d{1,6})/i))) o.ls = m[1]; o.menge = regieStunden(t); o.mat = regieMaterial(t); return o } },
  { id: 'Kessler', name: 'Paul Kessler Baggerbetrieb (Miete/Regie)', lief: 'Kessler', re: /paul\s*kessler|kessler\s*gmbh|baggerbetrieb/i, miete: true, chips: mietChips,
    lese(t) { const o = {}; let m; if ((m = t.match(/(?:regiebericht|rapport)[^\n]{0,15}?nr\.?\s*:?\s*(\d{1,6})/i))) o.ls = m[1]; o.menge = regieStunden(t); o.mat = regieMaterial(t, 'Bagger mit Bedienung'); return o } },
  { id: 'Regie', name: 'Rapport / Regiebericht (Miete)', lief: '', re: /regiebericht|rapport\s*\/|transportauftrag/i, miete: true, chips: mietChips,
    lese(t) { const o = {}; let m; if ((m = t.match(/(?:regiebericht|rapport|transportauftrag)[^\n]{0,15}?nr\.?\s*:?\s*(\d{1,8})/i))) o.ls = m[1]; o.menge = regieStunden(t); o.mat = regieMaterial(t); return o } },
];
// ---- Allgemeine Regeln (aus den Beispiel-Lieferscheinen abgeleitet, gelten für jeden Lieferanten)
const EIGEN = /schwall|neue\s*welt|88471|laupheim(?!\s*gmbh)|bauunternehmung/i;   // eigene Anschrift auf dem Beleg ignorieren
const FIRMA_RE = /(GmbH|\bKG\b|\bAG\b|\be\.\s?K\.|\bOHG\b|\bUG\b|\b(?:fuhrunternehmen|transporte?\b|spedition|baggerbetrieb|erdbau|tiefbau|baustoffe?|beton\b|betonwerk|kieswerk|schotterwerk|splittwerk|mischwerk|asphalt|recycling|handel|containerdienst|entsorgung)\b)/i;
const istFirmaZeile = l => /(GmbH|\bKG\b|\bAG\b|\be\.\s?K\.|\bOHG\b|\bUG\b)/.test(l) || /\b(fuhrunternehmen|transporte?|spedition|baggerbetrieb|erdbau|tiefbau|baustoffe?|betonwerk|kieswerk|schotterwerk|splittwerk|mischwerk|recycling|handel|containerdienst|entsorgung)\b/i.test(l);
const MIET_TEXT = /regiebericht|rapport|transportauftrag|stundenzettel|stundenlohn|tagelohn|arbeitsnachweis|maschinenmiete|mit\s*bedienung/i;
function briefkopf(t) {   // Firmenname aus dem Kopf des Belegs (erste Zeilen mit GmbH, KG, Transporte …, nicht Schwall)
  const lines = t.split('\n').map(l => l.trim()).filter(l => l.length >= 4).slice(0, 40);
  const z = lines.find(l => istFirmaZeile(l) && !EIGEN.test(l) && /[A-ZÄÖÜ][a-zäöüß]{3,}/.test(l) && (l.match(/[A-Za-zÄÖÜäöüß]/g) || []).length >= 8);
  if (!z) return '';
  return z.replace(/[,·•|].*$/, '').replace(/\s{2,}.*$/, '').replace(/[^A-Za-zÄÖÜäöüß0-9&+.\- ]/g, '').trim().slice(0, 45);
}
const kopfKey = s => String(s).toLowerCase().replace(/gmbh|co\.?|kg|ag\b|&/g, '').replace(/[^a-z0-9äöüß]/g, '').slice(0, 24);
function generischLesen(t) {
  const o = {}; let m;
  // LS-Nr.: Zahl hinter einem der bekannten Etiketten (nicht hinter „…-Datum“, „Kunden-Nr.“, „Auftrags-Nr.“)
  const lab = /(stundenzettel\s*(?:nr\.?)?|arbeitsnachweis\s*(?:nr\.?)?|liefer\s*-?\s*schein(?:\s*-?\s*n(?:r|ummer)\.?)?|liefer-?\s*und\s*wiegeschein|wiege\s*-?\s*schein(?:\s*-?\s*nr\.?)?|bon\s*-?\s*nr\.?|beleg\s*-?\s*nr\.?|transportauftrag\s*(?:nr\.?)?|regiebericht\s*(?:nr\.?)?|rapport\s*(?:\/\s*regiebericht)?\s*(?:nr\.?)?|ls\s*-?\s*nr\.?|lieferscheinnummer)/gi;
  while ((m = lab.exec(t))) {
    const rest = t.slice(m.index + m[0].length, m.index + m[0].length + 70);
    if (/^\s*-?\s*datum/i.test(rest)) continue;
    const r0 = rest.replace(/(kunden|auftrags|bestell|kd)\s*-?\s*nr\.?\s*:?\s*\d+/gi, ' ').replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, ' ');
    const re2 = /(\d{3}\.\d{3}(?!\s*(?:t|kg))|\d{2}-\d{2}-\d{4,6}|\b[A-Z]{0,3}\d{3,12}\b)/g; let z, ok = null;
    while ((z = re2.exec(r0))) { const nach = r0.slice(z.index + z[1].length); if (/^\d{5}$/.test(z[1]) && /^\s+[A-ZÄÖÜ][a-zäöüß]{2,}/.test(nach) && !/^\s+[A-Za-zÄÖÜäöüß-]+\s*[:.]/.test(nach) && !/^\s+(datum|kunden|auftrag|seite|uhrzeit|liefer|bestell|fahrzeug|baustelle|vom|von|menge|artikel|sorte)/i.test(nach)) continue; if (/^\s*(?:tel|fax|\/)/i.test(nach)) continue; ok = z[1]; break }
    if (ok) { o.ls = ok; break }
  }
  // Menge
  let q = wiegeNetto(t); if (q != null) o.einh = 'to';
  if (q == null && (m = t.match(/\bN(?:etto)?\s*[:;.]\s*(\d{3,6})\s*kg/i))) { q = r2(+m[1] / 1000); o.einh = 'to' }
  if (q == null) {
    const N = '(\\d{1,3}(?:[.\\s]\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?)';
    const grab = w => { const x = t.match(new RegExp(w + '[^\\d\\n]{0,25}' + N + '\\s*(kg|t|to|tonnen|m3|m³|m²|m2|lfm|m\\b|stk|st|std|h)?', 'i')); return x ? { v: zahlDe(x[1]), u: (x[2] || '').toLowerCase() } : null };
    const g = grab('netto(?:\\s*-?\\s*gewicht)?') || grab('liefermenge') || grab('menge') || grab('ladegewicht') || grab('\\bist\\b');
    if (g && isFinite(g.v) && g.v > 0) { q = r2(g.u === 'kg' || (!g.u && g.v > 200) ? g.v / 1000 : g.v); if (/m3|m³/.test(g.u)) o.einh = 'm3'; else if (/^(t|to|tonnen|kg)$/.test(g.u)) o.einh = 'to'; else if (/st/.test(g.u) && !/std/.test(g.u)) o.einh = 'Stk'; else if (/std|^h$/.test(g.u)) o.einh = 'Std' }
  }
  if (q != null) o.menge = q;
  // Material: hinter „Sorte“, „Artikel(bezeichnung)“, „Material“, „Produkt“; Betonklasse
  if ((m = t.match(/\b(?:sorte|artikelbezeichnung|artikel|material|produkt|bezeichnung)\b\s*[:.]?\s*(?:\d{2,6}\s+)?([A-Za-zÄÖÜäöüß][^\n]{3,45})/i)) && !/menge|nr\.|bestell|einheit|preis/i.test(m[1])) o.mat = m[1].trim().replace(/\s+/g, ' ');
  else if ((m = t.match(/\b(C\s?\d{1,2}\s?\/\s?\d{2}[^\n]{0,25})/))) o.mat = 'Beton ' + m[1].trim();
  // Miete / Regie
  if (MIET_TEXT.test(t)) { o.miete = true; o.einh = 'Std'; const h = regieStunden(t); o.menge = h != null ? h : undefined; o.mat = regieMaterial(t) || undefined }
  return o;
}

// ---- Lernspeicher: was Poliere korrigieren, merkt sich die App (je Handy)
let LERN = { alias: {}, lief: {} };
function lernen(r) {
  (r.material || []).forEach(m => {
    if (!m.lief) return;
    const L = LERN.lief[m.lief] = LERN.lief[m.lief] || { mat: {}, einh: '', miete: 0, n: 0 };
    L.n++; if (m.mat) L.mat[m.mat] = (L.mat[m.mat] || 0) + 1; if (m.einh) L.einh = m.einh; if (m.einh === 'Std') L.miete++;
    if (m.ocr && m.ocr.kopf) { const k = kopfKey(m.ocr.kopf); if (k.length >= 5) LERN.alias[k] = m.lief }
  });
  DB.set('lernen', LERN).catch(() => { });
}
const lernMat = lief => { const L = LERN.lief[lief]; if (!L) return []; return Object.entries(L.mat).sort((a, b) => b[1] - a[1]).map(x => x[0]) };

function parseLieferschein(text) {
  const t = text.replace(/[|]/g, ' ').replace(/[ \t]+/g, ' '), low = t.toLowerCase(), flat = low.replace(/\s+/g, ''), flatA = low.replace(/[^a-z0-9äöüß]/g, '');
  const out = { felder: [] };
  const P = LS_PROFILE.find(p => p.re.test(t));
  out.kopf = briefkopf(t);
  // Lieferant: 1. feste Regel, 2. Gelerntes, 3. Stammdaten-Name im Text, 4. Briefkopf (neuer Lieferant)
  if (P && P.lief) out.lief = P.lief;
  if (!out.lief) { const hit = Object.entries(LERN.alias).sort((a, b) => b[0].length - a[0].length).find(([k]) => flatA.includes(k)); if (hit) { out.lief = hit[1]; out.gelernt = true } }
  if (!out.lief) { const k = liefKurz(t); if (k) out.lief = k }
  if (!out.lief) { const hit = SD.lief.filter(l => l.length >= 3).sort((a, b) => b.length - a.length).find(l => new RegExp('(^|[^a-zäöüß])' + l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-zäöüß])').test(low)); if (hit) out.lief = hit }
  if (!out.lief && out.kopf) { const k = liefKurz(out.kopf); if (k) out.lief = k; else { out.lief = out.kopf; out.liefNeu = true } }
  // Material aus Stammdaten (Asphaltsorte, Materialnummer oder Name, auch unscharf)
  let best = null; { const s = asphaltSorte(t); if (s) best = { m: [s.mat, s.matnr, s.einh, 'Asphalt'], s: 90 } } const ohneSD = P && (P.chips || P.nurProfil || P.nurMat);
  if (!ohneSD) for (const m of SD.mat) {
    if (m[1] && /^\d{4,}$/.test(m[1]) && new RegExp('\\b' + m[1] + '\\b').test(t)) { best = { m, s: 100 }; break }
    const n = m[0].toLowerCase().replace(/\s+/g, ''); if (n.length >= 8 && flat.includes(n) && (!best || n.length > best.s)) best = { m, s: n.length };
  }
  if (!best && !ohneSD) for (const m of SD.mat) {
    const n = m[0].toLowerCase().replace(/\s+/g, ''); if (n.length < 8) continue; const max = Math.max(1, Math.floor(n.length * 0.15));
    for (let i = 0; i + n.length <= flat.length + 1; i++) { if (flat[i] !== n[0] && flat[i + 1] !== n[1]) continue; const d = levD(flat.substr(i, n.length), n, max); if (d <= max && (!best || n.length - d > best.s)) { best = { m, s: n.length - d }; break } }
  }
  // Gelernte Materialien dieses Lieferanten im Text?
  if (!best && out.lief) { const lm = lernMat(out.lief).find(n => n.length >= 5 && flat.includes(n.toLowerCase().replace(/\s+/g, ''))); if (lm) { const sm = SD.mat.find(x => x[0] === lm); best = { m: sm || [lm, '', (LERN.lief[out.lief] || {}).einh || '', ''], s: 50 } } }
  if (best) { out.mat = best.m[0]; out.matnr = best.m[1]; out.einh = best.m[2]; if ((!out.lief || out.liefNeu) && ['MKB', 'BSR'].includes(best.m[3])) { out.lief = best.m[3]; out.liefNeu = false } }
  // allgemeine Regeln
  const g = generischLesen(t);
  if (g.ls) out.ls = g.ls; else { const x = t.match(/\b(\d{2}-\d{2}-\d{4,6})\b/); if (x) out.ls = x[1] }
  if (g.menge != null) out.menge = g.menge;
  if (!out.mat && g.mat) out.mat = g.mat;
  if (g.einh && !out.einh) out.einh = g.einh;
  if (g.miete) { out.miete = true; out.einh = 'Std'; out.profilName = 'Rapport / Regie (Miete)'; if (g.mat) out.mat = g.mat; else if (best && !MIETE.includes(out.mat)) delete out.mat; if (g.menge == null) delete out.menge }
  // Lieferanten-Regeln haben Vorrang
  if (P) {
    out.profil = P.id; out.profilName = P.name; out.miete = !!P.miete;
    const o = P.lese(t);
    if (P.nurProfil) { delete out.ls; delete out.menge; delete out.mat }
    for (const k of ['ls', 'menge', 'mat', 'matnr', 'einh', 'pos', 'lsUnsicher']) if (o[k] != null && o[k] !== '') out[k] = o[k];
    if (P.miete) { out.einh = 'Std'; if (!o.mat) delete out.mat; if (o.menge == null) delete out.menge; out.matnr = '' }
    else if (!out.einh) out.einh = o.einh || P.einh;
    if (o.mat && !o.matnr) { const sm = SD.mat.find(x => x[0].toLowerCase() === String(o.mat).toLowerCase()); out.matnr = sm ? sm[1] : ''; if (sm) out.einh = o.einh || sm[2] }
  }
  // Gelerntes je Lieferant: Einheit / Miete
  const L = out.lief && LERN.lief[out.lief];
  if (L) { if (!out.einh && L.einh) out.einh = L.einh; if (!P && L.miete > L.n / 2) { out.miete = true; out.einh = 'Std' } }
  const dm = [...t.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{2}|20\d{2})\b/g)].find(x => +x[1] >= 1 && +x[1] <= 31 && +x[2] >= 1 && +x[2] <= 12); if (dm) out.datum = `${dm[3].length === 2 ? '20' + dm[3] : dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
  ['ls', 'menge', 'mat', 'lief'].forEach(k => { if (out[k] != null && out[k] !== '') out.felder.push(k) });
  return out;
}
// Ein oder mehrere Fotos scannen → je Foto ein Lieferschein-Eintrag (bei mehreren Positionen mehrere Einträge)
async function scanLieferscheine(files, zielId, ziel) {
  const r = ziel || S.r; let erkannt = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    overlay(`<div class="spin"></div><b>Lieferschein ${files.length > 1 ? (i + 1) + ' von ' + files.length + ' ' : ''}wird gelesen …</b><p class="small" id="ocrp">Texterkennung wird gestartet${ocrWorker ? '' : ' (beim ersten Mal ca. 10 Sek.)'}</p><p class="small">Gedrehte Fotos werden automatisch erkannt.</p>`);
    let m = zielId ? r.material.find(x => x.id === zielId) : null;
    if (!m) { const l = r.material[r.material.length - 1]; m = { id: uid(), ap: l ? l.ap : r.aps[0].id, lief: '', mat: '', matnr: '', einh: '', ls: '', menge: '', fotos: [] }; r.material.push(m) }
    try {
      m.fotos.push(await fotoKomprimieren(f));
      const { text, res, rot } = await ocrLesen(f, s => { const e = $('#ocrp'); if (e) e.textContent = s });
      if (rot) m.fotos[m.fotos.length - 1] = await fotoDrehen(m.fotos[m.fotos.length - 1], rot);   // Anlage im PDF dann richtig herum
      const auto = [];
      if (res.miete && !res.ls) res.ls = 'Regie ' + dShort(res.datum || r.datum, '.');
      if (res.ls && !m.ls) { m.ls = res.ls; auto.push('ls') }
      if (res.menge && !num(m.menge)) { m.menge = res.menge; auto.push('menge') }
      if (res.mat && !m.mat) { m.mat = res.mat; m.matnr = res.matnr || ''; auto.push('mat') }
      if (res.einh && (!m.einh || res.miete)) m.einh = res.einh;
      if (res.lief && !m.lief) { m.lief = res.lief; auto.push('lief') }
      const prev = r.material.filter(x => x.id !== m.id && x.mat && x.lief === m.lief).pop();
      if (prev && !m.mat && !res.miete) { m.mat = prev.mat; m.matnr = prev.matnr; m.einh = prev.einh; auto.push('mat~') }
      const lm = m.lief ? lernMat(m.lief) : [];
      if (!m.mat && !res.miete && lm.length) { const sm = SD.mat.find(x => x[0] === lm[0]); m.mat = lm[0]; m.matnr = sm ? sm[1] : ''; if (!m.einh) m.einh = (LERN.lief[m.lief] || {}).einh || (sm ? sm[2] : ''); auto.push('mat^') }
      if (!m.lief) { const p2 = r.material.filter(x => x.id !== m.id && x.lief).pop(); if (p2) { m.lief = p2.lief; auto.push('lief~') } }
      const P = LS_PROFILE.find(p => p.id === res.profil);
      const chips = P && P.chips ? P.chips() : res.miete ? mietChips() : lm.length > 1 ? lm.slice(0, 6).map(n => { const sm = SD.mat.find(x => x[0] === n); return [n, n, sm ? sm[2] : ((LERN.lief[m.lief] || {}).einh || '')] }) : null;
      m.ocr = { auto, text: text.slice(0, 2500), datum: res.datum || '', profil: res.profilName || (res.gelernt ? m.lief + ' (gelernt)' : res.liefNeu ? 'Neuer Lieferant: ' + res.lief : ''), chips, miete: !!res.miete, kopf: res.kopf || '', liefNeu: !!res.liefNeu };
      // weitere Positionen (z. B. Muffenrohr) als eigene Einträge, Foto nur beim ersten
      (res.pos || []).slice(1).forEach(ps => r.material.push({ id: uid(), ap: m.ap, lief: m.lief, mat: ps.mat, matnr: ps.matnr || '', einh: ps.einh || '', ls: m.ls, menge: ps.menge, fotos: [], ocr: { auto: ['mat', 'menge', 'ls'], text: '', datum: res.datum || '', profil: (res.profilName || '') + ' – weitere Position', chips: null } }));
      if (res.felder.length) erkannt++;
    } catch (e) { console.error(e); m.ocr = { auto: [], text: '', fehler: String(e.message || e) } }
    zielId = null; saveDraft();
  }
  closeOverlay(); render();
  toast(erkannt ? `${erkannt} von ${files.length} Lieferschein(en) erkannt – gelb markierte Felder bitte prüfen` : 'Text nicht sicher erkannt – bitte Felder ausfüllen', 4000);
}
async function fotoDrehen(src, rot) {
  const im = new Image(); im.src = src; await im.decode();
  const c = document.createElement('canvas'); if (rot % 180) { c.width = im.height; c.height = im.width } else { c.width = im.width; c.height = im.height }
  const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 180); x.drawImage(im, -im.width / 2, -im.height / 2);
  const u = c.toDataURL('image/jpeg', 0.72); c.width = c.height = 0; return u;
}
async function fotoKomprimieren(f) {
  const bmp = await createImageBitmap(f); const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); if (bmp.close) bmp.close();
  const u = c.toDataURL('image/jpeg', 0.72); c.width = c.height = 0; return u;
}
function ocrVorladen() { if (!navigator.onLine) return; ['worker.min.js', 'deu.traineddata.gz', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'].forEach(f => fetch('vendor/tesseract/' + f).catch(() => { })) }

// ---------------------------------------------------------------- Vorlage aus älterem Bericht
// Stunden aus einem anderen Bericht auf die Arbeitspakete des aktuellen Berichts übertragen (gleiche AP-Nr., sonst gleiche Position)
function stundenUebertragen(hAlt, apsAlt, apsNeu) {
  const out = {};
  Object.entries(hAlt || {}).forEach(([id, v]) => {
    if (!num(v)) return; const i = apsAlt.findIndex(a => a.id === id); if (i < 0) return;
    const ziel = apsNeu.find(a => a.nr && a.nr === apsAlt[i].nr) || apsNeu[i] || apsNeu[apsNeu.length - 1];
    if (ziel) out[ziel.id] = (out[ziel.id] || 0) + num(v);
  });
  return out;
}
function vorlageAus(h, nurKolonne) {
  h = clone(h);
  if (nurKolonne) {
    const r = S.r; let n = 0;
    h.personal.forEach(p => { if (!r.personal.some(x => x.name === p.name)) { r.personal.push({ id: uid(), name: p.name, nr: p.nr, zus: '', h: p.zus ? {} : stundenUebertragen(p.h, h.aps, r.aps), neu: p.neu }); n++ } });
    h.geraete.forEach(g => { if (!r.geraete.some(x => x.name === g.name)) r.geraete.push({ id: uid(), name: g.name, nr: g.nr, ks: g.ks, firma: g.firma || '', h: stundenUebertragen(g.h, h.aps, r.aps) }) });
    saveDraft(); render(); toast(`${n} Mitarbeiter und ${h.geraete.length} Geräte mit Stunden übernommen – bitte prüfen`, 4000); return;
  }
  const n = neuerBericht();
  Object.assign(n, { baunr: h.baunr, baustelle: h.baustelle, bauteil: h.bauteil, bauherr: h.bauherr, beginn: h.beginn, ende: h.ende, pause: h.pause,
    aps: h.aps.map(a => ({ id: a.id, nr: a.nr, text: a.text })),
    personal: h.personal.map(p => ({ id: uid(), name: p.name, nr: p.nr, zus: '', h: p.zus ? {} : Object.assign({}, p.h), neu: p.neu })),
    geraete: h.geraete.map(g => ({ id: uid(), name: g.name, nr: g.nr, ks: g.ks, firma: g.firma || '', h: Object.assign({}, g.h) })) });
  S.r = n; S.step = 0; S.view = 'erfassung'; saveDraft(); render(); scrollTo(0, 0);
  toast(`Vorlage ${h.baunr} vom ${dateDe(h.datum)}: Baustelle, Pakete, Kolonne, Geräte und Stunden übernommen – bitte prüfen`, 4500);
}
function histPicker(titel, cb) {
  const el = document.createElement('div'); el.className = 'sheet';
  el.innerHTML = `<div class="in"><div class="top"><div class="prow"><b style="font-size:18px">${titel}</b><button class="btn small" data-close>✕</button></div><input type="search" placeholder="Suchen … Baustellen-Nr., Ort oder Datum" autocomplete="off"></div><div class="list"></div></div>`;
  document.body.appendChild(el); const inp = el.querySelector('input'), list = el.querySelector('.list');
  const draw = () => {
    const q = inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    list.innerHTML = HIST.filter(h => { const hay = `${h.baunr} ${h.baustelle} ${h.bauteil} ${dateDe(h.datum)} ${h.aps.map(a => a.nr + ' ' + a.text).join(' ')}`.toLowerCase(); return q.every(x => hay.includes(x)) })
      .map((h, i) => `<div class="it" data-h="${h.id}"><span><b>${wtag(h.datum)}, ${dateDe(h.datum)}</b> · ${esc(h.baunr)} ${esc(h.baustelle)}<br><small style="white-space:normal">${h.personal.length} Mitarbeiter · ${h.geraete.length} Geräte · AP ${h.aps.map(a => esc(a.nr)).join(', ')}</small></span>${i === 0 && !q.length ? '<small>zuletzt</small>' : ''}</div>`).join('') || '<div class="hint" style="padding:14px">Nichts gefunden.</div>';
  };
  draw(); inp.addEventListener('input', draw);
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) { el.remove(); return } const it = e.target.closest('[data-h]'); if (!it) return; el.remove(); cb(HIST.find(h => h.id === it.dataset.h)) });
}


// ---------------------------------------------------------------- Gesprächsmodus („Telefonat“): App fragt, Polier antwortet per Sprache
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const TEL = { log: [], queue: [], rec: null, listening: false, voice: true, auto: true, mat: false, interim: '' };
function levD(a, b, max) { let prev = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { const cur = [i]; let mn = i; for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < mn) mn = cur[j] } if (mn > max) return max + 1; prev = cur } return prev[b.length] }
const ZW = { null: 0, ein: 1, eins: 1, eine: 1, einen: 1, einer: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, 'fünf': 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, 'zwölf': 12, dreizehn: 13, vierzehn: 14, 'fünfzehn': 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20, 'dreißig': 30, vierzig: 40, 'fünfundvierzig': 45, 'fünfzig': 50 };
function wz(s) {   // Zahlwörter → Ziffern
  s = ' ' + String(s).toLowerCase().replace(/\b(drei|3)\s+viertel/g, 'dreiviertel').replace(/anderthalb|eineinhalb/g, '1.5').replace(/([a-zäöüß]+)einhalb/g, (m, w) => ZW[w] != null ? (ZW[w] + 0.5) : m) + ' ';
  s = s.replace(/(\d+)\s*komma\s*(\d+)/g, '$1.$2').replace(/(\d),(\d)/g, '$1.$2');
  return s.split(/(\s+)/).map(w => ZW[w.replace(/[.,!?]/g, '')] != null ? String(ZW[w.replace(/[.,!?]/g, '')]) : w).join('').replace(/(\d+)\s*komma\s*(\d+)/g, '$1.$2').trim();
}
const ja = a => /^\s*(ja|jo|jap|jawohl|genau|richtig|stimmt|passt|ok|okay|korrekt|klar|sicher|gerne|ja klar|auf jeden)(?![a-zäöüß])/i.test(a);
const nein = a => /^\s*(nein|nee|ne|nö|falsch|nicht|keine?|nichts|negativ|ohne)(?![a-zäöüß])/i.test(a);
const nurNein = a => /^\s*(nein|nee|ne|nö|nichts|keine?|negativ)(\s*,?\s*(danke|nichts|gibt'?s nicht|war nichts))?\s*[.!]?\s*$/i.test(a);
const zahl = a => { const m = wz(a).match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null };
function stunden(a) {
  const s = wz(a); let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:stunden?|h)\s*(?:und)?\s*(\d+)\s*min/))) return +m[1] + m[2] / 60;
  if ((m = s.match(/^\D*(\d+)\s*min/))) return +m[1] / 60;
  let h = zahl(s); if (h == null) return /dreiviertel/.test(s) ? 0.75 : /halbe/.test(s) ? 0.5 : /viertel/.test(s) ? 0.25 : null;
  if (/dreiviertel|drei viertel/.test(s)) h += 0.75; else if (/\bhalb/.test(s) && !/\.\d/.test(String(h))) h += 0.5; else if (/viertel/.test(s)) h += 0.25;
  return h;
}
function uhrzeit(a, ende) {
  const s = wz(a).replace(/uhr/g, ' uhr '); let h = null, m = 0, x;
  if ((x = s.match(/(\d{1,2})[:.](\d{2})/))) { h = +x[1]; m = +x[2] }
  else if ((x = s.match(/halb\s*(\d{1,2})/))) { h = +x[1] - 1; m = 30 }
  else if ((x = s.match(/viertel nach\s*(\d{1,2})/))) { h = +x[1]; m = 15 }
  else if ((x = s.match(/(?:viertel vor|dreiviertel|drei viertel)\s*(\d{1,2})/))) { h = +x[1] - 1; m = 45 }
  else if ((x = s.match(/(\d{1,2})\s*uhr\s*(\d{1,2})/))) { h = +x[1]; m = +x[2] }
  else if ((x = s.match(/(\d{1,2})/))) { h = +x[1] }
  if (h == null || h > 23 || m > 59) return null;
  if (ende && h <= 9) h += 12;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function pause(a) {
  const s = wz(a); if (nein(a) || /keine/.test(s)) return '0:00';
  let min = null;
  if (/dreiviertel/.test(s)) min = 45; else if (/halbe/.test(s)) min = 30; else if (/viertel/.test(s)) min = 15;
  else { const n = zahl(s); if (n != null) min = /stunde/.test(s) || n <= 3 ? n * 60 : n }
  if (min == null) return null;
  return PAUSEN.reduce((b, p) => Math.abs(toMin(p) - min) < Math.abs(toMin(b) - min) ? p : b, PAUSEN[0]);
}
function datumAus(a) {
  const s = wz(a).toLowerCase(), d = new Date(); let x;
  const iso = dt => { dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset()); return dt.toISOString().slice(0, 10) };
  if (/vorgestern/.test(s)) { d.setDate(d.getDate() - 2); return iso(d) }
  if (/gestern/.test(s)) { d.setDate(d.getDate() - 1); return iso(d) }
  if (/heute/.test(s) || ja(a)) return iso(d);
  const tage = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
  const ti = tage.findIndex(t => s.includes(t)); if (ti >= 0) { const diff = (d.getDay() - ti + 7) % 7 || 7; d.setDate(d.getDate() - diff); return iso(d) }
  if ((x = s.match(/(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{2,4})?/))) { const y = x[3] ? (x[3].length === 2 ? '20' + x[3] : x[3]) : d.getFullYear(); return `${y}-${x[2].padStart(2, '0')}-${x[1].padStart(2, '0')}` }
  return null;
}
const STOPW = new Set(['und', 'ohne', 'dazu', 'plus', 'auch', 'noch', 'war', 'ist', 'hat', 'der', 'die', 'das', 'mit', 'krank', 'urlaub', 'schlechtwetter', 'sonderurlaub', 'feiertag', 'schule', 'stunden', 'stunde', 'nicht', 'fehlt', 'heute', 'nur', 'bis', 'uhr', 'ab', 'den', 'dem', 'wie', 'gestern', 'zuletzt', 'letztes', 'mal', 'halb', 'viertel', 'dreiviertel', 'einhalb', 'minuten', 'grad', 'ja', 'nein', 'genau', 'richtig', 'okay'].concat(Object.keys(ZW)));
function personenAus(text) {   // erkennt Mitarbeiter (Nachname, ggf. mit Vorname); unbekannte „Nachname Vorname“ → neu
  const tok = String(text).split(/[^A-Za-zÄÖÜäöüß-]+/).filter(Boolean), low = tok.map(x => x.toLowerCase()), out = [], used = new Set();
  const sur = m => m[0].toLowerCase().split(',')[0].trim(), vor = m => (m[0].toLowerCase().split(',')[1] || '').trim();
  const istName = k => k >= 0 && k < tok.length && low[k].length >= 3 && !STOPW.has(low[k]) && !SD.ma.some(m => sur(m) === low[k]);
  const add = m => { if (!out.some(o => o[0] === m[0])) out.push(m) };
  low.forEach((w, i) => {
    if (w.length < 3 || STOPW.has(w) || used.has(i)) return;
    let C = SD.ma.filter(m => sur(m) === w), fuzzy = false;
    if (!C.length && w.length >= 5) { C = SD.ma.filter(m => sur(m).length >= 5 && levD(w, sur(m), 1) <= 1); fuzzy = true; if (C.length > 1) return }
    if (!C.length) return;
    const nb = [i + 1, i - 1].find(k => istName(k) && !used.has(k));
    if (nb != null) {
      const c = C.find(m => vor(m).split(/\s+/).includes(low[nb]));
      if (c) { add(c); used.add(nb) }
      else if (!fuzzy) { const a = tok[i][0].toUpperCase() + tok[i].slice(1), b = tok[nb][0].toUpperCase() + tok[nb].slice(1); add([`${a}, ${b}`, '', '', 'neu']); used.add(nb) }
      else add(C[0]);
    } else add(C[0]);
    used.add(i);
  });
  return out;
}
const neuP = m => ({ id: uid(), name: m[0], nr: m[1] || '', zus: '', h: {}, neu: !SD.ma.some(x => x[0] === m[0]) });
function geraeteAus(text) {
  const out = [];
  wz(text).toLowerCase().split(/,|\bund\b|\bsowie\b/).forEach(seg => {
    const nums = seg.match(/\d{3,5}/g) || [], tok = seg.split(/[^a-z0-9äöüß]+/).filter(t => t.length >= 2);
    let best = null;
    SD.ge.forEach(g => {
      const n = g[0].toLowerCase(); let sc = 0;
      if (nums.some(x => n.includes(x) || g[2] === x || g[1] === x)) sc += 10;
      n.split(/[^a-z0-9äöüß]+/).filter(t => t.length >= 2 && t !== 'div').forEach(t => { if (tok.includes(t)) sc++ });
      if ((sc >= 2 || (sc === 1 && tok.some(t => t.length >= 5 && n.includes(t)))) && (!best || sc > best.sc)) best = { g, sc };
    });
    if (best && !out.includes(best.g)) out.push(best.g);
  });
  return out;
}
const KZ = [[/sonderurlaub/, 'SU'], [/urlaub/, 'Ur'], [/krank/, 'Kr'], [/schlecht\s*wetter/, 'SW'], [/feiertag/, 'FE'], [/schule|fortbildung|unterweisung|lehrgang/, 'FU']];
const namenListe = l => l.map(p => (p.name || p[0]).split(',')[0]).join(', ');
function verteilen(r, std) {   // Stunden auf die Pakete im gleichen Verhältnis wie TEL.split
  const sp = TEL.split || {}; const sum = Object.values(sp).reduce((a, b) => a + b, 0) || 1; const h = {}; let rest = std;
  r.aps.forEach((a, i) => { const v = i === r.aps.length - 1 ? rest : Math.round(std * (sp[a.id] || 0) / sum * 4) / 4; h[a.id] = Math.max(0, v); rest -= v });
  return h;
}

function apParse(a) {   // „AP 10, Planie hergestellt“ / „zehn Planie …“ → {nr, text} mit Original-Schreibweise
  const tok = a.trim().split(/\s+/); const i = tok.findIndex(x => /^\d+[,.:]?$/.test(wz(x.replace(/[,.:]$/, ''))));
  if (i < 0 || i > 3) return null; const nr = wz(tok[i].replace(/[,.:]$/, '')).replace(/\D/g, '');
  let text = tok.slice(i + 1).join(' ').replace(/^[,.:\-\s]+/, '').trim(); if (!nr || !text) return null;
  return { nr, text: text.charAt(0).toUpperCase() + text.slice(1) };
}
// Ablauf des Gesprächs: jede Frage mit Auswertung der Antwort
function telAblauf() {
  const r = S.r, H = HIST[0], Q = [];
  const q = (id, ask, handle) => Q.push({ id, ask, handle });
  if (H) q('vorlage', () => `Hallo${SET.polier ? ' ' + SET.polier.split(',').reverse().join(' ').trim() : ''}. Soll ich den letzten Bericht als Vorlage nehmen? Baustelle ${H.baunr}, ${H.baustelle}.`, a => {
    if (ja(a)) { Object.assign(r, { baunr: H.baunr, baustelle: H.baustelle, bauteil: H.bauteil, bauherr: H.bauherr, beginn: H.beginn, ende: H.ende, pause: H.pause, aps: H.aps.map(x => ({ id: x.id, nr: x.nr, text: x.text })), personal: H.personal.map(p => ({ id: uid(), name: p.name, nr: p.nr, zus: '', h: {} })), geraete: H.geraete.map(g => ({ id: uid(), name: g.name, nr: g.nr, ks: g.ks, firma: g.firma || '', h: {} })) }); TEL.vorlage = true }
    return true;
  });
  q('datum', () => `${H ? '' : 'Hallo. '}Ist der Bericht für heute?`, a => { const d = datumAus(a); if (d) { r.datum = d; return true } if (nein(a)) return 'Für welchen Tag dann? Zum Beispiel gestern oder Montag.'; return 'Das habe ich nicht verstanden. Für welchen Tag ist der Bericht?' });
  if (!r.von) q('polier', () => 'Wie heißt du?', a => { const p = personenAus(a); if (p.length) { r.von = p[0][0]; return true } return 'Den Namen finde ich nicht in der Liste. Bitte nur den Nachnamen.' });
  q('baustelle', () => TEL.vorlage ? `Baustelle ${r.baunr}, ${r.baustelle}. Stimmt das?` : 'Welche Baustelle? Sag die Baustellen-Nummer.', a => {
    if (TEL.vorlage && ja(a)) return true;
    const n = (wz(a).replace(/(\d)[\s.]+(?=\d)/g, '$1').match(/\d{3,6}(?:\s?[a-z](?![a-zäöüß]))?/i) || [])[0]?.replace(/\s/g, ''); const nn = n ? [n] : null; if (!nn) return 'Bitte die Baustellen-Nummer, zum Beispiel 2 6 0 2 5.';
    r.baunr = nn[0]; const h = HIST.find(x => x.baunr === r.baunr);
    if (h) { r.baustelle = h.baustelle; r.bauteil = h.bauteil; r.bauherr = h.bauherr; TEL.say = `${h.baustelle}.` }
    else { r.baustelle = ''; Q.splice(Q.indexOf(TEL.cur) + 1, 0, { id: 'bsname', ask: () => 'Die Baustelle kenne ich noch nicht. Wo ist sie, Ort und Auftraggeber?', handle: a => { r.baustelle = a.trim(); return true } }, { id: 'bauherr', ask: () => 'Wer ist der Bauherr? Wenn unklar, sag nein.', handle: a => { if (!nein(a)) r.bauherr = a.trim(); return true } }) }
    return true;
  });
  q('wetter', () => 'Wie ist das Wetter und wie viel Grad hat es?', a => {
    const s = a.toLowerCase(); const w = SD.wetter.find(x => s.includes(x.toLowerCase())) || (/sonne/.test(s) && SD.wetter.find(x => /sonn/i.test(x))) || (/wolk|bewölkt/.test(s) && SD.wetter.find(x => /bedeckt|bewölkt|wolk/i.test(x))) || (/regen|regnet/.test(s) && SD.wetter.find(x => /regen/i.test(x)));
    if (w) r.wetter = w; const t = s.match(/(minus\s*)?(-?\d+)\s*(grad|°)?/) || wz(s).match(/(minus\s*)?(-?\d+)/); if (t) r.temp = String((t[1] ? -1 : 1) * Math.abs(+t[2]));
    if (!r.wetter) return `Und welches Wetter? Zum Beispiel ${SD.wetter.slice(0, 3).join(', ')}.`;
    return true;
  });
  q('beginn', () => TEL.vorlage ? `Arbeitszeit wie zuletzt, von ${r.beginn} bis ${r.ende}, Pause ${r.pause}? Oder wann war Arbeitsbeginn?` : 'Wann war Arbeitsbeginn?', a => {
    if (TEL.vorlage && ja(a)) { TEL.skipZeit = true; return true }
    const t = uhrzeit(a, false); if (!t) return 'Bitte die Uhrzeit, zum Beispiel sieben Uhr.'; r.beginn = t; return true;
  });
  q('ende', () => TEL.skipZeit ? '' : 'Und wann war Feierabend?', a => { const t = uhrzeit(a, true); if (!t) return 'Bitte die Uhrzeit, zum Beispiel halb fünf.'; r.ende = t; return true });
  q('pause', () => TEL.skipZeit ? '' : 'Wie lange Pause?', a => { const p = pause(a); if (!p) return 'Wie viele Minuten Pause?'; r.pause = p; TEL.say = `Das sind ${fmt(dauer(r))} Stunden.`; return true });
  q('aps', () => TEL.vorlage && !TEL.apsNeu && r.aps.some(a => a.nr) ? `Arbeitspakete wie zuletzt: ${r.aps.map(a => 'AP ' + a.nr + ', ' + a.text).join('. ')}. Stimmt das?` : 'Was habt ihr heute gemacht? Sag zuerst die AP-Nummer und dann die Arbeit.', a => {
    if (TEL.vorlage && !TEL.apsNeu && r.aps.some(x => x.nr)) { if (ja(a)) return true; r.aps = []; TEL.apsNeu = true; return 'Gut, dann neu. Sag die AP-Nummer und die Arbeit.' }
    const m = apParse(a); if (!m) return 'Bitte so: AP-Nummer, dann was gemacht wurde. Zum Beispiel: 10, Planie hergestellt.';
    if (!r.aps.length || r.aps[0].nr || r.aps[0].text) r.aps.push({ id: uid(), nr: '', text: '' }); const ap = r.aps[r.aps.length - 1]; ap.nr = m.nr; ap.text = m.text;
    Q.splice(Q.indexOf(TEL.cur) + 1, 0, { id: 'apmehr', ask: () => 'Noch ein Arbeitspaket?', handle: b => { if (nein(b) || r.aps.length >= 7) return true; if (ja(b) && b.trim().split(/\s+/).length < 3) { TEL.cur.ask = () => 'Welche AP-Nummer und welche Arbeit?'; return 'Welche AP-Nummer und welche Arbeit?' } const x = apParse(b.replace(/^\s*(ja|jo|genau)[,.!]?\s*/i, '')); if (!x) return 'Bitte AP-Nummer und Arbeit, oder nein.'; r.aps.push({ id: uid(), nr: x.nr, text: x.text }); return r.aps.length >= 7 ? true : 'Notiert. Noch ein Arbeitspaket?' } });
    return true;
  });
  q('kolonne', () => TEL.vorlage && r.personal.length ? `Kolonne wie zuletzt: ${namenListe(r.personal)}. Stimmt das?` : `Wer war heute dabei?${HIST.length ? ' Du kannst auch sagen: wie letztes Mal.' : ''}`, a => {
    if (TEL.vorlage && r.personal.length && ja(a)) return true;
    if (/wie (gestern|letztes|zuletzt|immer)|gleiche/i.test(a) && H) { r.personal = H.personal.map(p => ({ id: uid(), name: p.name, nr: p.nr, zus: '', h: {} })); TEL.say = `Übernommen: ${namenListe(r.personal)}.`; return true }
    const p = personenAus(a); const ohne = /ohne|nicht|fehlt|weg/i.test(a);
    if (!p.length) { const kol = TEL.cur; const nm = a.replace(/^(dazu|plus|auch|noch)\s+/i, '').trim(); if (nm.split(/\s+/).length <= 3 && !ohne) { Q.splice(Q.indexOf(TEL.cur), 0, { id: 'neuma', ask: () => `${nm} finde ich nicht in der Liste. Als neuen Mitarbeiter eintragen?`, handle: c => { if (ja(c)) { if (!/dazu|plus|auch|noch/i.test(a)) r.personal = []; r.personal.push({ id: uid(), name: nm, nr: '', zus: '', h: {}, neu: true }); Q.splice(Q.indexOf(TEL.cur) + 1, 0, { id: 'kolok2', ask: () => `Ich habe: ${namenListe(r.personal)}. Noch jemand? Sonst sag nein.`, handle: d => { if (nein(d) || ja(d) && d.trim().split(/\s+/).length < 2) return true; const pp = personenAus(d); pp.forEach(m => { if (!r.personal.some(x => x.name === m[0])) r.personal.push(neuP(m)) }); if (!pp.length) r.personal.push({ id: uid(), name: d.replace(/^(dazu|plus|und)\s+/i, '').trim(), nr: '', zus: '', h: {}, neu: true }); return `Jetzt: ${namenListe(r.personal)}. Noch jemand?` } }); } else Q.splice(Q.indexOf(TEL.cur) + 1, 0, kol); return true } }); return true } return 'Ich habe keinen Namen erkannt. Bitte die Nachnamen nennen.' }
    const neu = m => neuP(m);
    if (ohne && r.personal.length) r.personal = r.personal.filter(x => !p.some(m => m[0] === x.name));
    else if (/dazu|plus|auch|noch/i.test(a)) p.forEach(m => { if (!r.personal.some(x => x.name === m[0])) r.personal.push(neu(m)) });
    else r.personal = p.map(neu);
    Q.splice(Q.indexOf(TEL.cur) + 1, 0, { id: 'kolok', ask: () => `Ich habe: ${namenListe(r.personal)}. Stimmt das?`, handle: b => { if (ja(b)) return true; const pp = personenAus(b); if (!pp.length) return 'Wen soll ich ergänzen oder streichen? Zum Beispiel: ohne Braun, oder: dazu Hagel.'; if (/ohne|nicht|weg|streich/i.test(b)) r.personal = r.personal.filter(x => !pp.some(m => m[0] === x.name)); else pp.forEach(m => { if (!r.personal.some(x => x.name === m[0])) r.personal.push(neuP(m)) }); return `Jetzt: ${namenListe(r.personal)}. Stimmt das?` } });
    return true;
  });
  q('abwesend', () => 'War jemand krank, im Urlaub oder Schlechtwetter?', a => {
    if (nein(a)) return true;
    let n = 0; a.toLowerCase().split(/,|\bund\b/).forEach(seg => { const k = KZ.find(([re]) => re.test(seg)); const p = personenAus(seg); if (k && p.length) p.forEach(m => { let x = r.personal.find(y => y.name === m[0]); if (!x) { x = neuP(m); r.personal.push(x) } x.zus = k[1]; x.h = {}; n++ }) });
    if (!n) return 'Bitte so: Name und Grund, zum Beispiel: Spatafora Schlechtwetter. Oder nein.';
    return true;
  });
  q('stunden', () => !r.aps.length || !r.personal.length ? '' : r.aps.length > 1 ? `Wie viele Stunden auf AP ${r.aps[0].nr}?` : `Alle ${fmt(dauer(r))} Stunden auf AP ${r.aps[0] && r.aps[0].nr}?`, a => {
    const d = dauer(r);
    if (r.aps.length === 1) { if (!ja(a)) { const h = stunden(a); if (h == null) return 'Wie viele Stunden?'; TEL.std = h } else TEL.std = d; TEL.split = { [r.aps[0].id]: 1 } }
    else {
      const h = stunden(a); if (h == null) return `Wie viele Stunden auf AP ${r.aps[0].nr}?`; TEL.split = { [r.aps[0].id]: h };
      r.aps.slice(1, -1).forEach(ap => Q.splice(Q.indexOf(TEL.cur) + 1 + r.aps.indexOf(ap) - 1, 0, { id: 'std' + ap.id, ask: () => `Und auf AP ${ap.nr}?`, handle: b => { const x = stunden(b); if (x == null) return `Wie viele Stunden auf AP ${ap.nr}?`; TEL.split[ap.id] = x; return true } }));
      TEL.std = d;
    }
    return true;
  });
  q('stdfertig', () => { if (!r.aps.length || !r.personal.length) return ''; if (!TEL.split) TEL.split = { [r.aps[0].id]: 1 }; if (TEL.std == null) TEL.std = dauer(r); const last = r.aps[r.aps.length - 1]; if (r.aps.length > 1) { const used = r.aps.slice(0, -1).reduce((s, a) => s + (TEL.split[a.id] || 0), 0); TEL.split[last.id] = Math.max(0, dauer(r) - used) } r.personal.forEach(p => { if (!p.zus) p.h = verteilen(r, TEL.std) }); return `${r.aps.length > 1 ? 'Rest auf AP ' + last.nr + '. ' : ''}Hat jemand abweichende Stunden? Zum Beispiel: Mustermann 8 Stunden. Sonst nein.` }, a => {
    if (nein(a)) return true; const p = personenAus(a), h = stunden(a.replace(/^[^\d]*?(?=\d|(?:^|\s)(?:ein|eine|einer|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|halbe?|dreiviertel)(?![a-zäöüß]))/i, ''));
    if (!p.length || h == null) return 'Bitte Name und Stunden, oder nein.';
    p.forEach(m => { const x = r.personal.find(y => y.name === m[0]); if (x) { x.zus = ''; x.h = verteilen(r, h) } });
    return `${namenListe(p)}: ${fmt(h)} Stunden. Noch jemand?`;
  });
  q('geraete', () => TEL.vorlage && r.geraete.length ? `Geräte wie zuletzt: ${r.geraete.map(g => g.name).join(', ')}. Stimmt das?` : 'Welche Geräte waren im Einsatz? Sonst sag keine.', a => {
    if (TEL.vorlage && r.geraete.length && ja(a)) return true;
    if (nein(a)) { r.geraete = []; return true }
    if (/wie (gestern|letztes|zuletzt)/i.test(a) && H) { r.geraete = H.geraete.map(g => ({ id: uid(), name: g.name, nr: g.nr, ks: g.ks, firma: g.firma || '', h: {} })); return true }
    const g = geraeteAus(a); if (!g.length) return 'Gerät nicht gefunden. Sag den Namen mit Nummer, zum Beispiel: Walze BW 100, 6923.';
    r.geraete = g.map(x => ({ id: uid(), name: x[0], nr: x[1], ks: x[2], firma: '', h: {} })); TEL.say = `Ich habe: ${r.geraete.map(x => x.name).join(', ')}.`;
    return true;
  });
  q('gerstd', () => r.geraete.length ? 'Liefen alle Geräte genauso lange wie die Kolonne?' : '', a => {
    if (!r.geraete.length) return true;
    if (ja(a)) { r.geraete.forEach(g => g.h = verteilen(r, TEL.std || dauer(r))); return true }
    r.geraete.forEach(g => g.h = verteilen(r, TEL.std || dauer(r)));
    r.geraete.slice().reverse().forEach(g => Q.splice(Q.indexOf(TEL.cur) + 1, 0, { id: 'g' + g.id, ask: () => `Wie viele Stunden lief ${g.name}?`, handle: b => { const h = nein(b) ? 0 : stunden(b); if (h == null) return 'Wie viele Stunden?'; g.h = verteilen(r, h); return true } }));
    return true;
  });
  q('mat', () => 'Gab es heute Lieferscheine? Die fotografierst du gleich danach.', a => { TEL.mat = !nein(a); return true });
  q('bem', () => 'Bemerkungen oder abweichende Arbeitszeiten? Sonst nein.', a => { if (!nurNein(a)) r.bem = a.trim(); return true });
  q('vork', () => 'Wichtige Vorkommnisse oder Besprechungen fürs Bautagebuch? Sonst nein.', a => { if (!nurNein(a)) r.vork = a.trim(); return true });
  return Q;
}
function telStart() {
  if (!S.r || S.r._gesendet) S.r = neuerBericht();
  TEL.log = []; TEL.vorlage = false; TEL.apsNeu = false; TEL.skipZeit = false; TEL.mat = false; TEL.split = null; TEL.std = null; TEL.queue = telAblauf();
  S.view = 'telefon'; render(); telNext();
}
async function telNext() {
  if (S.view !== 'telefon') return;
  let q = TEL.queue[0];
  while (q) { TEL.cur = q; const t = q.ask(); if (t) { TEL.frage = t; break } TEL.queue.shift(); q = TEL.queue[0] }
  if (!q) return telEnde();
  const pre = TEL.say ? TEL.say + ' ' : ''; TEL.say = '';
  telBot(pre + TEL.frage);
}
async function telBot(text) {
  TEL.log.push({ bot: true, t: text }); telRender();
  await sag(text);
  if (S.view === 'telefon' && TEL.auto && SR) hoeren();
}
function telAntwort(text) {
  text = String(text || '').trim(); if (!text || S.view !== 'telefon') return;
  stopHoeren(); TEL.log.push({ bot: false, t: text }); TEL.interim = '';
  if (/^\s*(beenden|abbrechen|stopp|stop|schluss|ende)\s*[.!]?\s*$/i.test(text)) return telEnde(true);
  if (/^(überspringen|weiter|nächste)\b/i.test(text)) { TEL.queue.shift(); saveDraft(); return telNext() }
  if (/^(wiederholen|nochmal|wie bitte)\b/i.test(text)) return telBot(TEL.frage);
  const q = TEL.cur; let res;
  try { res = q.handle(text) } catch (e) { console.error(e); res = 'Das hat nicht geklappt. Bitte nochmal.' }
  saveDraft();
  if (res === true) { TEL.queue.splice(TEL.queue.indexOf(q), 1); telNext() }
  else { TEL.frage = res; telBot(res) }
}
async function telEnde(abbruch) {
  stopHoeren(); try { speechSynthesis.cancel() } catch (e) { }
  const r = S.r; if (!r.aps.length) r.aps.push({ id: uid(), nr: '', text: '' });
  saveDraft(); S.view = 'erfassung'; S.step = TEL.mat ? 4 : 5; render(); scrollTo(0, 0);
  const t = abbruch ? 'Gespräch beendet. Du kannst im Formular weitermachen.' : TEL.mat ? 'Danke. Fotografiere jetzt die Lieferscheine, dann unterschreiben und senden.' : 'Danke, alles eingetragen. Bitte prüfen, unterschreiben und senden.';
  toast(t, 5000); sag(t);
}
function sag(text) {
  return new Promise(res => {
    if (!TEL.voice || !('speechSynthesis' in window)) return res();
    try {
      speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text.replace(/AP (\d)/g, 'A P $1')); u.lang = 'de-DE'; u.rate = 1.05;
      const v = speechSynthesis.getVoices().find(v => /^de/i.test(v.lang)); if (v) u.voice = v;
      let done = false; const fin = () => { if (!done) { done = true; res() } }; u.onend = fin; u.onerror = fin; setTimeout(fin, 4000 + text.length * 90);
      speechSynthesis.speak(u);
    } catch (e) { res() }
  });
}
function hoeren() {
  if (!SR || TEL.listening) return;
  try {
    const rec = new SR(); TEL.rec = rec; rec.lang = 'de-DE'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let final = '';
    rec.onresult = e => { let it = ''; for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) final += e.results[i][0].transcript; else it += e.results[i][0].transcript } TEL.interim = final + it; const el = $('#interim'); if (el) el.textContent = TEL.interim };
    rec.onerror = e => { TEL.listening = false; if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { TEL.auto = false; toast('Mikrofon nicht erlaubt – bitte über die Tastatur antworten', 4000) } telRender() };
    rec.onend = () => { TEL.listening = false; TEL.rec = null; if (final.trim()) telAntwort(final); else telRender() };
    rec.start(); TEL.listening = true; telRender();
  } catch (e) { TEL.listening = false; telRender() }
}
function stopHoeren() { if (TEL.rec) { try { TEL.rec.onend = null; TEL.rec.abort() } catch (e) { } } TEL.rec = null; TEL.listening = false }
function vTelefon() {
  return `<div id="tellog" class="tellog">${TEL.log.map(l => `<div class="bub ${l.bot ? 'bot' : 'me'}">${esc(l.t)}</div>`).join('')}
  ${TEL.listening ? `<div class="bub me live"><span id="interim">${esc(TEL.interim) || '…'}</span></div>` : ''}</div>`;
}
function telRender() {
  if (S.view !== 'telefon') return;
  $('#main').innerHTML = vTelefon();
  $('#foot').style.display = 'block';
  $('#foot').innerHTML = `<div class="telbar">
   ${SR ? `<button class="micbtn ${TEL.listening ? 'on' : ''}" data-act="mic" aria-label="Sprechen">${TEL.listening ? '■' : '🎤'}</button>` : ''}
   <form id="telform" style="flex:1;display:flex;gap:6px"><input id="telin" placeholder="${SR ? 'oder hier tippen/diktieren …' : 'Antwort tippen oder 🎤 der Tastatur …'}" autocomplete="off" enterkeyhint="send"><button class="btn small orange" type="submit">➤</button></form></div>
   <div class="row" style="margin-top:6px"><button class="btn small ghost" data-act="telwdh">🔁 Wiederholen</button><button class="btn small ghost" data-act="telskip">⏭ Überspringen</button><button class="btn small ghost" data-act="telvoice">${TEL.voice ? '🔊' : '🔇'}</button><button class="btn small danger" data-act="telende">Beenden</button></div>`;
  $('#telform').onsubmit = e => { e.preventDefault(); const v = $('#telin').value; $('#telin').value = ''; telAntwort(v) };
  const lg = $('#tellog'); if (lg) lg.lastElementChild && lg.lastElementChild.scrollIntoView({ block: 'end' });
}


// ---------------------------------------------------------------- Lieferschein-Liste (eigener Bereich, unabhängig vom Tagesbericht)
// Lieferscheine laufend scannen → fortlaufende Tabelle je Baustelle und Tag mit Tonnage; später in jeden Tagesbericht übernehmbar
let LSL = [];
const LSV = { baunr: '', datum: today(), offen: null };
const lsSpeichern = () => DB.set('lsliste', LSL).catch(() => toast('Speichern fehlgeschlagen – Speicher voll?'));
const lsTag = (b, d) => LSL.filter(e => e.baunr === b && e.datum === d).sort((x, y) => x.zeit - y.zeit);
const EINH_TXT = { to: 't', m3: 'm³', Stk: 'Stk', Std: 'Std' };
function mengenText(list) { const s = {}; list.forEach(e => { const u = e.einh || 'to'; s[u] = (s[u] || 0) + num(e.menge) }); return Object.entries(s).map(([u, v]) => `${fq(v)} ${EINH_TXT[u] || u}`).join(' + ') || '0,00 t' }
const matSummen = list => proMaterial(list).map(([k, l]) => (l[0].mat || 'ohne Material') + ' ' + mengenText(l)).join(' · ') || '0,00 t';
function proMaterial(list) { const g = new Map(); list.forEach(e => { const k = (e.lief || '?') + ' · ' + (e.mat || 'ohne Material'); if (!g.has(k)) g.set(k, []); g.get(k).push(e) }); return [...g] }
const lsFrei = e => !e.uebernommen;
function vLieferscheine() {
  const bs = [...new Map([...HIST, ...LSL].filter(x => x.baunr).map(x => [x.baunr, x.baustelle || ''])).entries()];
  const tag = lsTag(LSV.baunr, LSV.datum), alle = LSL.filter(e => e.baunr === LSV.baunr);
  const tage = [...new Set(alle.map(e => e.datum))].sort().reverse();
  return `<div class="card">
   <div class="grid2"><div><label style="margin-top:0">Baustellen-Nr.</label>${bnrFeld(`id="ls_bnr" list="ls_bs"`, LSV.baunr, '26025')}</div>
   <div><label style="margin-top:0">Datum</label><input id="ls_dat" type="date" value="${LSV.datum}"></div></div>
   <datalist id="ls_bs">${bs.map(([n, o]) => `<option value="${esc(n)}">${esc(o)}</option>`).join('')}</datalist></div>
  <div class="card" style="background:#fff4ea;border:1.5px solid #f6c89a"><b>📷 Lieferschein scannen</b><p class="hint" style="margin:4px 0 8px">Jeden Lieferschein bei Ankunft fotografieren – die Werte landen sofort in der Tabelle.</p>
   <div class="row"><span class="btn orange fotobtn">📷 Kamera<input type="file" accept="image/*" capture="environment" data-lsscan="1"></span><span class="btn ghost fotobtn">🖼️ Mehrere<input type="file" accept="image/*" multiple data-lsscan="1"></span></div>
   <button class="btn ghost small full" style="margin-top:8px" data-act="lshand">＋ Von Hand eintragen</button></div>
  <div class="card lssum"><div class="small">${wtag(LSV.datum)}, ${dateDe(LSV.datum)}${LSV.baunr ? ' · Baustelle ' + esc(LSV.baunr) : ''} · ${tag.length} Lieferschein(e)</div>
   ${proMaterial(tag).map(([k, l]) => `<div class="lsmat"><span>${esc(k)}<br><small>${l.length} Lieferschein(e)</small></span><b class="lsbig">${mengenText(l)}</b></div>`).join('') || '<div class="lsbig">0,00 t</div>'}
   ${alle.length > tag.length ? `<details class="small" style="margin-top:6px"><summary>Baustelle gesamt (${alle.length} LS · ${tage.length} Tage)</summary>${proMaterial(alle).map(([k, l]) => `<div class="lsmat"><span>${esc(k)}</span><b>${l.length} × · ${mengenText(l)}</b></div>`).join('')}</details>` : ''}</div>
  <div class="card" style="padding:0;overflow:hidden"><table class="lstab"><tr><th>#</th><th>LS-Nr.</th><th>Lieferant / Material</th><th class="r">Menge</th></tr>
   ${proMaterial(tag).map(([k, l]) => `<tr class="lsgrp"><td colspan="3">${esc(k)}</td><td class="r">${mengenText(l)}</td></tr>` + l.map((e, i) => `<tr data-lsedit="${e.id}" class="${e.uebernommen ? 'lsok' : ''} ${e.ocr && e.ocr.auto && e.ocr.auto.length ? 'lsauto' : ''}"><td>${i + 1}</td><td><b>${esc(e.ls) || '–'}</b><div class="small">${new Date(e.zeit).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</div></td><td>${esc(e.lief) || '?'}<div class="small">${esc(e.mat) || '<span style="color:var(--rot)">Material fehlt</span>'}${e.uebernommen ? ' · ✓ im Bericht ' + dShort(e.uebernommen.datum, '.') : ''}</div></td><td class="r"><b>${f2(e.menge) || '–'}</b> ${EINH_TXT[e.einh] || e.einh || ''}</td></tr>
   ${LSV.offen === e.id ? `<tr><td colspan="4" style="background:#fafafa">${lsEditor(e)}</td></tr>` : ''}`).join('')).join('') || `<tr><td colspan="4"><div class="hint" style="padding:10px;text-align:center">Noch keine Lieferscheine für diesen Tag.</div></td></tr>`}
  </table></div>
  ${tage.length > 1 || (tage.length && tage[0] !== LSV.datum) ? `<div class="card"><b>Andere Tage dieser Baustelle</b><div class="lst">${tage.filter(d => d !== LSV.datum).map(d => { const l = lsTag(LSV.baunr, d); return `<div class="it" data-lsday="${d}" style="cursor:pointer"><span>${wtag(d)}, ${dateDe(d)}</span><span class="small">${l.length} LS · ${matSummen(l)}${l.every(e => e.uebernommen) ? ' · ✓' : ''}</span></div>` }).join('')}</div></div>` : ''}
  ${tag.some(lsFrei) ? `<button class="btn orange full" data-act="lsbericht">➜ ${tag.filter(lsFrei).length} Lieferscheine in den Tagesbericht übernehmen</button>` : ''}
  <p class="small" style="text-align:center">Die Liste ist unabhängig vom Tagesbericht. Übernommene Lieferscheine sind mit ✓ markiert.</p>`;
}
function lsEditor(e) {
  return `<div class="grid2"><div><label>Lieferschein-Nr.</label><input data-lsf="${e.id}|ls" value="${esc(e.ls)}"></div><div><label>Menge ${e.einh ? '[' + esc(EINH_TXT[e.einh] || e.einh) + ']' : ''}</label><input data-lsf="${e.id}|menge" inputmode="decimal" value="${e.menge !== '' && e.menge != null ? fmt(num(e.menge)) : ''}"></div></div>
  <div class="grid2"><div><label>Lieferant</label>${pickBtn('lslief|' + e.id, e.lief || 'wählen …')}</div><div><label>Material</label>${pickBtn('lsmat|' + e.id, e.mat || 'wählen …')}</div></div>
  ${e.ocr && e.ocr.chips ? `<div class="chips" style="margin-top:8px">${e.ocr.chips.map((c, i) => `<button class="chip ${e.mat === c[1] ? 'on' : ''}" data-lschip="${e.id}|${i}">${esc(c[0])}</button>`).join('')}</div>` : ''}
  <div class="thumbs">${(e.fotos || []).map(f => `<img src="${f}">`).join('')}</div>
  ${e.ocr && e.ocr.profil ? `<div class="hint">🏷️ ${esc(e.ocr.profil)}</div>` : ''}
  <div class="row" style="margin-top:8px"><button class="btn small ghost" data-lsedit="${e.id}">Fertig</button><button class="btn small danger" data-lsdel="${e.id}">Löschen</button></div>`;
}
async function lsScan(files) {
  if (!LSV.baunr) { toast('Bitte zuerst die Baustellen-Nr. eintragen'); return }
  const tmp = { datum: LSV.datum, aps: [{ id: '_' }], material: lsTag(LSV.baunr, LSV.datum).map(e => Object.assign({}, e)) };
  const vorher = new Set(tmp.material.map(m => m.id));
  await scanLieferscheine(files, null, tmp);
  tmp.material.filter(m => !vorher.has(m.id)).forEach(m => LSL.push({ id: m.id, baunr: LSV.baunr, datum: LSV.datum, zeit: Date.now(), lief: m.lief, mat: m.mat, matnr: m.matnr, einh: m.einh || 'to', ls: m.ls, menge: m.menge, fotos: m.fotos, ocr: m.ocr ? { auto: m.ocr.auto, profil: m.ocr.profil, chips: m.ocr.chips, kopf: m.ocr.kopf } : null }));
  await lsSpeichern(); render();
}
// In den Tagesbericht übernehmen (ausgewählter Tag, nur noch nicht übernommene)
function lsInBericht(r, eintraege, apId) {
  let n = 0; const da = new Set(r.material.map(m => m.lsid));
  eintraege.forEach(e => { if (da.has(e.id) || e.uebernommen) return; r.material.push({ id: uid(), ap: apId || r.aps[0].id, lief: e.lief, mat: e.mat, matnr: e.matnr || '', einh: e.einh || '', ls: e.ls, menge: e.menge, fotos: (e.fotos || []).slice(), lsid: e.id, lsdatum: e.datum }); n++ });
  return n;
}
function lsPicker(r) {
  const gruppen = [...new Map(LSL.map(e => [e.baunr + '|' + e.datum, 1])).keys()].map(k => { const [b, d] = k.split('|'); return { b, d, l: lsTag(b, d) } })
    .sort((x, y) => ((y.b === r.baunr) - (x.b === r.baunr)) || y.d.localeCompare(x.d));
  let apId = r.aps[0].id;
  const el = document.createElement('div'); el.className = 'sheet';
  const draw = () => { el.innerHTML = `<div class="in"><div class="top"><div class="prow"><b style="font-size:18px">Lieferscheine übernehmen</b><button class="btn small" data-close>✕</button></div>
    ${r.aps.length > 1 ? `<div class="small" style="margin-top:6px">Zuordnen zu:</div><div class="chips">${r.aps.map(a => `<button class="chip ${a.id === apId ? 'on' : ''}" data-lsap="${a.id}">AP ${esc(a.nr) || '?'}</button>`).join('')}</div>` : ''}</div>
    <div class="list">${gruppen.map(g => { const frei = g.l.filter(e => lsFrei(e) && !r.material.some(m => m.lsid === e.id)); return `<div class="it" ${frei.length ? `data-lsg="${g.b}|${g.d}"` : ''} style="${frei.length ? '' : 'opacity:.5'}"><span><b>${wtag(g.d)}, ${dateDe(g.d)}</b> · ${esc(g.b)}<br><small style="white-space:normal">${g.l.length} LS · ${matSummen(g.l)} · ${frei.length ? frei.length + ' offen' : 'alle übernommen'}</small></span>${g.d === r.datum && g.b === r.baunr ? '<small>heute</small>' : ''}</div>` }).join('') || '<div class="hint" style="padding:14px">Keine Lieferscheine in der Liste.</div>'}</div></div>` };
  draw(); document.body.appendChild(el);
  el.addEventListener('click', e => {
    if (e.target === el || e.target.closest('[data-close]')) { el.remove(); return }
    const ap = e.target.closest('[data-lsap]'); if (ap) { apId = ap.dataset.lsap; draw(); return }
    const g = e.target.closest('[data-lsg]'); if (!g) return; const [b, d] = g.dataset.lsg.split('|');
    const n = lsInBericht(r, lsTag(b, d), apId); el.remove(); saveDraft(); render();
    toast(`${n} Lieferschein(e) vom ${dateDe(d)} übernommen${d !== r.datum ? ' – im Bericht mit Datum gekennzeichnet' : ''}`, 4000);
  });
}

const behalten = list => list.filter((h, i) => i < 30 || Date.now() - (h.gesendet || 0) < 90 * 864e5).slice(0, 300);   // letzte 90 Tage (mind. 30 Berichte)
// ---------------------------------------------------------------- Daten übertragen (PC ⇄ Handy) per Sync-Datei
const SYNC_KEYS = ['draft', 'draft_sl', 'history', 'slhistory', 'lsliste', 'lernen', 'berufe', 'favoriten', 'haeufig', 'stammdaten', 'settings'];
function syncDialog() {
  overlay(`<b style="font-size:18px">🔄 Daten übertragen</b>
  <p class="small" style="text-align:left">Damit PC und Handy denselben Stand haben:<br>1. Auf dem Gerät mit den neuesten Daten <b>Sync-Datei speichern</b> (z. B. in OneDrive oder per Mail an dich selbst).<br>2. Auf dem anderen Gerät <b>Sync-Datei einlesen</b>.<br>Es wird zusammengeführt, nichts gelöscht: gesendete Berichte, Lieferschein-Liste und Gelerntes von beiden Geräten bleiben erhalten; bei Entwürfen gilt der neuere.</p>
  <button class="btn orange full" data-act="syncexport">💾 Sync-Datei speichern</button>
  <label class="btn ghost full" style="margin-top:8px">📂 Sync-Datei einlesen<input type="file" data-syncimport="1" accept=".json,.txt,application/json,text/plain" hidden></label>
  <button class="btn ghost full" style="margin-top:8px" data-act="ovclose">Schließen</button>`);
}
async function syncExport() {
  flushDraft(); if (S.r) await DB.set(draftKey(S.r), S.r);
  const d = { format: 'schwall-sync', version: 1, app_version: APP_VERSION, erstellt: new Date().toISOString(), polier: SET.polier || '', geraet: /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'PC', daten: {} };
  for (const k of SYNC_KEYS) { const v = await DB.get(k); if (v != null) d.daten[k] = v }
  const st = new Date(), z = n => String(n).padStart(2, '0');
  const name = `Schwall-Sync-${(SET.polier || 'Polier').split(',')[0].replace(/[^A-Za-zÄÖÜäöüß]/g, '')}-${st.getFullYear()}${z(st.getMonth() + 1)}${z(st.getDate())}-${z(st.getHours())}${z(st.getMinutes())}.json`;
  await speichern([new File([JSON.stringify(d)], name, { type: 'application/json' })]);
}
const nachId = (a, b, zeit) => { const m = new Map(); [...(a || []), ...(b || [])].forEach(x => { const o = m.get(x.id); if (!o || (zeit(x) || 0) > (zeit(o) || 0)) m.set(x.id, x) }); return [...m.values()] };
async function syncImport(file) {
  let d; try { d = JSON.parse(await file.text()) } catch (e) { toast('Datei kann nicht gelesen werden'); return }
  if (!d || d.format !== 'schwall-sync') { toast('Das ist keine Sync-Datei der Tagesbericht-App'); return }
  const I = d.daten || {}, L = {}; for (const k of SYNC_KEYS) L[k] = await DB.get(k);
  if (SET.polier && d.polier && d.polier !== SET.polier && !(await bestaetigen(`Die Datei stammt von „${esc(d.polier)}“, hier ist „${esc(SET.polier)}“ eingerichtet. Trotzdem einlesen?`))) return;
  const neu = {};
  neu.history = nachId(L.history, I.history, h => h.gesendet).sort((a, b) => (b.gesendet || 0) - (a.gesendet || 0)); neu.history = behalten(neu.history);
  neu.slhistory = nachId(L.slhistory, I.slhistory, h => h.gesendet).sort((a, b) => (b.gesendet || 0) - (a.gesendet || 0)); neu.slhistory = behalten(neu.slhistory);
  neu.lsliste = nachId(L.lsliste, I.lsliste, e => (e.uebernommen ? 1e13 : 0) + (e.geaendert || e.zeit || 0));
  const li = I.lernen || { alias: {}, lief: {} }, ll = L.lernen || { alias: {}, lief: {} }, lief = Object.assign({}, li.lief);
  Object.entries(ll.lief || {}).forEach(([k, v]) => { if (!lief[k] || (v.n || 0) >= (lief[k].n || 0)) lief[k] = v });
  neu.lernen = { alias: Object.assign({}, li.alias, ll.alias), lief };
  neu.berufe = Object.assign({}, I.berufe, L.berufe);
  neu.favoriten = {}; for (const k of new Set([...Object.keys(I.favoriten || {}), ...Object.keys(L.favoriten || {})])) neu.favoriten[k] = [...new Set([...((L.favoriten || {})[k] || []), ...((I.favoriten || {})[k] || [])])];
  neu.haeufig = {}; for (const k of new Set([...Object.keys(I.haeufig || {}), ...Object.keys(L.haeufig || {})])) { const a = (I.haeufig || {})[k] || {}, b = (L.haeufig || {})[k] || {}; neu.haeufig[k] = {}; for (const v of new Set([...Object.keys(a), ...Object.keys(b)])) neu.haeufig[k][v] = Math.max(a[v] || 0, b[v] || 0) }
  if (I.stammdaten && (!L.stammdaten || String(I.stammdaten.stand || '') > String(L.stammdaten.stand || ''))) neu.stammdaten = I.stammdaten;
  if (!L.settings && I.settings) neu.settings = I.settings;   // Einstellungen nur übernehmen, wenn dieses Gerät noch nicht eingerichtet ist
  // Entwürfe: bereits gesendete fallen weg, sonst gilt der zuletzt geänderte
  const gesendet = new Set([...neu.history, ...neu.slhistory].map(h => h.id));
  for (const k of ['draft', 'draft_sl']) {
    const a = L[k] && !gesendet.has(L[k].id) ? L[k] : null, b = I[k] && !gesendet.has(I[k].id) ? I[k] : null;
    if (b && (!a || (b._t || 0) > (a._t || 0))) { if (a && a.id !== b.id && (a.baustelle || a.personal.length) && !(await bestaetigen(`Offener ${k === 'draft' ? 'Tagesbericht' : 'Stundenlohn'}-Entwurf hier (${esc(a.baunr)} ${dateDe(a.datum)}) durch den neueren aus der Datei (${esc(b.baunr)} ${dateDe(b.datum)}) ersetzen?`))) continue; neu[k] = b }
    else if (!a && L[k]) neu['-' + k] = 1;   // hier bereits gesendet → Entwurf löschen
  }
  for (const [k, v] of Object.entries(neu)) { if (k[0] === '-') await DB.del(k.slice(1)); else await DB.set(k, v) }
  const n = x => (x || []).length;
  toast(`Eingelesen: ${n(neu.history) - n(L.history)} neue Tagesberichte, ${n(neu.slhistory) - n(L.slhistory)} Stundenlohnberichte, ${n(neu.lsliste) - n(L.lsliste)} Lieferscheine`, 5000);
  NOFLUSH = true; clearTimeout(saveTimer); setTimeout(neuLadenOhneSichern, 1800);
}

// ---------------------------------------------------------------- Stundenlohnarbeiten (eigener Bereich, Aufbau wie Formular „Stundenlohnbericht“)
const BERUFE = ['Polier', 'FA', 'MA', 'Azubi', 'Helfer', 'BL'];
const berufVon = name => BERUF[name] || (name === SET.polier ? 'Polier' : 'MA');
function neuerSL() { return Object.assign(neuerBericht(), { typ: 'sl', auftrag: '', auftragVom: '', agName: '', sigAG: '' }) }
const tbEntwurf = () => (S.r && S.r.typ !== 'sl') ? S.r : S.tb;
function slAktiv(sl) {
  if (!(S.r && S.r.typ === 'sl')) S.tb = S.r;
  S.r = S.sl = sl; S.step = 0; S.view = 'erfassung'; saveDraft(); render(); scrollTo(0, 0);
}
// Tagesbericht → Stundenlohnbericht: alles übernehmen, dann nur noch anpassen
function slAusTB(h) {
  const n = clone(h); ['weg', 'gesendet', '_draft', '_gesendet'].forEach(k => delete n[k]);
  Object.assign(n, { id: uid(), typ: 'sl', von: h.von || SET.polier, auftrag: h.bauherr || '', auftragVom: '', agName: '', sig: '', sigAG: '', bem: '', vork: '', ausTB: { id: h.id, datum: h.datum } });
  n.personal = n.personal.filter(p => !p.zus).map(p => Object.assign(p, { beruf: berufVon(p.name) }));
  n.material.forEach(m => { delete m.lsid; m.fotos = m.fotos || [] });
  return n;
}
function slHistItem(h) { return `<div class="it"><div><b>${wtag(h.datum)}, ${dateDe(h.datum)}</b> · ${esc(h.baunr)}<br><span class="small">${esc(h.baustelle)} · ${h.personal.length} Pers. · ${fq(h.personal.reduce((x, p) => x + sumH(p), 0))} h</span></div><div style="display:flex;gap:6px;flex:none"><button class="btn small ghost" data-slkopie="${h.id}">Kopie</button><button class="btn small ghost" data-slresend="${h.id}">Erneut</button></div></div>` }
function vSLStart() {
  const d = S.sl && (S.sl.baustelle || S.sl.personal.length || S.sl.aps.some(a => a.text)) ? S.sl : null, tb = tbEntwurf();
  return `<div class="home-hero"><h2 style="margin-top:0">Stundenlohnarbeiten</h2>
  ${d ? `<button class="btn orange full big" style="flex-direction:column" data-act="slweiter">Entwurf fortsetzen<br><small style="font-weight:400">${wtag(d.datum)}, ${dateDe(d.datum)} ${esc(d.baunr)} ${esc(d.baustelle)}</small></button>
    <div class="row" style="margin-top:8px"><button class="btn ghost" data-act="slneu">Neu</button><button class="btn danger" data-act="slverwerfen">Entwurf löschen</button></div>` : `<button class="btn orange full big" data-act="slneu">＋ Neuer Stundenlohnbericht</button>`}
  ${HIST.length ? `<button class="btn full" style="margin-top:8px;background:#2b2b2b;flex-direction:column" data-act="slaustb">📋 Aus Tagesbericht übernehmen<small style="font-weight:400">Personal, Stunden, Geräte, Arbeiten und Lieferscheine – dann nur anpassen</small></button>` : ''}
  ${tb && (tb.baustelle || tb.personal.length) ? `<button class="btn ghost full" style="margin-top:8px" data-act="slausentwurf">Aus aktuellem Tagesbericht-Entwurf (${esc(tb.baunr)} ${dateDe(tb.datum)})</button>` : ''}
  </div>
  <div class="card"><b>Gesendete Stundenlohnberichte</b><div class="lst">${SLHIST.slice(0, 15).map(slHistItem).join('') || '<div class="hint">Noch keine.</div>'}</div></div>
  <p class="small">„Kopie“ beginnt einen neuen Stundenlohnbericht mit den Daten dieses Berichts, „Erneut“ erzeugt PDF und Excel noch einmal zum Senden oder Speichern.</p>`;
}
function vKopfSL() {
  const r = S.r; const bs = [...new Map([...HIST, ...SLHIST].filter(h => h.baunr).map(h => [h.baunr, h])).values()];
  return `<h2>Baustelle & Auftrag</h2>
${r.ausTB ? `<div class="demo">Übernommen aus dem Tagesbericht vom <b>${dateDe(r.ausTB.datum)}</b> – bitte Stunden, Arbeiten und Lieferscheine anpassen.</div>` : ''}
<div class="card">
 <label style="margin-top:0">Aufgestellt von (Polier/Bauführer)</label>${pickBtn('von', r.von || 'Polier auswählen …')}
 <div class="grid2"><div><label>Datum</label><input type="date" data-f="datum" value="${r.datum}"></div><div><label>Tag</label><input value="${wtag(r.datum)}" disabled></div></div>
 <label>Baustellen-Nr.</label>${bnrFeld(`data-f="baunr" list="bslist"`, r.baunr, 'z. B. 26025')}
 <datalist id="bslist">${bs.map(h => `<option value="${esc(h.baunr)}">${esc(h.baustelle)}</option>`).join('')}</datalist>
 <label>Baustelle</label><input data-f="baustelle" value="${esc(r.baustelle)}" placeholder="z. B. Ulm BWK NB Psychiatrie">
 <label>Bauteil / Zusatz (optional)</label><input data-f="bauteil" value="${esc(r.bauteil)}" placeholder="z. B. Rückbau Straßenbeleuchtung">
</div>
<div class="card">
 <label style="margin-top:0">Ausgeführt nach mündl./schriftl. Auftrag durch</label><input data-f="auftrag" value="${esc(r.auftrag)}" placeholder="z. B. Staatliches Hochbauamt Ulm, Hr. Mustermann">
 <label>Auftrag vom</label><input type="date" data-f="auftragVom" value="${esc(r.auftragVom)}">
</div>`;
}
function vAbschlussSL() {
  const r = S.r, res = pruefe(r); const e = res.filter(x => x.t === 'e').length, w = res.filter(x => x.t === 'w').length; return `<h2>Abschluss</h2>
<div class="card"><label style="margin-top:0">Bemerkung (erscheint unter den Arbeiten)</label><textarea data-f="bem" placeholder="z. B. auf Anweisung von Mustermann">${esc(r.bem)}</textarea>
<div class="mic">🎤 Mikrofon auf der Tastatur antippen: diktieren statt tippen.</div></div>
<h3>Prüfung ${e ? `<span class="badge" style="background:#fdecea;color:var(--rot)">${e} Fehler</span>` : ''} ${w ? `<span class="badge b-pr">${w} Hinweise</span>` : ''}</h3>
<div class="card">${res.length ? res.map(x => `<div class="check"><span class="dot ${x.t}">${x.t === 'e' ? '!' : '?'}</span><div>${x.m} <a href="#" data-go="${x.s}">ändern</a></div></div>`).join('') : `<div class="check"><span class="dot ok">✓</span><div>Alles vollständig.</div></div>`}</div>
<h3>Unterschrift Polier</h3><div class="card"><canvas class="sigpad" id="sig"></canvas><div class="prow" style="margin-top:6px"><span class="hint" style="margin:0">Mit dem Finger unterschreiben</span><button class="btn small ghost" data-act="sigclear">Löschen</button></div></div>
<h3>Geprüft u. anerkannt (Auftraggeber/Bauleiter)</h3><div class="card"><label style="margin-top:0">Name</label><input data-f="agName" value="${esc(r.agName)}" placeholder="z. B. Mustermann (Bauleitung)">
<canvas class="sigpad" id="sig2" style="margin-top:8px"></canvas><div class="prow" style="margin-top:6px"><span class="hint" style="margin:0">Optional – direkt vor Ort auf dem Handy unterschreiben lassen</span><button class="btn small ghost" data-act="sig2clear">Löschen</button></div></div>
<h3>Vorschau</h3>${docViewer(r)}`;
}
function pruefeSL(r) {
  const o = [], D = slDaten(r);
  if (!r.datum) o.push({ t: 'e', s: 0, m: 'Datum fehlt.' });
  if (!r.von) o.push({ t: 'e', s: 0, m: 'Polier (aufgestellt von) fehlt.' });
  if (!r.baunr) o.push({ t: 'e', s: 0, m: 'Baustellen-Nr. fehlt.' });
  if (!r.auftrag) o.push({ t: 'w', s: 0, m: 'Auftraggeber („Auftrag durch“) fehlt.' });
  if (!r.aps.some(a => (a.text || '').trim())) o.push({ t: 'e', s: 1, m: 'Bitte beschreiben, welche Arbeiten ausgeführt wurden.' });
  if (D.arb.length > 40) o.push({ t: 'w', s: 1, m: `Arbeiten zu lang (${D.arb.length} Zeilen, Platz für 40) – bitte kürzen.` });
  if (!r.personal.length && !r.geraete.length) o.push({ t: 'e', s: 2, m: 'Weder Personal noch Geräte eingetragen.' });
  if (r.personal.length > 9) o.push({ t: 'w', s: 2, m: 'Mehr als 9 Personen – das Formular hat nur 9 Zeilen.' });
  r.personal.forEach(p => { if (!sumH(p)) o.push({ t: 'e', s: 2, m: `${esc(p.name)}: keine Stunden.` }); if (!p.beruf) o.push({ t: 'w', s: 2, m: `${esc(p.name)}: Beruf fehlt.` }) });
  if (r.geraete.length > 11) o.push({ t: 'w', s: 3, m: 'Mehr als 11 Geräte – das Formular hat nur 11 Zeilen.' });
  r.geraete.forEach(g => { if (!sumH(g)) o.push({ t: 'w', s: 3, m: `${esc(g.name)}: keine Stunden.` }) });
  r.material.forEach(m => { if (!m.mat) o.push({ t: 'e', s: 4, m: 'Material ohne Bezeichnung.' }); if (!num(m.menge)) o.push({ t: 'e', s: 4, m: `${esc(m.mat || 'Material')}: Menge fehlt.` }); if (m.ls && !m.fotos.length) o.push({ t: 'w', s: 4, m: `Lieferschein ${esc(m.ls)}: kein Foto für die Anlage.` }) });
  if (D.mat.length > 11) o.push({ t: 'w', s: 4, m: 'Mehr als 11 Materialarten – das Formular hat nur 11 Zeilen.' });
  if (!r.sig) o.push({ t: 'w', s: 5, m: 'Unterschrift Polier fehlt.' });
  if (!r.sigAG) o.push({ t: 'w', s: 5, m: 'Unterschrift Auftraggeber fehlt – kann auch später auf dem Ausdruck erfolgen.' });
  return o;
}
// A4 wie das Excel-Formular (Spaltenbreiten aus der Vorlage)
function docSL(r) {
  const D = slDaten(r), E = v => esc(v ?? ''), sumP = D.pers.reduce((a, p) => a + p.std, 0);
  const W = [61, 33, 36, 24, 53, 46, 67, 73, 63, 63, 75, 111];
  const A = i => `<td colspan="4" class="bi">${E(D.arb[i - 11])}</td>`;   // Kennzeichnung der Arbeit, Zeile 11–50
  const rows = [];
  rows.push(`<td colspan="6" class="tt" style="border:0;border-bottom:2px solid #ED7102;text-align:center">Stundenlohnbericht</td><td class="nob r" style="font-size:12px">Baustelle:</td><td colspan="5" class="bi" style="border:0;border-bottom:1px solid #000;font-size:12px">${E([r.baunr, r.baustelle].filter(Boolean).join(' ') + (r.bauteil ? ', ' + r.bauteil : ''))}</td>`);
  rows.push(`<td colspan="6" class="nob c sm">für tägliche Abrechnung</td><td class="nob r" style="font-size:12px">Datum:</td><td colspan="5" class="bi" style="border:0;border-bottom:1px solid #000;font-size:12px">${dateDe(r.datum)}</td>`);
  rows.push(`<td colspan="12" class="nob" style="height:6px"></td>`);
  rows.push(`<td rowspan="5" class="sm" style="vertical-align:top;border-right:0">Firma:</td><td colspan="4" rowspan="5" style="border-left:0;vertical-align:top;padding-top:4px;white-space:normal"><img src="icons/logo-dark.png" style="height:30px;display:block"><div style="font-size:8.5px;line-height:12px;margin-top:3px">${FIRMA.adr}<br>Telefon (073 92) 9703-0</div></td><td colspan="7" class="sm" style="border-bottom:0">Tagelohnarbeiten ausgeführt nach mündl./schriftl. Auftrag durch</td>`);
  rows.push(`<td colspan="7" rowspan="2" class="bi" style="border-top:0;font-size:12px">${E(r.auftrag)}</td>`); rows.push('');
  rows.push(`<td colspan="4" rowspan="2"></td><td rowspan="2" class="sm r" style="border-right:0">vom:</td><td colspan="2" rowspan="2" class="bi c" style="border-left:0">${r.auftragVom ? dateDe(r.auftragVom) : ''}</td>`); rows.push('');
  rows.push(`<td colspan="5" class="c" style="font-weight:700;font-size:12px;height:24px">Namen der Arbeiter</td><td class="c" style="font-weight:700">Beruf</td><td colspan="2" class="c" style="font-weight:700;font-size:12px">Stunden</td><td colspan="4" class="c" style="font-weight:700;font-size:12px">Kennzeichnung der Arbeit</td>`);
  for (let i = 0; i < 9; i++) { const p = D.pers[i]; rows.push(`<td colspan="5" class="bi">${p ? E(p.name) : ''}</td><td class="c">${p ? E(p.beruf) : ''}</td><td class="r">${p ? fq(p.std) : ''}</td><td></td>${A(11 + i)}`) }
  rows.push(`<td colspan="6" class="r sm">${D.pers.length ? 'Summe' : ''}</td><td class="r" style="font-weight:700">${D.pers.length ? fq(sumP) : ''}</td><td></td>${A(20)}`);
  rows.push(`<td colspan="8" rowspan="2" class="c" style="font-weight:700;font-size:12px">Eingebautes Material</td>${A(21)}`); rows.push(A(22));
  rows.push(`<td colspan="2" rowspan="2" class="c" style="font-weight:700">Menge</td><td colspan="6" rowspan="2" class="c" style="font-weight:700">Bezeichnung</td>${A(23)}`); rows.push(A(24));
  for (let i = 0; i < 11; i++) { const m = D.mat[i]; rows.push(`<td class="r bi">${m ? fq(m.menge) : ''}</td><td class="c">${m ? E(EINH_TXT[m.einh] || m.einh) : ''}</td><td colspan="5" class="bi">${m ? E(m.mat + (m.lief ? ' (' + m.lief + ')' : '')) : ''}</td><td class="r sm">${m && m.ls.length ? m.ls.length + ' LS' : ''}</td>${A(25 + i)}`) }
  rows.push(`<td colspan="8" rowspan="2" class="c" style="font-weight:700;font-size:12px">Vorhaltung von Maschinen, Geräte und Fahrzeuge</td>${A(36)}`); rows.push(A(37));
  rows.push(`<td rowspan="2" class="c" style="font-weight:700">Menge</td><td colspan="6" rowspan="2" class="c" style="font-weight:700">Bezeichnung</td><td rowspan="2" class="c" style="font-weight:700">Std.</td>${A(38)}`); rows.push(A(39));
  for (let i = 0; i < 11; i++) { const g = D.ger[i]; rows.push(`<td class="c">${g ? g.anz : ''}</td><td colspan="5" class="bi" style="font-size:9.5px">${g ? E(g.name) : ''}</td><td class="r sm">${g ? E(g.ks) : ''}</td><td class="r">${g ? fq(g.std) : ''}</td>${A(40 + i)}`) }
  const sigImg = s => s ? `<img src="${s}" style="height:44px;display:block;margin:0 auto">` : '';
  rows.push(`<td class="sm" style="border-bottom:0;border-right:0">Aufgestellt:</td><td colspan="2" class="sm bi" style="border:0;border-top:1px solid #000">${E(r.von)}</td><td class="sm" style="border:0;border-top:1px solid #000">am:</td><td class="sm bi" style="border-left:0;border-bottom:0;border-top:1px solid #000">${dShort(r.datum, '.')}</td><td colspan="2" class="sm" style="border-bottom:0;border-right:0">Geprüft u. anerkannt:</td><td class="sm bi" style="border:0;border-top:1px solid #000">${E(r.agName)}</td><td class="sm" style="border-left:0;border-bottom:0">am: ${r.sigAG ? dShort(r.datum, '.') : ''}</td><td colspan="2" class="sm" style="border-bottom:0;border-right:0">Ausgewertet:</td><td class="sm" style="border-left:0;border-bottom:0">am:</td>`);
  rows.push(`<td colspan="5" rowspan="3" style="border-top:0;height:56px">${sigImg(r.sig)}</td><td colspan="4" rowspan="3" style="border-top:0">${sigImg(r.sigAG)}</td><td colspan="3" rowspan="3" style="border-top:0"></td>`); rows.push(''); rows.push('');
  rows.push(`<td colspan="5" class="sm">Polier/Bauführer</td><td colspan="4" class="sm">Bauleiter/Bauherr</td><td colspan="3" class="sm">Bauführer/Buchhaltung</td>`);
  return `<div class="a4 sl"><table><colgroup>${W.map(w => `<col style="width:${w}px">`).join('')}</colgroup>${rows.map(x => `<tr>${x}</tr>`).join('')}</table></div>`;
}
function slJson(r) {
  const D = slDaten(r);
  return { format: 'schwall-stundenlohn', version: 1, app_version: APP_VERSION, id: r.id, erstellt: new Date().toISOString(), datum: r.datum, wochentag: wtag(r.datum), polier: r.von,
    baustelle_nr: r.baunr, baustelle: r.baustelle, bauteil: r.bauteil, auftrag_durch: r.auftrag, auftrag_vom: r.auftragVom, anerkannt_von: r.agName, anerkannt_unterschrieben: !!r.sigAG,
    arbeiten: r.aps.filter(a => a.text).map(a => ({ ap: a.nr, text: a.text })), bemerkung: r.bem,
    personal: r.personal.map(p => ({ name: p.name, persnr: p.nr, beruf: p.beruf || '', stunden: sumH(p) })),
    geraete: D.ger.map(g => ({ bezeichnung: g.name, kostenstelle: g.ks, stunden: g.std })),
    material: r.material.map(m => ({ lieferant: m.lief, material: m.mat, einheit: m.einh, lieferschein: m.ls, menge: num(m.menge), fotos: m.fotos.length })),
    aus_tagesbericht: r.ausTB || null };
}

// ---------------------------------------------------------------- Prüfregeln
function pruefe(r) {
  if (r.typ === 'sl') return pruefeSL(r);
  const o = [], d = dauer(r);
  if (!r.datum) o.push({ t: 'e', s: 0, m: 'Datum fehlt.' });
  if (!r.beginn || !r.ende) o.push({ t: 'e', s: 5, m: 'Beginn und Ende der Arbeitszeit angeben.' });
  if (!r.von) o.push({ t: 'e', s: 0, m: 'Polier (ausgestellt von) fehlt.' });
  if (!r.baunr) o.push({ t: 'e', s: 0, m: 'Baustellen-Nr. fehlt.' });
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
  r.personal.forEach(p => { if (p.neu && !p.nr) o.push({ t: 'w', s: 2, m: `${esc(p.name)}: neu, nicht in der Mitarbeiterliste – Büro ergänzt die Pers.-Nr.` }) });
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
// Lieferscheine gesammelt: je Arbeitspaket, dann Lieferant, dann Material (Reihenfolge des ersten Auftretens)
function materialSortiert(r) {
  const pos = (arr, k) => { const i = arr.indexOf(k); return i < 0 ? 999 : i };
  const L = [...new Set(r.material.map(m => m.lief))], M = [...new Set(r.material.map(m => m.mat))];
  return r.material.map((m, i) => [m, i]).sort((a, b) => (r.aps.findIndex(x => x.id === a[0].ap) - r.aps.findIndex(x => x.id === b[0].ap)) || (pos(L, a[0].lief) - pos(L, b[0].lief)) || (pos(M, a[0].mat) - pos(M, b[0].mat)) || (a[1] - b[1])).map(x => x[0]);
}
function matLines(r) {
  const L = [], aps = r.aps, multi = new Set(r.material.map(m => m.ap)).size > 1; let la = null, ll = null, lm = null;
  materialSortiert(r).forEach(m => {
    if (multi && m.ap !== la) { const a = aps.find(a => a.id === m.ap); L.push({ t: 'AP ' + (a && a.nr || '?'), cls: 'g' }); la = m.ap; ll = lm = null }
    if (m.lief !== ll) { L.push({ t: '---' + m.lief + '---' }); ll = m.lief; lm = null }
    if (m.mat !== lm) { L.push({ t: m.mat + (m.einh ? ' [' + m.einh + ']' : '') }); lm = m.mat }
    L.push({ ls: m.ls + (m.lsdatum && m.lsdatum !== r.datum ? ' (' + dShort(m.lsdatum, '.').slice(0, 6) + ')' : ''), mg: fq(m.menge) + (m.einh ? ' ' + m.einh : '') });
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
function initSig() { sigPad('#sig', 'sig'); sigPad('#sig2', 'sigAG') }
function sigPad(sel, key) {
  const c = $(sel); if (!c) return; const dpr = window.devicePixelRatio || 1; c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr); x.lineWidth = 2.4; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#111';
  if (S.r[key]) { const im = new Image(); im.onload = () => x.drawImage(im, 0, 0, c.clientWidth, c.clientHeight); im.src = S.r[key] }
  let on = false; const pt = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top] };
  c.onpointerdown = e => { on = true; c.setPointerCapture(e.pointerId); const [a, b] = pt(e); x.beginPath(); x.moveTo(a, b) };
  c.onpointermove = e => { if (!on) return; const [a, b] = pt(e); x.lineTo(a, b); x.stroke() };
  c.onpointerup = c.onpointercancel = () => { if (!on) return; on = false; S.r[key] = c.toDataURL('image/png'); saveDraft(); const box = document.querySelector('.a4box'); if (box) { box.innerHTML = S.r.typ === 'sl' ? docSL(S.r) : S.doc === 'tb' ? docTB(S.r) : docBTB(S.r); fitA4() } };
}

// ---------------------------------------------------------------- Auswahl mit Suche
function openPicker(kind, cb, selected = []) {
  let items, title, multi = false;
  if (kind === 'ma' || kind === 'polier') { title = kind === 'ma' ? 'Mitarbeiter' : 'Polier'; multi = kind === 'ma'; items = SD.ma.map(m => ({ v: m[0], sub: m[1], g: m[0][0].toUpperCase(), raw: m })) }
  if (kind === 'ge') { title = 'Geräte'; multi = true; items = SD.ge.map(g => ({ v: g[0], sub: g[2] ? 'KST ' + g[2] : '', g: g[3], raw: g })) }
  if (kind === 'mat') { title = 'Material'; items = SD.mat.map(m => ({ v: m[0], sub: (m[2] ? m[2] + ' · ' : '') + m[1], g: m[3], raw: m })) }
  if (kind === 'lief') { title = 'Lieferant'; items = SD.lief.map(l => ({ v: l, sub: '', g: '', raw: [l] })) }
  const fk = kind === 'polier' ? 'ma' : kind; FAV[fk] = FAV[fk] || []; HAEUFIG[fk] = HAEUFIG[fk] || {};
  FAV[fk].filter(v => !items.some(x => x.v === v)).forEach(v => items.push({ v, sub: 'eigener Eintrag', g: '', raw: [v, '', '', ''] }));   // frei eingetragene Favoriten
  const sel = new Set(selected), el = document.createElement('div'); el.className = 'sheet';
  el.innerHTML = `<div class="in"><div class="top"><div class="prow"><b style="font-size:18px">${title} ${multi ? '<span class="hint">(mehrere möglich)</span>' : ''}</b><button class="btn small" data-close>${multi ? 'Fertig' : '✕'}</button></div><input type="search" placeholder="${kind === 'ma' ? 'Suchen … oder neuen Namen eintippen (Nachname, Vorname)' : 'Suchen … Name, Teil davon oder Nummer'}" autocomplete="off"></div><div class="list"></div></div>`;
  document.body.appendChild(el);
  const inp = el.querySelector('input'), list = el.querySelector('.list');
  const draw = () => {
    const q = inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean); let h = '', lg = null, n = 0;
    const zeile = (it, lab) => `<div class="it ${sel.has(it.v) ? 'sel' : ''}" data-v="${esc(it.v)}"><button class="star ${FAV[fk].includes(it.v) ? 'on' : ''}" data-star="${esc(it.v)}" aria-label="Favorit">${FAV[fk].includes(it.v) ? '★' : '☆'}</button><span style="flex:1">${lab}</span><small>${esc(it.sub)}</small></div>`;
    if (!q.length) {   // oben: Favoriten, dann häufig gewählte
      const fav = items.filter(it => FAV[fk].includes(it.v)).sort((a, b) => a.v.localeCompare(b.v, 'de'));
      const oft = items.filter(it => !FAV[fk].includes(it.v) && (HAEUFIG[fk][it.v] || 0) >= 2).sort((a, b) => HAEUFIG[fk][b.v] - HAEUFIG[fk][a.v]).slice(0, 8);
      if (fav.length) h += `<div class="grp">★ Favoriten</div>` + fav.map(it => zeile(it, esc(it.v))).join('');
      if (oft.length) h += `<div class="grp">Häufig gewählt</div>` + oft.map(it => zeile(it, esc(it.v))).join('');
      if (!fav.length && !oft.length && items.length > 8) h += `<div class="hint" style="padding:8px 14px">Tipp: ☆ antippen = Favorit, steht dann immer oben.</div>`;
    }
    for (const it of items) {
      const hay = (it.v + ' ' + it.sub).toLowerCase(); if (!q.every(t => hay.includes(t))) continue;
      if (it.g !== lg && it.g) { h += `<div class="grp">${esc(it.g)}</div>`; lg = it.g }
      let lab = q.length ? String(it.v).split(new RegExp('(' + q.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig')).map((x, i) => i % 2 ? '<mark>' + esc(x) + '</mark>' : esc(x)).join('') : esc(it.v);
      h += zeile(it, lab); n++;
      if (n > 300) break;
    }
    if (inp.value.trim()) h += `<div class="it" data-free="1"><span>＋ „${esc(inp.value.trim())}“ ${kind === 'ma' || kind === 'polier' ? 'als neuen Mitarbeiter eintragen' : 'als eigenen Eintrag übernehmen'}</span></div>`;
    else if (!n) h = '<div class="hint" style="padding:14px">Nichts gefunden.</div>';
    list.innerHTML = h;
  };
  draw(); inp.addEventListener('input', draw); setTimeout(() => inp.focus(), 50);
  const close = () => { el.remove(); saveDraft(); render() };
  el.addEventListener('click', e => {
    if (e.target === el || e.target.closest('[data-close]')) { close(); return }
    const st = e.target.closest('[data-star]');
    if (st) { const v = st.dataset.star, i = FAV[fk].indexOf(v); if (i < 0) FAV[fk].push(v); else FAV[fk].splice(i, 1); DB.set('favoriten', FAV); draw(); return }
    const it = e.target.closest('.it'); if (!it) return;
    if (it.dataset.free) { cb([inp.value.trim(), '', '', ''], true); if (multi) { inp.value = ''; draw() } else close(); return }
    const obj = items.find(x => x.v === it.dataset.v);
    if (!sel.has(obj.v)) { HAEUFIG[fk][obj.v] = (HAEUFIG[fk][obj.v] || 0) + 1; DB.set('haeufig', HAEUFIG) }
    if (multi) { if (sel.has(obj.v)) { sel.delete(obj.v); cb(obj.raw, false) } else { sel.add(obj.v); cb(obj.raw, true) } draw() } else { cb(obj.raw, true); close() }
  });
}

// ---------------------------------------------------------------- Daten für Büro (JSON + CSV)
function berichtDaten(r) {
  if (r.typ === 'sl') return slJson(r);
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
  pdf.setProperties({ title: `${{ tb: 'Tagesbericht', btb: 'Bautagebuch', sl: 'Stundenlohnbericht' }[art]} ${r.baunr} ${dateDe(r.datum)}`, author: r.von, creator: 'Schwall Tagesbericht-App ' + APP_VERSION });
  pdf.addImage(await seitenBild(art === 'sl' ? docSL(r) : art === 'tb' ? docTB(r) : docBTB(r)), 'JPEG', 0, 0, 210, 297);
  if (art === 'tb' || art === 'sl') {   // Anlage: Lieferschein-Fotos, 2 pro Seite
    const fotos = r.material.flatMap(m => m.fotos.map(f => [m, f]));
    for (let i = 0; i < fotos.length; i++) {
      if (i % 2 === 0) { pdf.addPage(); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.text(art === 'sl' ? 'Anlage Lieferscheine zum Stundenlohnbericht' : 'Anlage Lieferscheine', 12, 16); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.text(`Baustelle ${r.baunr} ${r.baustelle} · ${dateDe(r.datum)} · ${r.von}`, 12, 22); pdf.setDrawColor(237, 113, 7); pdf.setLineWidth(0.6); pdf.line(12, 25, 198, 25) }
      const [m, f] = fotos[i]; const p = pdf.getImageProperties(f); const maxW = 186, maxH = 122; let w = maxW, h = p.height * w / p.width; if (h > maxH) { h = maxH; w = p.width * h / p.height }
      const y0 = i % 2 === 0 ? 30 : 160; pdf.addImage(f, 'JPEG', 12 + (maxW - w) / 2, y0, w, h);
      pdf.setFontSize(9); pdf.text(`${m.lief} · ${m.mat} · Lieferschein ${m.ls} · ${fq(m.menge)} ${m.einh}`, 12, y0 + h + 5);
    }
  }
  return pdf.output('blob');
}
let VORLAGE = null;
async function excelErzeugen(r) {   // füllt die Original-Excel-Vorlage (Tagesbericht + Bautagebuch + Blatt „Lohn“)
  if (!VORLAGE) VORLAGE = await (await fetch('vorlage-tagesbericht.xlsx')).arrayBuffer();
  return new Blob([await excelFuellen(JSZip, VORLAGE.slice(0), r, SD, r.sig || null)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
let VORLAGE_SL = null;
async function excelSL(r) {
  if (!VORLAGE_SL) VORLAGE_SL = await (await fetch('vorlage-stundenlohn.xlsx')).arrayBuffer();
  return new Blob([await slFuellen(JSZip, VORLAGE_SL.slice(0), r)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
async function dateienErzeugen(r) {
  if (r.typ === 'sl') {
    const base = `${r.baunr || 'ohneNr'}-SL-%${yymmdd(r.datum)}`, d = slJson(r);
    d.bericht_app = Object.assign(clone(r), { material: r.material.map(m => Object.assign({}, m, { fotos: [], ocr: undefined })) });
    const files = [new File([await pdfErzeugen(r, 'sl')], base.replace('%', '') + '.pdf', { type: 'application/pdf' })];
    try { files.push(new File([await excelSL(r)], base.replace('%', '') + '.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })) } catch (e) { console.error('Excel', e) }
    files.push(new File([JSON.stringify(d, null, 1)], base.replace('%', 'DATEN-') + '.txt', { type: 'text/plain' }));
    return files;
  }
  const base = `${r.baunr || 'ohneNr'}-%-${yymmdd(r.datum)}`, d = berichtDaten(r);
  d.bericht_app = Object.assign(clone(r), { material: r.material.map(m => Object.assign({}, m, { fotos: [], ocr: undefined })) });   // für die Excel-Erzeugung im Büro
  const files = [
    new File([await pdfErzeugen(r, 'tb')], base.replace('%', 'TB') + '.pdf', { type: 'application/pdf' }),
    new File([await pdfErzeugen(r, 'btb')], base.replace('%', 'BTB') + '.pdf', { type: 'application/pdf' })
  ];
  try { files.push(new File([await excelErzeugen(r)], base.replace('%', 'TB-BTB') + '.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })) } catch (e) { console.error('Excel', e) }
  files.push(new File([JSON.stringify(d, null, 1)], base.replace('%', 'DATEN') + '.txt', { type: 'text/plain' }));
  return files;
}
const teilbar = files => !!(navigator.canShare && navigator.canShare({ files }));
// manche Android-Handys dürfen Excel-Dateien nicht über „Teilen“ weitergeben → dann ohne Excel teilen (Büro erzeugt sie aus der DATEN-Datei)
// Chrome/Android meldet „teilbar“, lehnt Excel beim eigentlichen Teilen aber ab („Permission denied“) → dort Excel gleich weglassen; nur iPhone/iPad gibt Excel weiter
function teilDateien(files) {
  // iPhone: alles. Android/Chrome: ohne Excel (wird vom System abgelehnt); notfalls nur die PDFs – Hauptsache, die Mail geht direkt auf
  const stufen = isIOS() ? [files, files.filter(f => !/\.xlsx$/.test(f.name))] : [files.filter(f => !/\.xlsx$/.test(f.name)), files.filter(f => /\.pdf$/.test(f.name))];
  for (const st of stufen) if (st.length && teilbar(st)) return { files: st, ohneExcel: st.length < files.length };
  return { files: null, ohneExcel: false };
}
function teilGrund() { return !navigator.share ? 'Dieser Browser hat keine Teilen-Funktion.' : !navigator.canShare ? 'Dieser Browser kann keine Dateien teilen.' : 'Der Browser lehnt die Dateien ab.' }
const betreff = r => r.typ === 'sl' ? `Stundenlohnbericht ${wtag(r.datum)} ${dateDe(r.datum)} – Baustelle ${r.baunr} ${r.baustelle} – Polier ${r.von}` : `Tagesbericht ${wtag(r.datum)} ${dateDe(r.datum)} – Baustelle ${r.baunr} ${r.baustelle} – Polier ${r.von}`;
const mailText = r => r.typ === 'sl' ? `${betreff(r)}\n\nStundenlohnbericht (PDF mit Lieferscheinen als Anlage, Excel)\nBaustelle: ${r.baunr} ${r.baustelle}\nDatum: ${wtag(r.datum)}, ${dateDe(r.datum)}\nAuftrag durch: ${r.auftrag || '–'}\nPolier: ${r.von}\nPersonal: ${r.personal.length} (${fq(r.personal.reduce((x, p) => x + sumH(p), 0))} h) · Geräte: ${r.geraete.length} · Lieferscheine: ${r.material.length}\n${r.sigAG ? 'Vom Auftraggeber unterschrieben' + (r.agName ? ' (' + r.agName + ')' : '') : 'Noch nicht vom Auftraggeber unterschrieben'}\n\n(automatisch erstellt mit der Schwall Tagesbericht-App)` : `${betreff(r)}\n\nTagesbericht und Bautagebuch\nBaustelle: ${r.baunr} ${r.baustelle}\nDatum: ${wtag(r.datum)}, ${dateDe(r.datum)}\nPolier: ${r.von}\nPersonal: ${r.personal.length} · Geräte: ${r.geraete.length} · Lieferscheine: ${r.material.length}\n\n(automatisch erstellt mit der Schwall Tagesbericht-App)`;

// ---------------------------------------------------------------- Versand
function overlay(html) { let o = $('#ov'); if (!o) { o = document.createElement('div'); o.id = 'ov'; o.className = 'overlay'; document.body.appendChild(o) } o.innerHTML = `<div class="box2">${html}</div>`; return o }
function closeOverlay() { const o = $('#ov'); if (o) o.remove() }
async function prepare(r) {
  overlay(`<div class="spin"></div><b>${r.typ === 'sl' ? 'Stundenlohnbericht wird erstellt …' : 'PDFs werden erstellt …'}</b><p class="small">Das dauert ein paar Sekunden.</p>`);
  try {
    const files = await dateienErzeugen(r); S.prepared = { r, files };
    if (SET.uploadUrl) return uploadSenden();
    zeigeVersand();
  } catch (e) { console.error(e); overlay(`<b>Fehler beim Erstellen</b><p class="small">${esc(e.message || e)}</p><button class="btn full" data-act="ovclose">Schließen</button>`) }
}
function zeigeVersand(hinweis = '') {
  const { r, files } = S.prepared, td = teilDateien(files), kann = !!td.files;
  if (istPC()) {   // Büro-PC mit Outlook Classic: fertige E-Mail-Datei (.eml) mit allen Anhängen
    overlay(`<b style="font-size:18px">${r.typ === 'sl' ? 'Stundenlohnbericht' : 'Bericht'} ist fertig ✓</b>${hinweis}
    <div class="files">${files.map(f => `<div>📄 ${esc(f.name)} <span class="small">(${Math.ceil(f.size / 1024)} KB)</span></div>`).join('')}</div>
    <div class="ocrbox" style="text-align:left"><b>Betreff:</b> ${esc(betreff(r))}</div>
    <p class="small">Auf <b>Senden</b> klicken – die Mail öffnet sich in <b>Outlook</b> mit Empfänger <b>${esc(SET.email || '')}</b>, Betreff, Anschreiben und allen Anhängen.<br><b>Nur beim ersten Mal:</b> oben rechts bei den Downloads die Datei mit Rechtsklick (oder ⋯) → <b>„Dateien dieses Typs immer öffnen“</b>. Ab dann geht sie automatisch in Outlook auf.</p>
    <a class="btn orange full big" id="emllink" style="opacity:.5;pointer-events:none">📤 Senden (wird vorbereitet …)</a>
    <button class="btn ghost small full" style="margin-top:8px" data-act="speichern">💾 Auf diesem Gerät speichern</button>
    <button class="btn ghost full" style="margin-top:8px" data-act="ovclose">Abbrechen</button>`);
    // Datei vorab bauen: der Klick lädt sie dann direkt (echter Klick → keine Sicherheitswarnung des Browsers)
    emlErzeugen(r, files).then(f => { const a = $('#emllink'); if (!a) return; a.href = URL.createObjectURL(f); a.download = f.name; a.textContent = '📤 Senden'; a.style.opacity = ''; a.style.pointerEvents = '' });
    return;
  }
  overlay(`<b style="font-size:18px">${r.typ === 'sl' ? 'Stundenlohnbericht' : 'Bericht'} ist fertig ✓</b>${hinweis}
  <div class="files">${files.map(f => `<div>📄 ${esc(f.name)} <span class="small">(${Math.ceil(f.size / 1024)} KB)</span></div>`).join('')}</div>
  <div class="ocrbox" style="text-align:left"><b>Betreff:</b> ${esc(betreff(r))}</div>
  ${kann ? `<p class="small">Tippe auf <b>Senden</b>, wähle <b>Outlook</b> oder <b>Mail</b> und schicke die Nachricht an:<br><b>${esc(SET.email || 'Büro-Adresse')}</b><br>Der Betreff wird mitgegeben. Falls das Betreff-Feld leer bleibt: lange hineintippen → <b>Einsetzen</b> (er ist schon kopiert).</p>
    ${td.ohneExcel ? '<p class="small" style="color:var(--gelb)">Android gibt Excel-Dateien beim Teilen nicht weiter – angehängt werden ' + td.files.map(f => esc(f.name)).join(', ') + '. Das Büro erzeugt die Excel aus der DATEN-Datei (buero.html).</p>' : ''}
    <button class="btn orange full big" data-act="share">📤 Senden</button>
    <button class="btn ghost small full" style="margin-top:8px" data-act="speichern">💾 Auf diesem Gerät speichern</button>`
    : `<p class="small"><b>${teilGrund()}</b> Bitte die App in <b>Google Chrome</b> (Android) bzw. <b>Safari</b> (iPhone) öffnen und von dort installieren – dann geht Senden direkt in die Mail. Bis dahin: Dateien werden gespeichert, bitte an <b>${esc(SET.email)}</b> anhängen. <span style="opacity:.7">(${esc(navigator.userAgent.match(/(SamsungBrowser|Firefox|EdgA|OPR|Chrome|Version)\/[\d.]+/)?.[0] || '')}, App ${APP_VERSION})</span></p><button class="btn orange full big" data-act="download">⬇ Dateien speichern & E-Mail öffnen</button>`}
  <button class="btn ghost full" style="margin-top:8px" data-act="ovclose">Abbrechen</button>`);
}
// Laptop/PC erkennen
async function emlErzeugen(r, files) {
  const B = '----=_Schwall_' + uid(), enc = t => '=?UTF-8?B?' + btoa(unescape(encodeURIComponent(t))) + '?=';
  const zeilen = t => t.replace(/.{1,76}/g, '$&\r\n');
  const txt = btoa(unescape(encodeURIComponent(mailText(r).replace(/\n/g, '\r\n'))));
  let m = `To: ${SET.email || ''}\r\nSubject: ${enc(betreff(r))}\r\nX-Unsent: 1\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${B}"\r\n\r\n`;
  m += `--${B}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${zeilen(txt)}`;
  for (const f of files) m += `--${B}\r\nContent-Type: ${f.type || 'application/octet-stream'}; name="${enc(f.name)}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${enc(f.name)}"\r\n\r\n${zeilen(await b64(f))}`;
  m += `--${B}--\r\n`;
  const st = new Date(), z = n => String(n).padStart(2, '0');
  return new File([m], `Mail ${r.typ === 'sl' ? 'SL' : 'TB'} ${r.baunr || ''} ${dShort(r.datum, '-')} ${z(st.getHours())}${z(st.getMinutes())}.eml`.replace(/[\\/:*?"<>|]/g, ''), { type: 'message/rfc822' });
}
document.addEventListener('click', e => { if (e.target.closest('#emllink') && S.prepared && !S.prepared._emlKlick) { S.prepared._emlKlick = true; setTimeout(() => { if (S.prepared) abgeschlossen('mail') }, 1200) } });
const istPC = () => !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && !(/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
async function share() {
  const { r } = S.prepared, alle = S.prepared.files;
  // Handy: Teilen-Fenster (Outlook, Mail, Gmail …). Android-Chrome nimmt keine Excel-Dateien → dann ohne Excel (Büro erzeugt sie aus DATEN)
  const files = teilDateien(alle).files;
  navigator.clipboard && navigator.clipboard.writeText(betreff(r)).catch(() => { });
  if (!files || !teilbar(files)) { download(); return }
  try {
    await navigator.share({ files, title: betreff(r), text: mailText(r) });
    await abgeschlossen('mail');
  } catch (e) { if (e.name === 'AbortError') return; teilenFehler(e, files) }
}
// Teilen abgelehnt (Android: „Permission denied“) → neue Versuche brauchen ein neues Antippen, daher Auswahl anzeigen
function teilenFehler(e, versucht) {
  const { files } = S.prepared, pdfs = files.filter(f => /\.pdf$/.test(f.name)), nurPdf = versucht.length > pdfs.length && teilbar(pdfs);
  S.prepared._fehler = `${e.name}: ${e.message}`;
  overlay(`<b style="font-size:17px">Android hat das Senden abgelehnt</b>
  <p class="small">${nurPdf ? 'Versuche es mit nur den PDFs – oder speichere die Dateien und hänge sie in der Mail-App selbst an.' : 'Bitte die Dateien speichern und in der Mail-App selbst anhängen.'}</p>
  ${nurPdf ? '<button class="btn orange full big" data-act="sharepdf">📤 Nur PDFs senden</button>' : ''}
  <button class="btn ${nurPdf ? 'ghost' : 'orange'} full" style="margin-top:8px" data-act="dateiliste">💾 Dateien einzeln speichern</button>
  <button class="btn ghost full" style="margin-top:8px" data-act="ovclose">Abbrechen</button>
  <p class="small" style="opacity:.7;margin-top:10px">Technik-Info fürs Büro: ${esc(e.name)} – ${esc(e.message)} · ${versucht.map(f => esc(f.name) + ' (' + esc(f.type) + ', ' + Math.ceil(f.size / 1024) + ' KB)').join(', ')} · ${esc(navigator.userAgent.match(/(SamsungBrowser|Firefox|EdgA|OPR|Chrome)\/[\d.]+/)?.[0] || '')} · App ${APP_VERSION}</p>`);
}
async function sharePdf() {
  const { r, files } = S.prepared, pdfs = files.filter(f => /\.pdf$/.test(f.name));
  try { await navigator.share({ files: pdfs, title: betreff(r), text: mailText(r) + '\n\n(Nur PDFs – Excel/DATEN-Datei konnten von diesem Handy nicht mitgeschickt werden.)' }); await abgeschlossen('mail') }
  catch (e) { if (e.name === 'AbortError') return; teilenFehler(e, pdfs); const b = document.querySelector('[data-act="sharepdf"]'); if (b) b.remove() }
}
// Jede Datei als eigener Knopf: Android lässt pro Antippen nur einen Download zu (mehrere automatisch = blockiert)
function dateiListe(mitMail) {
  const { r, files } = S.prepared;
  overlay(`<b style="font-size:17px">Dateien speichern</b>
  <p class="small">Jede Datei einmal antippen – sie landet im Ordner <b>Downloads</b>.${mitMail ? ' Danach die Mail öffnen und die Dateien anhängen.' : ''}</p>
  <div style="display:flex;flex-direction:column;gap:6px;margin:8px 0">${files.map((f, i) => `<a class="btn ghost full" style="justify-content:space-between" data-dl="${i}" href="${URL.createObjectURL(f)}" download="${esc(f.name)}"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">⬇ ${esc(f.name)}</span><small>${Math.ceil(f.size / 1024)} KB</small></a>`).join('')}</div>
  ${mitMail !== false ? `<a class="btn orange full" href="mailto:${encodeURIComponent(SET.email || '')}?subject=${encodeURIComponent(betreff(r))}&body=${encodeURIComponent(mailText(r) + '\n\nDie Dateien sind angehängt.')}" data-act="mailoffen">✉️ E-Mail öffnen</a>` : ''}
  <button class="btn ghost full" style="margin-top:8px" data-act="${mitMail !== false ? 'dlfertig' : 'ovclose'}">${mitMail !== false ? 'Fertig – Bericht ist versendet' : 'Schließen'}</button>`);
}
document.addEventListener('click', e => { const a = e.target.closest('[data-dl]'); if (a) { a.style.opacity = '.55'; a.querySelector('span').textContent = '✓ ' + a.querySelector('span').textContent.replace(/^[⬇✓] /, '') } });
const dateiLaden = f => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove() };
// Dateien nur ablegen (ohne Versand): Laptop → Ordner wählen, iPhone → „In Dateien sichern“, Android → Download-Ordner
async function speichern(files = S.prepared.files) {
  try {
    if (window.showDirectoryPicker && !/Android|iPhone|iPad/i.test(navigator.userAgent)) {
      const dir = await showDirectoryPicker({ id: 'schwall-berichte', mode: 'readwrite' });
      for (const f of files) { const h = await dir.getFileHandle(f.name, { create: true }), w = await h.createWritable(); await w.write(f); await w.close() }
      toast(`${files.length} Dateien im Ordner „${dir.name}“ gespeichert`, 4000); return;
    }
    if (isIOS() && teilbar(files)) { toast('Im nächsten Fenster „In Dateien sichern“ wählen', 4000); await navigator.share({ files }); return }
    if (files.length > 1 && S.prepared && files === S.prepared.files && !istPC()) { dateiListe(false); return }
    files.forEach((f, i) => setTimeout(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove() }, i * 400));
    toast('Dateien werden im Download-Ordner gespeichert', 4000);
  } catch (e) { if (e.name !== 'AbortError') toast('Speichern nicht möglich: ' + e.message) }
}
function download() {
  const { r, files } = S.prepared;
  if (!istPC() && files.length > 1) return dateiListe(true);
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
  const r = S.prepared.r; try { lernen(r) } catch (e) { }
  if (r.typ === 'sl') {
    SLHIST = SLHIST.filter(h => h.id !== r.id); SLHIST.unshift(Object.assign(clone(r), { weg, gesendet: Date.now() })); SLHIST = behalten(SLHIST); SLHIST.forEach((h, i) => { if (i >= 10) h.material.forEach(m => m.fotos = []) });
    await DB.set('slhistory', SLHIST);
    if (S.sl && S.sl.id === r.id) { await DB.del('draft_sl'); S.sl = null; if (S.r && S.r.typ === 'sl') { S.r = S.tb || null; S.tb = null } }
    S.prepared = null;
    overlay(`<div style="font-size:44px">✅</div><b style="font-size:18px">${wartet ? 'Gespeichert – wird gesendet, sobald Netz da ist' : weg === 'upload' ? 'Übertragen' : 'Versand geöffnet'}</b>
  <p class="small">${weg === 'mail' && !wartet ? 'Bitte prüfen, dass die E-Mail in deinem Mail-Programm wirklich abgeschickt wurde.' : ''}</p><button class="btn orange full" data-act="ovsl">Zu den Stundenlohnarbeiten</button><button class="btn ghost full" style="margin-top:8px" data-act="ovhome">Zur Startseite</button>`);
    return;
  }
  const lsIds = new Set(r.material.map(m => m.lsid).filter(Boolean)); if (lsIds.size) { LSL.forEach(e => { if (lsIds.has(e.id)) e.uebernommen = { datum: r.datum, baunr: r.baunr, id: r.id } }); await lsSpeichern() }
  // Verlauf: kompletter Bericht (für „erneut senden“ und „wie letzter Bericht“), max. 30
  HIST = HIST.filter(h => h.id !== r.id); HIST.unshift(Object.assign(clone(r), { weg, gesendet: Date.now() })); HIST = behalten(HIST); HIST.forEach((h, i) => { if (i >= 10) h.material.forEach(m => m.fotos = []) });
  await DB.set('history', HIST); if (!S.r || S.r.id === r.id) { await DB.del('draft'); S.r = null } S.prepared = null;
  overlay(`<div style="font-size:44px">✅</div><b style="font-size:18px">${wartet ? 'Gespeichert – wird gesendet, sobald Netz da ist' : weg === 'upload' ? 'Übertragen' : 'Versand geöffnet'}</b>
  <p class="small">${weg === 'mail' && !wartet ? 'Bitte prüfen, dass die E-Mail in deinem Mail-Programm wirklich abgeschickt wurde.' : ''}</p><button class="btn orange full" data-act="ovhome">Zur Startseite</button>`);
}

// ---------------------------------------------------------------- Ereignisse
document.addEventListener('click', async e => {
  const t = e.target.closest('button,[data-go],[data-delfoto],[data-lsedit],[data-lsday]'); if (!t) return; const ds = t.dataset; const r = S.r;
  if (ds.lsedit) { LSV.offen = LSV.offen === ds.lsedit ? null : ds.lsedit; render(); return }
  if (ds.lsday) { LSV.datum = ds.lsday; LSV.offen = null; render(); scrollTo(0, 0); return }
  if (ds.lsdel) { if (await bestaetigen('Diesen Lieferschein aus der Liste löschen?')) { LSL = LSL.filter(e => e.id !== ds.lsdel); await lsSpeichern(); render() } return }
  if (ds.lschip) { const [id, i] = ds.lschip.split('|'); const e = LSL.find(x => x.id === id); const c = e.ocr.chips[+i]; e.mat = c[1]; e.einh = c[2] || e.einh; e.geaendert = Date.now(); await lsSpeichern(); render(); return }
  if (ds.view) { S.view = ds.view; render(); scrollTo(0, 0); return }
  if (ds.step) { S.step = +ds.step; render(); scrollTo(0, 0); return }
  if (ds.go) { e.preventDefault(); S.step = +ds.go; render(); scrollTo(0, 0); return }
  if (ds.doc) { S.doc = ds.doc; render(); return }
  if (ds.pause) { r.pause = ds.pause; saveDraft(); render(); return }
  if (ds.wetter) { r.wetter = r.wetter === ds.wetter ? '' : ds.wetter; saveDraft(); render(); return }
  if (ds.delap) { r.aps = r.aps.filter(a => a.id !== ds.delap); [...r.personal, ...r.geraete].forEach(x => { if (x.h) delete x.h[ds.delap] }); r.material.forEach(m => { if (m.ap === ds.delap) m.ap = r.aps[0].id }); saveDraft(); render(); return }
  if (ds.del) { const [k, id] = ds.del.split('|'); r[k] = r[k].filter(x => x.id !== id); saveDraft(); render(); return }
  if (ds.delfoto) { const [id, i] = ds.delfoto.split('|'); const m = r.material.find(x => x.id === id); m.fotos.splice(+i, 1); saveDraft(); render(); return }
  if (ds.zus) { const [id, z] = ds.zus.split('|'); const p = r.personal.find(x => x.id === id); p.zus = p.zus === z ? '' : z; saveDraft(); render(); return }
  if (ds.st) { const [k, id, ap, dv] = ds.st.split('|'); const it = r[k].find(x => x.id === id); it.h[ap] = Math.max(0, num(it.h[ap]) + num(dv)); saveDraft(); render(); return }
  if (ds.vorlage) { const h = HIST.find(x => x.id === ds.vorlage); if (h) vorlageMitPruefung(h); return }
  if (ds.matchip) { const [id, i] = ds.matchip.split('|'); const m = r.material.find(x => x.id === id); const c = m.ocr.chips[+i]; m.mat = c[1]; m.einh = c[2]; const sm = SD.mat.find(x => x[0] === c[1]); m.matnr = sm ? sm[1] : ''; m.ocr.auto = m.ocr.auto.filter(f => !f.startsWith('mat')); saveDraft(); render(); return }
  if (ds.resend) { const h = HIST.find(x => x.id === ds.resend); if (h) prepare(clone(h)); return }
  if (ds.slresend) { const h = SLHIST.find(x => x.id === ds.slresend); if (h) prepare(clone(h)); return }
  if (ds.slkopie) { const h = SLHIST.find(x => x.id === ds.slkopie); if (!h || !(await slErsetzen())) return; const n = clone(h); ['weg', 'gesendet'].forEach(k => delete n[k]); Object.assign(n, { id: uid(), datum: today(), sig: '', sigAG: '', agName: '', ausTB: null }); n.material = []; slAktiv(n); toast('Kopie angelegt – Datum, Stunden und Lieferscheine bitte anpassen', 4000); return }
  if (ds.beruf) { const [id, b] = ds.beruf.split('|'); const p = r.personal.find(x => x.id === id); p.beruf = p.beruf === b ? '' : b; if (p.beruf) { BERUF[p.name] = b; DB.set('berufe', BERUF) } saveDraft(); render(); return }
  if (ds.pick) {
    const [k, id] = ds.pick.split('|');
    if (k === 'lslief') { openPicker('lief', l => { const e = LSL.find(x => x.id === id); e.lief = (!SD.lief.includes(l[0]) && liefKurz(l[0])) || l[0]; e.geaendert = Date.now(); lsSpeichern() }); return }
    if (k === 'lsmat') { openPicker('mat', m => { const e = LSL.find(x => x.id === id); e.mat = m[0]; e.matnr = m[1] || ''; e.einh = m[2] || e.einh; e.geaendert = Date.now(); lsSpeichern() }); return }
    if (k === 'von') openPicker('polier', m => { r.von = m[0] });
    if (k === 'lief') openPicker('lief', l => { const x = r.material.find(x => x.id === id); x.lief = (!SD.lief.includes(l[0]) && liefKurz(l[0])) || l[0]; if (x.ocr) x.ocr.auto = x.ocr.auto.filter(f => !f.startsWith('lief')) });
    if (k === 'mat') openPicker('mat', m => { const x = r.material.find(x => x.id === id); x.mat = m[0]; x.matnr = m[1] || ''; x.einh = m[2] || ''; if (x.ocr) x.ocr.auto = x.ocr.auto.filter(f => !f.startsWith('mat')); if (!x.lief && ['MKB', 'BSR'].includes(m[3])) x.lief = m[3] });
    return;
  }
  const a = ds.act; if (!a) return;
  if (a === 'sync') { syncDialog(); return }
  if (a === 'update') { if (!('serviceWorker' in navigator)) return; toast('Suche nach neuer Version …'); const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update().catch(() => { }); setTimeout(() => { if (!window._reloaded) toast('Version ' + APP_VERSION + ' ist aktuell') }, 6000); return }
  if (a === 'syncexport') { await syncExport(); return }
  if (a === 'ovclose') { closeOverlay(); return }
  if (a === 'slstart' || a === 'ovsl') { closeOverlay(); S.view = 'sl'; render(); scrollTo(0, 0); return }
  if (a === 'slweiter') { slAktiv(S.sl); return }
  if (a === 'slneu') { if (await slErsetzen()) { const n = neuerSL(); const t = tbEntwurf(); if (t && t.baunr) Object.assign(n, { baunr: t.baunr, baustelle: t.baustelle, bauteil: t.bauteil, auftrag: t.bauherr || '' }); slAktiv(n) } return }
  if (a === 'slverwerfen') { if (await bestaetigen('Stundenlohn-Entwurf wirklich löschen?')) { S.sl = null; if (S.r && S.r.typ === 'sl') { S.r = S.tb || null; S.tb = null } await DB.del('draft_sl'); render() } return }
  if (a === 'slaustb') { histPicker('Tagesbericht übernehmen', async h => { if (await slErsetzen()) { slAktiv(slAusTB(h)); toast(`Tagesbericht vom ${dateDe(h.datum)} übernommen – jetzt Stunden, Arbeiten und Lieferscheine anpassen`, 4500) } }); return }
  if (a === 'slausentwurf') { const t = tbEntwurf(); if (t && await slErsetzen()) { slAktiv(slAusTB(t)); toast('Tagesbericht-Entwurf übernommen – bitte anpassen', 4000) } return }
  if (a === 'sig2clear') { r.sigAG = ''; saveDraft(); render(); return }
  if (a === 'telefon') { if (S.r && (S.r.personal.length || S.r.baustelle) && !(await bestaetigen('Es gibt schon einen Entwurf. Neuen Bericht per Gespräch beginnen? Der Entwurf wird ersetzt.'))) return; S.r = null; telStart() }
  if (a === 'mic') { if (TEL.listening) { const r2 = TEL.rec; if (r2) r2.stop() } else { try { speechSynthesis.cancel() } catch (e) { } hoeren() } }
  if (a === 'telwdh') telBot(TEL.frage);
  if (a === 'telskip') telAntwort('überspringen');
  if (a === 'telvoice') { TEL.voice = !TEL.voice; if (!TEL.voice) try { speechSynthesis.cancel() } catch (e) { } telRender() }
  if (a === 'telende') telEnde(true);
  if (a === 'lsliste') { if (!LSV.baunr) LSV.baunr = (S.r && S.r.baunr) || (HIST[0] && HIST[0].baunr) || ''; LSV.datum = today(); LSV.offen = null; S.view = 'lieferscheine'; render(); scrollTo(0, 0) }
  if (a === 'lshand') { if (!LSV.baunr) { toast('Bitte zuerst die Baustellen-Nr. eintragen'); return } const prev = lsTag(LSV.baunr, LSV.datum).pop(); const e = { id: uid(), baunr: LSV.baunr, datum: LSV.datum, zeit: Date.now(), lief: prev ? prev.lief : '', mat: prev ? prev.mat : '', matnr: prev ? prev.matnr : '', einh: prev ? prev.einh : 'to', ls: '', menge: '', fotos: [], ocr: null }; LSL.push(e); LSV.offen = e.id; await lsSpeichern(); render() }
  if (a === 'lsbericht') {
    const tag = lsTag(LSV.baunr, LSV.datum);
    if (!S.r || !(S.r.baustelle || S.r.personal.length || S.r.material.length)) { S.r = neuerBericht(); const h = HIST.find(x => x.baunr === LSV.baunr); Object.assign(S.r, { baunr: LSV.baunr, datum: LSV.datum }, h ? { baustelle: h.baustelle, bauteil: h.bauteil, bauherr: h.bauherr } : {}) }
    const n = lsInBericht(S.r, tag, S.r.aps[0].id); S.view = 'erfassung'; S.step = 4; saveDraft(); render(); scrollTo(0, 0);
    toast(`${n} Lieferschein(e) in den Tagesbericht übernommen${S.r.aps.length > 1 ? ' – Arbeitspaket bitte prüfen' : ''}`, 4000);
  }
  if (a === 'lsimport') lsPicker(r);
  if (a === 'install' && installEvt) { installEvt.prompt(); installEvt = null }
  if (a === 'neu') { if (S.r && S.r.typ !== 'sl' && S.r._draft !== false && hatInhalt(S.r) && !(await bestaetigen('Der angefangene Bericht wird verworfen. Wirklich einen neuen Bericht beginnen?'))) return; S.r = neuerBericht(); S.step = 0; S.view = 'erfassung'; saveDraft(); render(); scrollTo(0, 0) }
  if (a === 'weiter') { S.view = 'erfassung'; render() }
  if (a === 'verwerfen') { if (await bestaetigen('Entwurf wirklich löschen?')) { S.r = null; await DB.del('draft'); render() } }
  if (a === 'vorlage') vorlageMitPruefung(HIST[0]);
  if (a === 'vorlagewahl') histPicker('Bericht als Vorlage wählen', h => vorlageMitPruefung(h));
  if (a === 'kolonnewahl') histPicker('Kolonne übernehmen aus …', h => vorlageAus(h, true));
  if (a === 'next') { S.step = Math.min(5, S.step + 1); render(); scrollTo(0, 0) }
  if (a === 'prev') { S.step = Math.max(0, S.step - 1); render(); scrollTo(0, 0) }
  if (a === 'addap') { r.aps.push({ id: uid(), nr: '', text: '' }); saveDraft(); render() }
  if (a === 'addma') openPicker('ma', (m, add) => { if (add) r.personal.push({ id: uid(), name: m[0], nr: m[1], zus: '', h: {}, neu: !SD.ma.some(x => x[0] === m[0]) }); else r.personal = r.personal.filter(p => p.name !== m[0]) }, r.personal.map(p => p.name));
  if (a === 'addge') openPicker('ge', (g, add) => { if (add) r.geraete.push({ id: uid(), name: g[0], nr: g[1], ks: g[2], firma: '', h: {} }); else r.geraete = r.geraete.filter(x => x.name !== g[0]) }, r.geraete.map(g => g.name));
  if (a === 'addmat') { r.material.push({ id: uid(), ap: r.aps[0].id, lief: '', mat: '', matnr: '', einh: '', ls: '', menge: '', fotos: [] }); saveDraft(); render() }
  if (a === 'dupmat') { const l = r.material[r.material.length - 1]; r.material.push({ id: uid(), ap: l.ap, lief: l.lief, mat: l.mat, matnr: l.matnr, einh: l.einh, ls: '', menge: '', fotos: [] }); saveDraft(); render(); setTimeout(() => { const i = document.querySelectorAll('[data-k=ls]'); i[i.length - 1].focus() }, 50) }
  if (a === 'kolonne') { if (!HIST[0]) { toast('Noch kein früherer Bericht vorhanden'); return } vorlageAus(HIST[0], true) }
  if (a === 'copyh') { const f = r.personal.find(p => !p.zus); if (!f) return; r.personal.forEach(p => { if (!p.zus) p.h = { ...f.h } }); saveDraft(); toast('Stunden von ' + f.name + ' für alle übernommen'); render() }
  if (a === 'sigclear') { r.sig = ''; saveDraft(); render() }
  if (a === 'prepare') {
    const err = pruefe(r).filter(x => x.t === 'e'); if (err.length) { toast(`Noch ${err.length} Fehler – bitte korrigieren`); return }
    if (!SET.email && !SET.uploadUrl) { toast('Bitte zuerst in den Einstellungen die E-Mail des Büros eintragen'); return }
    const w = pruefe(r).filter(x => x.t === 'w'); if (w.length && !(await bestaetigen(`${w.length} Hinweis(e) offen (z. B. ${w[0].m}). Trotzdem senden?`, true))) return;
    prepare(r);
  }
  if (a === 'share') share();
  if (a === 'speichern') speichern();
  if (a === 'download') download();
  if (a === 'sharepdf') sharePdf();
  if (a === 'dateiliste') dateiListe(true);
  if (a === 'dlfertig') { closeOverlay(); abgeschlossen('mail') }
  if (a === 'ovclose') closeOverlay();
  if (a === 'ovhome') { closeOverlay(); S.view = 'home'; render(); scrollTo(0, 0) }
  if (a === 'sendqueue') sendQueue();
  if (a === 'setupdone' || a === 'savesettings') {
    SET.polier = $('#s_polier').value.trim(); SET.email = $('#s_email').value.trim(); if ($('#s_url')) SET.uploadUrl = $('#s_url').value.trim();
    if (!SD) { toast('Bitte zuerst die Stammdaten (Excel) laden'); return }
    if (!SET.email && !SET.uploadUrl) { toast('Bitte E-Mail-Adresse des Büros eintragen'); return }
    await DB.set('settings', SET); toast('Gespeichert ✓'); S.view = 'home'; render();
  }
  if (a === 'lernreset') { if (await bestaetigen('Alles Gelernte zu Lieferscheinen löschen?')) { LERN = { alias: {}, lief: {} }; await DB.set('lernen', LERN); render() } }
  if (a === 'reset') { if (await bestaetigen('Wirklich alle Daten auf diesem Handy löschen (Entwurf, Verlauf, Stammdaten, Einstellungen)?')) { for (const k of ['draft', 'draft_sl', 'history', 'slhistory', 'berufe', 'favoriten', 'haeufig', 'queue', 'stammdaten', 'settings', 'lernen', 'lsliste']) await DB.del(k); neuLadenOhneSichern() } }
});
async function slErsetzen() { const d = S.sl; return !(d && (d.baustelle || d.personal.length || d.aps.some(a => a.text))) || await bestaetigen('Der offene Stundenlohn-Entwurf wird ersetzt. Fortfahren?') }
function bestaetigen(text, html) { return new Promise(res => { const o = overlay(`<p style="font-size:16px">${html ? text : esc(text)}</p><div class="row"><button class="btn ghost" id="cn">Nein</button><button class="btn orange" id="cy">Ja</button></div>`); o.querySelector('#cn').onclick = () => { closeOverlay(); res(false) }; o.querySelector('#cy').onclick = () => { closeOverlay(); res(true) } }) }

document.addEventListener('input', e => {
  const t = e.target, ds = t.dataset, r = S.r;
  if (ds.lsf) { const [id, k] = ds.lsf.split('|'); const x = LSL.find(y => y.id === id); x[k] = k === 'menge' ? t.value.replace(',', '.') : t.value; x.geaendert = Date.now(); clearTimeout(window.__lst); window.__lst = setTimeout(lsSpeichern, 400); return }
  if (!r) return;
  if (ds.f) {
    r[ds.f] = t.value;
    if (ds.f === 'baunr') { const h = HIST.find(x => x.baunr === t.value.trim()); if (h && !r.baustelle) { r.baustelle = h.baustelle; r.bauteil = h.bauteil; r.bauherr = h.bauherr; ['baustelle', 'bauteil', 'bauherr'].forEach(k => { const i = document.querySelector(`[data-f=${k}]`); if (i) i.value = r[k] }); toast('Baustellendaten vom letzten Bericht übernommen') } }
  }
  if (ds.ap) r.aps.find(a => a.id === ds.ap)[ds.k] = t.value;
  if (ds.m) { const m = r.material.find(x => x.id === ds.m); m[ds.k] = ds.k === 'menge' ? t.value.replace(',', '.') : t.value; if (m.ocr) { m.ocr.auto = m.ocr.auto.filter(f => f !== ds.k); t.classList.remove('ocr') } }
  if (ds.hin) { const [k, id, ap] = ds.hin.split('|'); r[k].find(x => x.id === id).h[ap] = num(t.value) }
  if (ds.g) r.geraete.find(x => x.id === ds.g).firma = t.value;
  if (ds.pnr) r.personal.find(x => x.id === ds.pnr).nr = t.value.trim();
  saveDraft();
});
document.addEventListener('change', async e => {
  const t = e.target, ds = t.dataset;
  if (t.id === 's_file' && t.files[0]) {
    const info = $('#s_info'); info.textContent = 'Wird gelesen …';
    try { SD = sdErgaenzen(await importStammdaten(t.files[0])); await DB.set('stammdaten', SD); info.innerHTML = `<span class="ok">✓ ${SD.ma.length} Mitarbeiter, ${SD.ge.length} Geräte, ${SD.mat.length} Materialien geladen</span>` }
    catch (err) { info.innerHTML = `<span style="color:var(--rot)">${esc(err.message)}</span>` }
    return;
  }
  if (ds.syncimport && t.files[0]) { closeOverlay(); await syncImport(t.files[0]); t.value = ''; return }
  if (ds.lsscan && t.files.length) { await lsScan([...t.files]); t.value = ''; return }
  if (t.id === 'ls_bnr' || t.id === 'ls_dat') { if (t.id === 'ls_bnr') LSV.baunr = t.value.trim(); else LSV.datum = t.value || today(); LSV.offen = null; render(); return }
  if (!S.r) return;
  if (ds.f && ['datum', 'beginn', 'ende'].includes(ds.f)) render();
  if (ds.k === 'ap' && ds.m) render();
  if (ds.hin) render();
  if (ds.scan && t.files.length) { await scanLieferscheine([...t.files]); t.value = ''; return }
  if (ds.foto && t.files[0] && !S.r.material.find(x => x.id === ds.foto).fotos.length) { await scanLieferscheine([t.files[0]], ds.foto); t.value = ''; return }
  if (ds.foto && t.files[0]) {
    const m = S.r.material.find(x => x.id === ds.foto), f = t.files[0];
    try {
      m.fotos.push(await fotoKomprimieren(f)); saveDraft(); render();
    } catch (err) { toast('Foto konnte nicht gelesen werden') }
  }
});

// Entwurf beim Start laden
DB.get('draft').then(d => { if (d) S.r = d }).catch(() => { }).finally(init);
