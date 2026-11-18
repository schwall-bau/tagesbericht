'use strict';
/* Füllt die Original-Excel-Vorlage (Blatt „Blanko“: Tagesbericht Zeile 1–50, Bautagebuch ab Zeile 51)
   mit den Daten eines Berichts. Formatierung, Formeln und Auswahllisten der Vorlage bleiben erhalten,
   damit das Büro die Datei wie gewohnt bearbeiten kann. Zusätzlich ein Blatt „Lohn“ (eine Zeile je Mitarbeiter/AP). */
(function (root) {
  const AP_COLS = ['J', 'L', 'N', 'P', 'R', 'T', 'V'];
  const n = v => { const x = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(x) ? 0 : x };
  const zahlOderText = v => /^\d+$/.test(String(v || '').trim()) ? parseInt(v, 10) : (v || null);
  const zeit = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return (h * 60 + (m || 0)) / 1440 };
  const umbrechen = (t, max) => { const out = []; String(t || '').split(/\n/).forEach(p => { let l = ''; p.split(/\s+/).forEach(w => { if (!w) return; if ((l + ' ' + w).trim().length > max) { if (l) out.push(l); l = w } else l = (l + ' ' + w).trim() }); if (l) out.push(l) }); return out };

  async function excelFuellen(ExcelJS, vorlage, r, SD, sig, logo) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(vorlage);
    const ws = wb.getWorksheet('Blanko') || wb.worksheets[0];
    const set = (adr, v) => { ws.getCell(adr).value = (v === '' || v === undefined) ? null : v };
    const [y, mo, d] = r.datum.split('-').map(Number);
    set('B8', new Date(Date.UTC(y, mo - 1, d)));
    set('B11', r.baustelle); set('B12', r.bauteil); set('B14', zahlOderText(r.baunr));
    set('E14', r.temp === '' ? null : n(r.temp)); set('E15', r.wetter);
    const aps = r.aps.slice(0, 7);
    aps.forEach((a, i) => { set(AP_COLS[i] + '1', a.text); set(AP_COLS[i] + '13', zahlOderText(a.nr)) });
    const apCol = id => { const i = aps.findIndex(a => a.id === id); return i < 0 ? null : AP_COLS[i] };
    r.personal.slice(0, 14).forEach((p, i) => {
      const row = 17 + i; set('B' + row, p.name); set('A' + row, p.nr || null); set('F' + row, p.zus || null);
      if (!p.zus) Object.entries(p.h || {}).forEach(([id, v]) => { const c = apCol(id); if (c && n(v)) set(c + row, n(v)) });
    });
    r.geraete.slice(0, 13).forEach((g, i) => {
      const row = 32 + i; set('C' + row, g.name); set('A' + row, g.nr || null); set('B' + row, zahlOderText(g.ks));
      Object.entries(g.h || {}).forEach(([id, v]) => { const c = apCol(id); if (c && n(v)) set(c + row, n(v)) });
    });
    // Baustoffe wie in der Vorlage: ---Lieferant---, Material [Einheit], darunter Lieferschein + Menge
    const L = []; const multi = new Set(r.material.map(m => m.ap)).size > 1; let la = null, ll = null, lm = null;
    const pos = (arr, k) => { const i = arr.indexOf(k); return i < 0 ? 999 : i }, LL = [...new Set(r.material.map(m => m.lief))], MM = [...new Set(r.material.map(m => m.mat))];
    r.material.map((m, i) => [m, i]).sort((a, b) => (r.aps.findIndex(x => x.id === a[0].ap) - r.aps.findIndex(x => x.id === b[0].ap)) || (pos(LL, a[0].lief) - pos(LL, b[0].lief)) || (pos(MM, a[0].mat) - pos(MM, b[0].mat)) || (a[1] - b[1])).map(x => x[0]).forEach(m => {
      if (multi && m.ap !== la) { const a = r.aps.find(x => x.id === m.ap); L.push(['AP ' + (a && a.nr || '?'), null]); la = m.ap; ll = lm = null }
      if (m.lief !== ll) { L.push(['---' + m.lief + '---', null]); ll = m.lief; lm = null }
      if (m.mat !== lm) { L.push([m.mat + (m.einh ? ' [' + m.einh + ']' : ''), null]); lm = m.mat }
      L.push([m.ls || '', n(m.menge)]);
    });
    r.geraete.filter(g => g.firma).forEach(g => L.push([g.firma, null]));
    L.slice(0, 42).forEach(([y1, z1], i) => { set('Y' + (3 + i), y1); set('Z' + (3 + i), z1) });
    set('J46', r.bem);
    set('B47', zeit(r.beginn)); set('C47', zeit(r.ende)); set('D47', zeit(r.pause));
    // Bautagebuch-Teil (Rest kommt per Formel aus dem Tagesbericht)
    set('J55', r.bauherr); set('J64', r.wasser);
    umbrechen(r.vork, 95).slice(0, 10).forEach((l, i) => set('J' + (85 + i), l));
    // Unterschrift des Poliers bei „Ausgestellt“ (Tagesbericht und Bautagebuch)
    if (sig) { const id = wb.addImage({ base64: sig, extension: 'png' }); ws.addImage(id, { tl: { col: 3.1, row: 47.05 }, ext: { width: 150, height: 38 } }); ws.addImage(id, { tl: { col: 3.1, row: 97.05 }, ext: { width: 150, height: 38 } }) }
    // Auswahlliste Mitarbeiter aus den Stammdaten des Handys (nicht in der Vorlage gespeichert)
    const dd = wb.getWorksheet('DropDown');
    if (dd && SD) SD.ma.slice(0, 114).forEach((m, i) => { dd.getCell('A' + (2 + i)).value = m[0]; dd.getCell('B' + (2 + i)).value = zahlOderText(m[1]) });
    // Blatt „Lohn“: eine Zeile je Mitarbeiter und AP (ersetzt die CSV)
    const lo = wb.addWorksheet('Lohn');
    lo.columns = [{ header: 'Datum', width: 11 }, { header: 'Baustellen-Nr.', width: 13 }, { header: 'Pers.-Nr.', width: 10 }, { header: 'Name', width: 26 }, { header: 'AP', width: 7 }, { header: 'Stunden', width: 9 }, { header: 'Kürzel', width: 8 }, { header: 'Art', width: 9 }];
    const dt = new Date(Date.UTC(y, mo - 1, d)), apNr = id => (r.aps.find(a => a.id === id) || {}).nr || '';
    r.personal.forEach(p => {
      if (p.zus) lo.addRow([dt, zahlOderText(r.baunr), p.nr || '', p.name, '', 0, p.zus, 'Personal']);
      else Object.entries(p.h || {}).filter(([, v]) => n(v)).forEach(([id, v]) => lo.addRow([dt, zahlOderText(r.baunr), p.nr || '', p.name, zahlOderText(apNr(id)), n(v), '', 'Personal']));
    });
    r.geraete.forEach(g => Object.entries(g.h || {}).filter(([, v]) => n(v)).forEach(([id, v]) => lo.addRow([dt, zahlOderText(r.baunr), g.ks || '', g.name + (g.firma ? ' (' + g.firma + ')' : ''), zahlOderText(apNr(id)), n(v), '', 'Gerät'])));
    lo.getRow(1).font = { bold: true }; lo.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    lo.getColumn(1).numFmt = 'dd.mm.yyyy'; lo.getColumn(6).numFmt = '0.00';
    lo.autoFilter = { from: 'A1', to: 'H1' };
    if (r.personal.length > 14 || r.geraete.length > 13) lo.addRow([]), lo.addRow(['Hinweis: Mehr als 14 Personen bzw. 13 Geräte – im Formular stehen nur die ersten, hier stehen alle.']);
    // Layout wie das PDF der App: Logo statt Textzeilen, Adresse in einer Zeile, orange Linie unter dem Titel, Dauer in Dezimalstunden
    const ADR = 'Neue Welt 50 · 88471 Laupheim · Tel. (073 92) 9703-0';
    ['B3', 'B4', 'B5', 'B53', 'B54', 'B55'].forEach(a => set(a, null)); set('B6', ADR); set('B56', ADR);
    if (logo) { const lid = wb.addImage({ base64: logo, extension: 'png' }); [2, 52].forEach(row => ws.addImage(lid, { tl: { col: 1.15, row: row + 0.08 }, ext: { width: 160, height: 45 } })) }
    // Stil immer als Kopie setzen – ExcelJS teilt Stil-Objekte zwischen Zellen
    const stil = (adr, f) => { const c = ws.getCell(adr); c.style = f(JSON.parse(JSON.stringify(c.style || {}))) };
    ['B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach(c => [2, 52].forEach(row => stil(c + row, s => Object.assign(s, { border: Object.assign({}, s.border, { bottom: { style: 'medium', color: { argb: 'FFED7102' } } }) }))));
    ['B6', 'B56'].forEach(a => stil(a, s => Object.assign(s, { font: Object.assign({}, s.font, { size: 6.5 }) })));
    ws.getCell('G47').value = { formula: '(C47-B47-D47)*24' };
    ['G47', 'G97'].forEach(a => stil(a, s => Object.assign(s, { numFmt: '0.00 "h"' })));
    // Druck: A4 hoch, 12 mm Rand, Tagesbericht und Bautagebuch je eine Seite
    ws.getRow(50).addPageBreak();
    ws.pageSetup = Object.assign({}, ws.pageSetup, { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 2, printArea: 'B1:Z98', horizontalCentered: true,
      margins: { left: 0.47, right: 0.47, top: 0.47, bottom: 0.47, header: 0, footer: 0 } });
    ws.views = [{ showGridLines: false, zoomScale: 100 }];
    ws.name = ((r.baunr || 'TB') + ' ' + r.datum.split('-').reverse().join('.')).slice(0, 31);
    wb.calcProperties = Object.assign(wb.calcProperties || {}, { fullCalcOnLoad: true });
    return wb.xlsx.writeBuffer();
  }
  root.excelFuellen = excelFuellen;
  if (typeof module !== 'undefined') module.exports = { excelFuellen };
})(typeof window !== 'undefined' ? window : globalThis);
