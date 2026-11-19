'use strict';
/* Füllt die Original-Excel-Vorlage (Blatt „Blanko“: Tagesbericht Zeile 1–50, Bautagebuch ab Zeile 51).
   Es werden NUR Zellwerte in der von Excel gespeicherten Datei ersetzt – Formatierung, Formeln, Auswahllisten,
   Tabellen und Druckeinstellungen bleiben unverändert. Dazu kommen Unterschrift (Bild) und ein Blatt „Lohn“. */
(function (root) {
  const AP_COLS = ['J', 'L', 'N', 'P', 'R', 'T', 'V'];
  const n = v => { const x = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(x) ? 0 : x };
  const zahlOderText = v => /^\d+$/.test(String(v ?? '').trim()) ? parseInt(v, 10) : (v || null);
  const zeit = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return (h * 60 + (m || 0)) / 1440 };
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const colNr = c => [...c].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
  const umbrechen = (t, max) => { const out = []; String(t || '').split(/\n/).forEach(p => { let l = ''; p.split(/\s+/).forEach(w => { if (!w) return; if ((l + ' ' + w).trim().length > max) { if (l) out.push(l); l = w } else l = (l + ' ' + w).trim() }); if (l) out.push(l) }); return out };
  const serial = iso => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5 };

  function zellXml(ref, s, val) {
    const sa = s ? ` s="${s}"` : '';
    if (val === null || val === undefined || val === '') return `<c r="${ref}"${sa}/>`;
    if (typeof val === 'number' && isFinite(val)) return `<c r="${ref}"${sa}><v>${val}</v></c>`;
    return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
  }
  // Wert einer Zelle setzen (Stil bleibt); fehlt die Zelle oder Zeile, wird sie an der richtigen Stelle eingefügt
  function setze(xml, ref, val) {
    const re = new RegExp('<c r="' + ref + '"((?:\\s+[a-zA-Z:]+="[^"]*")*)\\s*(?:/>|>([\\s\\S]*?)</c>)');
    const m = xml.match(re);
    if (m) {
      if (m[2] && /<f[ >\/]/.test(m[2])) return xml;   // Formelzellen nie überschreiben
      const s = (m[1].match(/\ss="(\d+)"/) || [])[1];
      return xml.slice(0, m.index) + zellXml(ref, s, val) + xml.slice(m.index + m[0].length);
    }
    if (val === null || val === undefined || val === '') return xml;
    const [, col, row] = ref.match(/^([A-Z]+)(\d+)$/), neu = zellXml(ref, null, val);
    const rr = new RegExp('<row r="' + row + '"([^>]*?)(?:/>|>([\\s\\S]*?)</row>)'), rm = xml.match(rr);
    if (rm) {
      const inhalt = rm[2] || '', zellen = [...inhalt.matchAll(/<c r="([A-Z]+)\d+"/g)];
      const nach = zellen.find(z => colNr(z[1]) > colNr(col));
      const neuInhalt = nach ? inhalt.slice(0, nach.index) + neu + inhalt.slice(nach.index) : inhalt + neu;
      return xml.slice(0, rm.index) + `<row r="${row}"${rm[1]}>${neuInhalt}</row>` + xml.slice(rm.index + rm[0].length);
    }
    const zeilen = [...xml.matchAll(/<row r="(\d+)"/g)], danach = zeilen.find(z => +z[1] > +row);
    const neueZeile = `<row r="${row}">${neu}</row>`;
    if (danach) return xml.slice(0, danach.index) + neueZeile + xml.slice(danach.index);
    return xml.replace('</sheetData>', neueZeile + '</sheetData>').replace('<sheetData/>', `<sheetData>${neueZeile}</sheetData>`);
  }
  function bildAnker(id, rid, col, row, w, h) {
    const E = 9525;
    return `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${6 * E}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${3 * E}</xdr:rowOff></xdr:from><xdr:ext cx="${w * E}" cy="${h * E}"/>` +
      `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="Unterschrift ${id}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
      `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w * E}" cy="${h * E}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
  }

  async function excelFuellen(JSZip, vorlage, r, SD, sig) {
    const zip = await JSZip.loadAsync(vorlage);
    const S1 = 'xl/worksheets/sheet1.xml';
    let x = await zip.file(S1).async('string');
    const set = (ref, v) => { x = setze(x, ref, v) };
    set('B8', serial(r.datum));
    set('B11', r.baustelle || null); set('B12', r.bauteil || null); set('B14', zahlOderText(r.baunr));
    set('E14', r.temp === '' || r.temp == null ? null : n(r.temp)); set('E15', r.wetter || null);
    const aps = r.aps.slice(0, 7);
    aps.forEach((a, i) => { set(AP_COLS[i] + '1', a.text || null); set(AP_COLS[i] + '13', zahlOderText(a.nr)) });
    const apCol = id => { const i = aps.findIndex(a => a.id === id); return i < 0 ? null : AP_COLS[i] };
    r.personal.slice(0, 14).forEach((p, i) => {
      const row = 17 + i; set('B' + row, p.name); set('F' + row, p.zus || null);
      if (!p.zus) Object.entries(p.h || {}).forEach(([id, v]) => { const c = apCol(id); if (c && n(v)) set(c + row, n(v)) });
    });
    r.geraete.slice(0, 13).forEach((g, i) => {
      const row = 32 + i; set('C' + row, g.name);
      Object.entries(g.h || {}).forEach(([id, v]) => { const c = apCol(id); if (c && n(v)) set(c + row, n(v)) });
    });
    // Baustoffe gesammelt: je AP → Lieferant → Material, darunter Lieferschein + Menge
    const L = [], pos = (arr, k) => { const i = arr.indexOf(k); return i < 0 ? 999 : i }, LL = [...new Set(r.material.map(m => m.lief))], MM = [...new Set(r.material.map(m => m.mat))];
    const multi = new Set(r.material.map(m => m.ap)).size > 1; let la = null, ll = null, lm = null;
    r.material.map((m, i) => [m, i]).sort((a, b) => (r.aps.findIndex(q => q.id === a[0].ap) - r.aps.findIndex(q => q.id === b[0].ap)) || (pos(LL, a[0].lief) - pos(LL, b[0].lief)) || (pos(MM, a[0].mat) - pos(MM, b[0].mat)) || (a[1] - b[1])).map(q => q[0]).forEach(m => {
      if (multi && m.ap !== la) { const a = r.aps.find(q => q.id === m.ap); L.push(['AP ' + (a && a.nr || '?'), null]); la = m.ap; ll = lm = null }
      if (m.lief !== ll) { L.push(['---' + (m.lief || '?') + '---', null]); ll = m.lief; lm = null }
      if (m.mat !== lm) { L.push([(m.mat || '?') + (m.einh ? ' [' + m.einh + ']' : ''), null]); lm = m.mat }
      L.push([(m.ls || '') + (m.lsdatum && m.lsdatum !== r.datum ? ' (' + m.lsdatum.split('-').reverse().join('.').slice(0, 6) + ')' : ''), n(m.menge)]);
    });
    r.geraete.filter(g => g.firma).forEach(g => L.push([g.firma, null]));
    L.slice(0, 42).forEach(([a, b], i) => { set('Y' + (3 + i), a); set('Z' + (3 + i), b) });
    set('J46', r.bem || null);
    set('B47', zeit(r.beginn)); set('C47', zeit(r.ende)); set('D47', zeit(r.pause));
    set('J55', r.bauherr || null); set('J64', r.wasser || null);
    umbrechen(r.vork, 72).slice(0, 10).forEach((l, i) => set('J' + (85 + i), l));
    zip.file(S1, x);

    // Mitarbeiterliste für Auswahl und Pers.-Nr. (aus den Stammdaten des Handys)
    const liste = ((SD && SD.ma) || []).map(m => [m[0], m[1]]);
    r.personal.forEach(p => { if (p.name && !liste.some(m => m[0] === p.name)) liste.push([p.name, p.nr || '']) });
    if (liste.length) {
      let d = await zip.file('xl/worksheets/sheet2.xml').async('string');
      liste.slice(0, 114).forEach((m, i) => { d = setze(d, 'A' + (2 + i), m[0]); d = setze(d, 'B' + (2 + i), m[1] ? String(m[1]) : null) });
      zip.file('xl/worksheets/sheet2.xml', d);
    }
    // Unterschrift des Poliers (Tagesbericht und Bautagebuch)
    if (sig) {
      zip.file('xl/media/image2.png', sig.split(',')[1], { base64: true });
      let rel = await zip.file('xl/drawings/_rels/drawing1.xml.rels').async('string');
      rel = rel.replace('</Relationships>', '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/></Relationships>');
      zip.file('xl/drawings/_rels/drawing1.xml.rels', rel);
      let dr = await zip.file('xl/drawings/drawing1.xml').async('string');
      dr = dr.replace('<!--SIG-->', bildAnker(10, 'rId2', 2, 47, 150, 38) + bildAnker(11, 'rId2', 2, 97, 150, 38));
      zip.file('xl/drawings/drawing1.xml', dr);
    }
    // Blatt „Lohn“: eine Zeile je Mitarbeiter und AP, dazu Gerätestunden
    const apNr = id => (r.aps.find(a => a.id === id) || {}).nr || '', dt = r.datum.split('-').reverse().join('.');
    const zeilen = [['Datum', 'Baustellen-Nr.', 'Pers.-Nr.', 'Name', 'AP', 'Stunden', 'Kürzel', 'Art']];
    r.personal.forEach(p => {
      if (p.zus) zeilen.push([dt, r.baunr, p.nr || '', p.name, '', 0, p.zus, 'Personal']);
      else Object.entries(p.h || {}).filter(([, v]) => n(v)).forEach(([id, v]) => zeilen.push([dt, r.baunr, p.nr || '', p.name, apNr(id), n(v), '', 'Personal']));
    });
    r.geraete.forEach(g => Object.entries(g.h || {}).filter(([, v]) => n(v)).forEach(([id, v]) => zeilen.push([dt, r.baunr, g.ks || '', g.name + (g.firma ? ' (' + g.firma + ')' : ''), apNr(id), n(v), '', 'Gerät'])));
    const COL = 'ABCDEFGH';
    const sd = zeilen.map((z, i) => `<row r="${i + 1}">` + z.map((v, j) => zellXml(COL[j] + (i + 1), null, typeof v === 'number' ? v : (v === '' ? null : String(v)))).join('') + '</row>').join('');
    zip.file('xl/worksheets/sheet9.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cols><col min="1" max="2" width="13" customWidth="1"/><col min="3" max="3" width="10" customWidth="1"/><col min="4" max="4" width="30" customWidth="1"/><col min="5" max="8" width="9" customWidth="1"/></cols><sheetData>' + sd + '</sheetData></worksheet>');
    let wb = await zip.file('xl/workbook.xml').async('string');
    const sid = Math.max(...[...wb.matchAll(/sheetId="(\d+)"/g)].map(q => +q[1])) + 1;
    wb = wb.replace('</sheets>', `<sheet name="Lohn" sheetId="${sid}" r:id="rIdLohn"/></sheets>`);
    zip.file('xl/workbook.xml', wb);
    let wr = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    wr = wr.replace('</Relationships>', '<Relationship Id="rIdLohn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet9.xml"/></Relationships>');
    zip.file('xl/_rels/workbook.xml.rels', wr);
    let ct = await zip.file('[Content_Types].xml').async('string');
    ct = ct.replace('</Types>', '<Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    zip.file('[Content_Types].xml', ct);
    return zip.generateAsync({ type: typeof window !== 'undefined' ? 'arraybuffer' : 'nodebuffer', compression: 'DEFLATE' });
  }

  // ---------------------------------------------------------------- Stundenlohnbericht
  const sumH = o => Object.values(o.h || {}).reduce((a, b) => a + n(b), 0);
  // gemeinsame Aufbereitung für Excel und PDF
  function slDaten(r, breite) {
    const arb = [];
    r.aps.forEach(a => { if (!a.text && !a.nr) return; if (arb.length) arb.push(''); umbrechen((a.nr ? 'AP ' + a.nr + ': ' : '') + (a.text || ''), breite || 46).forEach(l => arb.push(l)) });
    if (r.bem) { if (arb.length) arb.push(''); umbrechen('Bemerkung: ' + r.bem, breite || 46).forEach(l => arb.push(l)) }
    const g = new Map();
    r.material.forEach(m => { const k = (m.lief || '') + '|' + (m.mat || '') + '|' + (m.einh || ''); if (!g.has(k)) g.set(k, { lief: m.lief || '', mat: m.mat || '', einh: m.einh || '', menge: 0, ls: [] }); const x = g.get(k); x.menge += n(m.menge); if (m.ls) x.ls.push(m.ls) });
    return {
      pers: r.personal.map(p => ({ name: p.name, nr: p.nr || '', beruf: p.beruf || '', std: sumH(p) })),
      arb, mat: [...g.values()],
      ger: r.geraete.map(x => ({ anz: 1, name: x.name + (x.firma ? ' (' + x.firma + ')' : ''), ks: x.ks || '', std: sumH(x) }))
    };
  }
  const datumKurz = iso => iso ? iso.split('-').reverse().join('.') : '';
  async function slFuellen(JSZip, vorlage, r) {
    const zip = await JSZip.loadAsync(vorlage), D = slDaten(r);
    const S1 = 'xl/worksheets/sheet1.xml'; let x = await zip.file(S1).async('string');
    const set = (ref, v) => { x = setze(x, ref, v) };
    set('H1', [r.baunr, r.baustelle].filter(Boolean).join(' ') + (r.bauteil ? ', ' + r.bauteil : ''));
    set('H3', serial(r.datum));
    set('F6', r.auftrag || null); set('K8', r.auftragVom ? serial(r.auftragVom) : null);
    D.pers.slice(0, 9).forEach((p, i) => { const row = 11 + i; set('A' + row, p.name); set('F' + row, p.beruf || null); set('G' + row, p.std || null) });
    if (D.pers.length) { set('A20', 'Summe'); set('G20', D.pers.reduce((a, p) => a + p.std, 0)) }
    D.arb.slice(0, 40).forEach((l, i) => set('I' + (11 + i), l || null));
    D.mat.slice(0, 11).forEach((m, i) => { const row = 25 + i; set('A' + row, m.menge || null); set('B' + row, ({ to: 't', m3: 'm³' })[m.einh] || m.einh || null); set('C' + row, m.mat + (m.lief ? ' (' + m.lief + ')' : '')); set('H' + row, m.ls.length ? m.ls.length + ' LS' : null) });
    D.ger.slice(0, 11).forEach((g, i) => { const row = 40 + i; set('A' + row, g.anz); set('B' + row, g.name); set('G' + row, g.ks || null); set('H' + row, g.std || null) });
    set('B51', r.von || null); set('E51', serial(r.datum));
    if (r.agName) set('G51', r.agName);
    if (r.sigAG) set('I51', datumKurz(r.datum));
    // Unterschriften (Polier links, Auftraggeber Mitte)
    const bilder = [];
    if (r.sig) bilder.push([r.sig, 0]); if (r.sigAG) bilder.push([r.sigAG, 5]);
    if (bilder.length) {
      let rel = '', anker = '';
      bilder.forEach(([b, col], i) => { zip.file(`xl/media/sl_sig${i + 1}.png`, b.split(',')[1], { base64: true }); rel += `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/sl_sig${i + 1}.png"/>`; anker += bildAnker(i + 2, 'rIdS' + (i + 1), col, 51, 170, 45) });
      zip.file('xl/drawings/drawing1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' + anker + '</xdr:wsDr>');
      zip.file('xl/drawings/_rels/drawing1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rel + '</Relationships>');
      let sr = await zip.file('xl/worksheets/_rels/sheet1.xml.rels').async('string');
      sr = sr.replace('</Relationships>', '<Relationship Id="rIdDr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
      zip.file('xl/worksheets/_rels/sheet1.xml.rels', sr);
      x = x.replace(/(<pageSetup[^>]*\/>(?:<headerFooter[\s\S]*?<\/headerFooter>|<headerFooter[^>]*\/>)?(?:<rowBreaks[\s\S]*?<\/rowBreaks>)?(?:<colBreaks[\s\S]*?<\/colBreaks>)?)/, '$1<drawing r:id="rIdDr"/>');
      let ct = await zip.file('[Content_Types].xml').async('string');
      if (!/Extension="png"/i.test(ct)) ct = ct.replace('<Override', '<Default Extension="png" ContentType="image/png"/><Override');
      ct = ct.replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
      zip.file('[Content_Types].xml', ct);
    }
    zip.file(S1, x);
    // Blatt „Lieferscheine“: jeder Lieferschein einzeln (Fotos stehen im PDF als Anlage)
    const zeilen = [['Datum', 'Baustellen-Nr.', 'Lieferant', 'Material', 'Lieferschein-Nr.', 'Menge', 'Einheit']];
    r.material.forEach(m => zeilen.push([datumKurz(m.lsdatum || r.datum), r.baunr || '', m.lief || '', m.mat || '', m.ls || '', n(m.menge), m.einh || '']));
    const COL = 'ABCDEFG';
    const sd = zeilen.map((z, i) => `<row r="${i + 1}">` + z.map((v, j) => zellXml(COL[j] + (i + 1), null, typeof v === 'number' ? v : (v === '' ? null : String(v)))).join('') + '</row>').join('');
    zip.file('xl/worksheets/sheet9.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cols><col min="1" max="2" width="13" customWidth="1"/><col min="3" max="3" width="18" customWidth="1"/><col min="4" max="4" width="30" customWidth="1"/><col min="5" max="7" width="14" customWidth="1"/></cols><sheetData>' + sd + '</sheetData></worksheet>');
    let wb = await zip.file('xl/workbook.xml').async('string');
    const sid = Math.max(...[...wb.matchAll(/sheetId="(\d+)"/g)].map(q => +q[1])) + 1;
    wb = wb.replace('</sheets>', `<sheet name="Lieferscheine" sheetId="${sid}" r:id="rIdLS"/></sheets>`); zip.file('xl/workbook.xml', wb);
    let wr = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    wr = wr.replace('</Relationships>', '<Relationship Id="rIdLS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet9.xml"/></Relationships>'); zip.file('xl/_rels/workbook.xml.rels', wr);
    let ct2 = await zip.file('[Content_Types].xml').async('string');
    ct2 = ct2.replace('</Types>', '<Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'); zip.file('[Content_Types].xml', ct2);
    return zip.generateAsync({ type: typeof window !== 'undefined' ? 'arraybuffer' : 'nodebuffer', compression: 'DEFLATE' });
  }
  root.slFuellen = slFuellen; root.slDaten = slDaten;
  root.excelFuellen = excelFuellen;
  if (typeof module !== 'undefined') module.exports = { excelFuellen, setze };
})(typeof window !== 'undefined' ? window : globalThis);
