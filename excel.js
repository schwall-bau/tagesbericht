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
  function setze(xml, ref, val, hart) {
    const re = new RegExp('<c r="' + ref + '"((?:\\s+[a-zA-Z:]+="[^"]*")*)\\s*(?:/>|>([\\s\\S]*?)</c>)');
    const m = xml.match(re);
    if (m) {
      if (m[2] && /<f[ >\/]/.test(m[2]) && !hart) return xml;   // Formelzellen nie überschreiben (außer ausdrücklich)
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
    // Bautagebuch „Art der geleisteten Arbeiten“: Vorlage holt die AP-Texte per Formel; hat der Polier sie geändert, steht sein Text dort
    if (r.btbArb && String(r.btbArb).trim()) { const z = umbrechen(r.btbArb, 70); for (let i = 0; i < 15; i++) x = setze(x, 'K' + (69 + i), z[i] || null, true) }
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
    try { await formelnRechnen(zip, S1, 'Blanko') } catch (e) { console.error('Formeln', e) }
    return zip.generateAsync({ type: typeof window !== 'undefined' ? 'arraybuffer' : 'nodebuffer', compression: 'DEFLATE' });
  }

  // ---------------------------------------------------------------- Stundenlohnbericht
  const sumH = o => Object.values(o.h || {}).reduce((a, b) => a + n(b), 0);
  // gemeinsame Aufbereitung für Excel und PDF
  function slDaten(r, breite) {
    const arb = [];
    r.aps.forEach(a => { if (!a.text && !a.nr) return; if (arb.length) arb.push(''); umbrechen((a.nr ? 'AP ' + a.nr + ': ' : '') + (a.text || ''), breite || 46).forEach(l => arb.push(l)) });
    if (r.bem) { if (arb.length) arb.push(''); umbrechen('Bemerkung: ' + r.bem, breite || 46).forEach(l => arb.push(l)) }
    // jeder Lieferschein eine eigene Zeile – auch gleiche Lieferscheine vom selben Lieferanten werden NICHT zusammengezählt
    const g = r.material.map(m => ({ lief: m.lief || '', mat: m.mat || '', einh: m.einh || '', menge: n(m.menge), ls: m.ls ? [m.ls] : [] }));
    return {
      pers: r.personal.map(p => ({ name: p.name, nr: p.nr || '', beruf: p.beruf || '', std: sumH(p) })),
      arb, mat: g,
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
    D.mat.slice(0, 11).forEach((m, i) => { const row = 25 + i; set('A' + row, m.menge || null); set('B' + row, ({ to: 't', m3: 'm³' })[m.einh] || m.einh || null); set('C' + row, m.mat + (m.lief ? ' (' + m.lief + ')' : '')); set('H' + row, m.ls.length ? 'LS ' + m.ls[0] : null) });
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
    try { await formelnRechnen(zip, S1, 'Blanko') } catch (e) { console.error('Formeln', e) }
    return zip.generateAsync({ type: typeof window !== 'undefined' ? 'arraybuffer' : 'nodebuffer', compression: 'DEFLATE' });
  }
  root.slFuellen = slFuellen; root.slDaten = slDaten;

  // ---------------------------------------------------------------- Formeln berechnen (für Vorschau/PDF und Programme, die nicht selbst rechnen)
  const colBuch = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s };
  const xmlText = t => String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  async function sharedStrings(zip) {
    const f = zip.file('xl/sharedStrings.xml'); if (!f) return [];
    const x = await f.async('string');
    return [...x.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => xmlText([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  }
  // Zellen eines Blatts lesen: Map "B8" → { s, t, f, v, roh }
  function zellenLesen(xml, ss) {
    const Z = new Map();
    for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = m[2], inh = m[3] || '', s = (at.match(/\ss="(\d+)"/) || [])[1], t = (at.match(/\st="(\w+)"/) || [])[1];
      const fm = inh.match(/<f([^>]*)(?:\/>|>([\s\S]*?)<\/f>)/), vm = inh.match(/<v>([\s\S]*?)<\/v>/);
      let v = null;
      if (t === 'inlineStr') v = xmlText([...inh.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(q => q[1]).join(''));
      else if (vm) v = t === 's' ? ss[+vm[1]] : t === 'str' || t === 'e' ? xmlText(vm[1]) : t === 'b' ? vm[1] === '1' : parseFloat(vm[1]);
      Z.set(m[1], { s, t, v, f: fm ? { at: fm[1], txt: fm[2] != null ? xmlText(fm[2]) : null } : null, roh: m[0] });
    }
    return Z;
  }
  const NA = { err: '#N/A' }, REF = { err: '#REF!' }, istErr = v => v && typeof v === 'object' && v.err;
  const zahlW = v => v == null || v === '' ? 0 : typeof v === 'number' ? v : typeof v === 'boolean' ? +v : (isNaN(+v) ? 0 : +v);
  // Formel → Wert (unterstützt die Formeln der Schwall-Vorlagen: Bezüge, SUM, IF, ISNA, IFERROR, VLOOKUP, TEXT, + - * / &, Vergleiche)
  function formelWert(txt, holen, bereich) {
    const tk = []; let i = 0; const s = txt;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue }
      if (c === '"') { let j = i + 1, out = ''; while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { out += '"'; j += 2; continue } break } out += s[j++] } tk.push({ k: 'str', v: out }); i = j + 1; continue }
      let m = s.slice(i).match(/^#REF!|^#N\/A/); if (m) { tk.push({ k: 'err', v: m[0] }); i += m[0].length; continue }
      m = s.slice(i).match(/^(?:([A-Za-z0-9_]+|'[^']+')!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/);
      if (m && !/^[A-Z]+\(/.test(s.slice(i))) { tk.push({ k: 'ref', sheet: m[1] ? m[1].replace(/'/g, '') : null, a: m[2].replace(/\$/g, ''), b: m[3] ? m[3].replace(/\$/g, '') : null }); i += m[0].length; continue }
      m = s.slice(i).match(/^\d+(\.\d+)?/); if (m) { tk.push({ k: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue }
      m = s.slice(i).match(/^([A-Z][A-Z0-9.]*)\(/); if (m) { tk.push({ k: 'fn', v: m[1] }); i += m[0].length; continue }
      m = s.slice(i).match(/^(<>|<=|>=|[-+*\/&=<>(),:;])/); if (m) { tk.push({ k: 'op', v: m[0] }); i += m[0].length; continue }
      throw new Error('Formel nicht lesbar: ' + s);
    }
    let p = 0; const peek = () => tk[p], nimm = () => tk[p++];
    const wert = x => x && x.range ? (x.cells.length ? holen(x.cells[0][0], x.cells[0][1]) : null) : x;
    const vergleich = () => { let a = add(); while (peek() && peek().k === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) { const o = nimm().v, b = add(); a = cmp(wert(a), wert(b), o) } return a };
    const cmp = (a, b, o) => { if (istErr(a)) return a; if (istErr(b)) return b; const num = (typeof a === 'number' || a == null) && (typeof b === 'number' || b == null) && !(a == null && b == null);
      let x = a, y = b; if (!num) { x = a == null ? '' : String(a).toLowerCase(); y = b == null ? '' : String(b).toLowerCase() } else { x = zahlW(a); y = zahlW(b) }
      return { '=': x === y, '<>': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[o] };
    const add = () => { let a = mul(); while (peek() && peek().k === 'op' && ['+', '-', '&'].includes(peek().v)) { const o = nimm().v, b = mul(); const x = wert(a), y = wert(b); if (istErr(x)) a = x; else if (istErr(y)) a = y; else a = o === '&' ? (x == null ? '' : String(x)) + (y == null ? '' : String(y)) : o === '+' ? zahlW(x) + zahlW(y) : zahlW(x) - zahlW(y) } return a };
    const mul = () => { let a = un(); while (peek() && peek().k === 'op' && ['*', '/'].includes(peek().v)) { const o = nimm().v, b = un(); const x = wert(a), y = wert(b); if (istErr(x)) a = x; else if (istErr(y)) a = y; else a = o === '*' ? zahlW(x) * zahlW(y) : zahlW(y) ? zahlW(x) / zahlW(y) : { err: '#DIV/0!' } } return a };
    const un = () => { if (peek() && peek().k === 'op' && peek().v === '-') { nimm(); const v = wert(un()); return istErr(v) ? v : -zahlW(v) } if (peek() && peek().k === 'op' && peek().v === '+') { nimm(); return un() } return prim() };
    const zelle = ref => { const m = ref.match(/^([A-Z]+)(\d+)$/); return [colNr(m[1]), +m[2]] };
    const prim = () => {
      const t = nimm(); if (!t) throw new Error('Formel unvollständig');
      if (t.k === 'num') return t.v; if (t.k === 'str') return t.v; if (t.k === 'err') return t.v === '#REF!' ? REF : NA;
      if (t.k === 'ref') {
        const sh = t.sheet || bereich;
        if (!t.b) return holen(sh, t.a);
        const [c1, r1] = zelle(t.a), [c2, r2] = zelle(t.b), cells = [];
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) cells.push([sh, colBuch(c) + r]);
        return { range: true, cells, rows: r2 - r1 + 1, cols: c2 - c1 + 1, c1, r1, sh };
      }
      if (t.k === 'op' && t.v === '(') { const v = vergleich(); nimm(); return v }
      if (t.k === 'fn') {
        const args = []; if (!(peek().k === 'op' && peek().v === ')')) { do { args.push(vergleich()) } while (peek().k === 'op' && (peek().v === ',' || peek().v === ';') && nimm()) } nimm();
        return fn(t.v, args);
      }
      throw new Error('Formel: unerwartetes Zeichen');
    };
    const fn = (name, a) => {
      if (name === 'SUM') { let s = 0; for (const x of a) { if (x && x.range) { for (const [sh, rf] of x.cells) { const v = holen(sh, rf); if (istErr(v)) return v; if (typeof v === 'number') s += v } } else { const v = wert(x); if (istErr(v)) return v; s += zahlW(v) } } return s }
      if (name === 'IF') { const c = wert(a[0]); if (istErr(c)) return c; const w = typeof c === 'string' ? c !== '' : !!zahlW(c) || c === true; return w ? (a.length > 1 ? wert(a[1]) : true) : (a.length > 2 ? wert(a[2]) : false) }
      if (name === 'ISNA') { const v = wert(a[0]); return !!(istErr(v) && v.err === '#N/A') }
      if (name === 'ISERROR') return !!istErr(wert(a[0]));
      if (name === 'IFERROR') { const v = wert(a[0]); return istErr(v) ? wert(a[1]) : v }
      if (name === 'AND') return a.every(x => !!zahlW(wert(x)) || wert(x) === true);
      if (name === 'OR') return a.some(x => !!zahlW(wert(x)) || wert(x) === true);
      if (name === 'VLOOKUP') {
        const such = wert(a[0]), rg = a[1], sp = zahlW(wert(a[2])); if (istErr(such)) return such; if (!rg || !rg.range) return REF;
        const s1 = such == null ? '' : String(such).trim().toLowerCase();
        for (let r = 0; r < rg.rows; r++) { const v = holen(rg.sh, colBuch(rg.c1) + (rg.r1 + r)); if (v != null && String(v).trim().toLowerCase() === s1 && s1 !== '') return holen(rg.sh, colBuch(rg.c1 + sp - 1) + (rg.r1 + r)) }
        return NA;
      }
      if (name === 'TEXT') { const v = wert(a[0]), f = String(wert(a[1])); if (istErr(v)) return v; if (v == null || v === '') return ''; return zahlFormat(zahlW(v), f, true) }
      if (name === 'ROUND') return Math.round(zahlW(wert(a[0])) * 10 ** zahlW(wert(a[1]))) / 10 ** zahlW(wert(a[1]));
      throw new Error('Funktion nicht unterstützt: ' + name);
    };
    const v = wert(vergleich()); return v;
  }
  // Geteilte Formel (t="shared") für eine Nachbarzelle umrechnen
  function verschieben(txt, dr, dc) {
    return txt.replace(/("[^"]*")|(?:([A-Za-z0-9_]+|'[^']+')!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (m, str, sh, dc$, col, dr$, row) => {
      if (str) return str; return (sh ? sh + '!' : '') + dc$ + (dc$ ? col : colBuch(colNr(col) + dc)) + dr$ + (dr$ ? row : (+row + dr));
    });
  }
  // Alle Formeln eines Blatts berechnen und als zwischengespeicherte Werte (<v>) eintragen
  async function formelnRechnen(zip, blattPfad, blattName) {
    const ss = await sharedStrings(zip);
    let x = await zip.file(blattPfad).async('string');
    const Z = zellenLesen(x, ss), andere = {};
    const wb = await zip.file('xl/workbook.xml').async('string'), rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    for (const m of wb.matchAll(/<sheet name="([^"]+)"[^>]*r:id="([^"]+)"/g)) { const t = (rels.match(new RegExp('Id="' + m[2] + '"[^>]*Target="([^"]+)"')) || rels.match(new RegExp('Target="([^"]+)"[^>]*Id="' + m[2] + '"')) || [])[1]; if (t && m[1] !== blattName) andere[m[1]] = 'xl/' + t.replace(/^\/?xl\//, '') }
    const fremd = {};
    for (const [n, pf] of Object.entries(andere)) if (zip.file(pf)) fremd[n] = zellenLesen(await zip.file(pf).async('string'), ss);
    // geteilte Formeln auflösen
    const master = {};
    for (const [ref, c] of Z) if (c.f && /t="shared"/.test(c.f.at) && c.f.txt != null) master[(c.f.at.match(/si="(\d+)"/) || [])[1]] = { ref, txt: c.f.txt };
    for (const [ref, c] of Z) if (c.f && c.f.txt == null && /t="shared"/.test(c.f.at)) { const ms = master[(c.f.at.match(/si="(\d+)"/) || [])[1]]; if (ms) { const [, mc, mr] = ms.ref.match(/^([A-Z]+)(\d+)$/), [, cc, cr] = ref.match(/^([A-Z]+)(\d+)$/); c.f.txt = verschieben(ms.txt, cr - mr, colNr(cc) - colNr(mc)) } }
    const fertig = new Map(), laeuft = new Set();
    const holen = (sh, ref) => {
      if (sh && sh !== blattName) { const c = fremd[sh] && fremd[sh].get(ref); return c ? c.v : null }
      if (fertig.has(ref)) return fertig.get(ref);
      const c = Z.get(ref); if (!c) return null; if (!c.f || c.f.txt == null) return c.v;
      if (laeuft.has(ref)) return c.v; laeuft.add(ref);
      let v; try { v = formelWert(c.f.txt, holen, blattName) } catch (e) { v = undefined }
      laeuft.delete(ref); if (v === undefined) v = c.v; fertig.set(ref, v); return v;
    };
    for (const [ref, c] of Z) {
      if (!c.f || c.f.txt == null) continue; const v = holen(null, ref); if (v === undefined) continue;
      const fx = c.roh.match(/<f[^>]*(?:\/>|>[\s\S]*?<\/f>)/)[0], sa = c.s ? ` s="${c.s}"` : '';
      let neu;
      if (istErr(v)) neu = `<c r="${ref}"${sa} t="e">${fx}<v>${esc(v.err)}</v></c>`;
      else if (typeof v === 'number' && isFinite(v)) neu = `<c r="${ref}"${sa}>${fx}<v>${v}</v></c>`;
      else if (typeof v === 'boolean') neu = `<c r="${ref}"${sa} t="b">${fx}<v>${v ? 1 : 0}</v></c>`;
      else neu = `<c r="${ref}"${sa} t="str">${fx}<v>${esc(v == null ? '' : v)}</v></c>`;
      x = x.replace(c.roh, neu); c.roh = neu;
    }
    zip.file(blattPfad, x);
  }

  // ---------------------------------------------------------------- Zahlen wie Excel (deutsch) anzeigen
  const WTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], WTAGL = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'], MON = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const ausSerial = v => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 864e5)); return d };
  const deZahl = (v, dez, tsd) => { const t = Math.abs(v).toFixed(dez).split('.'); let g = t[0]; if (tsd) g = g.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return (v < 0 && +t.join('') !== 0 ? '-' : '') + g + (dez ? ',' + t[1] : '') };
  function zahlFormat(v, code, textFn) {
    code = String(code || 'General').split(';')[0];
    if (/^\[\$-F800\]/i.test(code)) { const d = ausSerial(v); return `${WTAGL[d.getUTCDay()]}, ${d.getUTCDate()}. ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
    const c = code.replace(/\[[^\]]*\]/g, '').replace(/\\(.)/g, '$1').replace(/"([^"]*)"/g, '$1');
    if (/^(TTTT|dddd)$/i.test(c)) return WTAGL[ausSerial(v).getUTCDay()];
    if (/^(TTT|ddd)$/i.test(c)) return WTAG[ausSerial(v).getUTCDay()];
    if (/[dyjt]/i.test(c) && /[dmyjt]/i.test(c) && !/^[#0.,\s]/.test(c)) { const d = ausSerial(v), z = n => String(n).padStart(2, '0');
      return c.replace(/yyyy|jjjj/i, d.getUTCFullYear()).replace(/yy|jj/i, String(d.getUTCFullYear()).slice(2)).replace(/dd|tt/i, z(d.getUTCDate())).replace(/mm/i, z(d.getUTCMonth() + 1)).replace(/\//g, '.') }
    if (/h+:mm/i.test(c)) { const min = Math.round(v * 1440); return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0') }
    if (/^General$|^Standard$/i.test(code) || code === '@') { if (Number.isInteger(v)) return String(v); return String(+v.toPrecision(10)).replace('.', ',') }
    const m = c.match(/([#0,]*0)(?:\.(0+))?(%?)(.*)$/);
    if (!m) return String(v).replace('.', ',');
    const pct = m[3] === '%'; return deZahl(pct ? v * 100 : v, m[2] ? m[2].length : 0, /,/.test(m[1])) + (pct ? '%' : '') + (m[4] || '');
  }
  const EINGEBAUT = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 14: 'dd.mm.yyyy', 15: 'd-mmm-yy', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd.mm.yyyy h:mm', 49: '@' };

  // ---------------------------------------------------------------- Blatt (Bereich) als HTML zeichnen – Grundlage für das PDF
  async function blattHtml(zip, blattPfad, zeileVon, zeileBis, opt = {}) {
    const st = await zip.file('xl/styles.xml').async('string'), th = zip.file('xl/theme/theme1.xml') ? await zip.file('xl/theme/theme1.xml').async('string') : '';
    const sheet = await zip.file(blattPfad).async('string'), Z = zellenLesen(sheet, await sharedStrings(zip));
    const themeF = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(k => { const m = th.match(new RegExp('<a:' + k + '>[\\s\\S]*?(?:lastClr|val)="([0-9A-Fa-f]{6})"')); return m ? m[1] : (k === 'lt1' ? 'FFFFFF' : '000000') });
    const IDX = { 8: '000000', 9: 'FFFFFF', 10: 'FF0000', 64: '000000', 81: '000000' };
    const farbe = (a) => { if (!a) return null; let rgb = (a.match(/rgb="([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})"/) || [])[1]; if (rgb) rgb = rgb.slice(-6); const t = (a.match(/theme="(\d+)"/) || [])[1]; if (!rgb && t != null) rgb = themeF[+t] || '000000'; const ix = (a.match(/indexed="(\d+)"/) || [])[1]; if (!rgb && ix != null) rgb = IDX[ix] || '000000'; if (!rgb) return null;
      const tint = parseFloat((a.match(/tint="([-\d.E]+)"/) || [])[1] || 0); let c = [0, 2, 4].map(i => parseInt(rgb.substr(i, 2), 16)); if (tint) c = c.map(x => Math.round(tint < 0 ? x * (1 + tint) : x + (255 - x) * tint)); return '#' + c.map(x => x.toString(16).padStart(2, '0')).join('') };
    const teil = (tag) => { const m = st.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return m ? m[1] : '' };
    const numFmts = {}; for (const m of st.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)) numFmts[m[1]] = xmlText(m[2]);
    const fonts = [...teil('fonts').matchAll(/<font>([\s\S]*?)<\/font>|<font\/>/g)].map(m => { const f = m[1] || ''; return { b: /<b\/>/.test(f), i: /<i\/>/.test(f), u: /<u\/>|<u /.test(f), sz: parseFloat((f.match(/<sz val="([\d.]+)"/) || [])[1] || 11), name: (f.match(/<name val="([^"]+)"/) || [])[1] || 'Calibri', color: farbe((f.match(/<color ([^>]*)\/>/) || [])[1]) } });
    const fills = [...teil('fills').matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map(m => /patternType="solid"/.test(m[1]) ? farbe((m[1].match(/<fgColor ([^>]*)\/>/) || [])[1]) : null);
    const kante = (b, side) => { const m = b.match(new RegExp('<' + side + '(?: style="(\\w+)")?[^>]*?(?:/>|>([\\s\\S]*?)</' + side + '>)')); if (!m || !m[1]) return null; const w = { thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', mediumDashed: '2px dashed', dotted: '1px dotted', double: '3px double', dashDot: '1px dashed', mediumDashDot: '2px dashed', dashDotDot: '1px dotted', slantDashDot: '2px dashed' }[m[1]] || '1px solid'; return w + ' ' + (farbe((m[2] || '').match(/<color ([^>]*)\/>/)?.[1]) || '#000') };
    const borders = [...teil('borders').matchAll(/<border(?:\s[^>]*)?>([\s\S]*?)<\/border>|<border\/>/g)].map(m => { const b = m[1] || ''; return { l: kante(b, 'left'), r: kante(b, 'right'), t: kante(b, 'top'), b: kante(b, 'bottom') } });
    const xfs = [...teil('cellXfs').matchAll(/<xf ([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)].map(m => { const a = m[1], al = ((m[2] || '').match(/<alignment ([^>]*)\/>/) || [])[1] || ''; const g = k => (a.match(new RegExp(k + '="([^"]*)"')) || [])[1]; const ga = k => (al.match(new RegExp(k + '="([^"]*)"')) || [])[1];
      return { nf: +(g('numFmtId') || 0), font: fonts[+(g('fontId') || 0)] || fonts[0], fill: fills[+(g('fillId') || 0)], bd: borders[+(g('borderId') || 0)] || {}, h: ga('horizontal'), v: ga('vertical') || 'bottom', wrap: ga('wrapText') === '1', rot: +(ga('textRotation') || 0) } });
    // Spalten / Zeilen
    const breite = {}, versteckt = {}; const std = parseFloat((sheet.match(/defaultColWidth="([\d.]+)"/) || [])[1] || 8.43);
    for (const m of sheet.matchAll(/<col ([^>]*)\/>/g)) { const a = m[1], mi = +(a.match(/min="(\d+)"/) || [])[1], ma = Math.min(+(a.match(/max="(\d+)"/) || [])[1], 60), w = parseFloat((a.match(/width="([\d.]+)"/) || [])[1] || std); for (let c = mi; c <= ma; c++) { breite[c] = w; versteckt[c] = /hidden="1"/.test(a) } }
    const rowH = {}, rowHid = {}, stdH = parseFloat((sheet.match(/defaultRowHeight="([\d.]+)"/) || [])[1] || 15);
    for (const m of sheet.matchAll(/<row r="(\d+)"([^>]*)>/g)) { const h = (m[2].match(/ ht="([\d.]+)"/) || [])[1]; if (h) rowH[m[1]] = +h; if (/hidden="1"/.test(m[2])) rowHid[m[1]] = 1 }
    const colMax = opt.colBis || 26, cols = []; for (let c = opt.colVon || 1; c <= colMax; c++) if (!versteckt[c]) cols.push(c);
    const px = c => Math.trunc((breite[c] ?? std) * 7 + 0.5);
    const zeigeNull = !/showZeros="0"/.test(sheet);
    // verbundene Zellen
    const merge = {}, verdeckt = new Set();
    for (const m of sheet.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g)) { const c1 = colNr(m[1]), r1 = +m[2], c2 = colNr(m[3]), r2 = +m[4]; merge[m[1] + m[2]] = { c1, r1, c2, r2 }; for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) verdeckt.add(colBuch(c) + r) }
    const istCalibri = await opt.calibri;
    const fontCss = f => { const fam = /calibri/i.test(f.name) ? (istCalibri ? 'Calibri, Carlito' : 'Carlito, "Liberation Sans Narrow", "Arial Narrow", Arial') : f.name + ', Arial'; const sz = f.sz * 4 / 3 * (/calibri/i.test(f.name) && !istCalibri ? 0.92 : 1);
      return `font-family:${fam},sans-serif;font-size:${sz.toFixed(2)}px;${f.b ? 'font-weight:700;' : ''}${f.i ? 'font-style:italic;' : ''}${f.u ? 'text-decoration:underline;' : ''}${f.color && f.color !== '#000000' ? 'color:' + f.color + ';' : ''}` };
    const anzeige = (c, x) => { if (!c || c.v == null || c.v === '') return ''; if (istErr(c.v)) return ''; if (typeof c.v === 'boolean') return c.v ? 'WAHR' : 'FALSCH'; if (typeof c.v === 'number') { if (c.v === 0 && !zeigeNull) return ''; return zahlFormat(c.v, numFmts[x.nf] || EINGEBAUT[x.nf] || 'General') } return String(c.v) };
    const leer = (c, r) => { const k = colBuch(c) + r; const z = Z.get(k); return !verdeckt.has(k) && !merge[k] && (!z || z.v == null || z.v === '' || (z.v === 0 && !zeigeNull)) };
    let html = '', y = 0; const rowsY = {};
    for (let r = zeileVon; r <= zeileBis; r++) {
      rowsY[r] = y; if (rowHid[r]) continue; const h = (rowH[r] || stdH) * 4 / 3; y += h;
      let tr = `<tr style="height:${h.toFixed(2)}px">`;
      for (const c of cols) {
        const ref = colBuch(c) + r; if (verdeckt.has(ref)) continue;
        const z = Z.get(ref), x = xfs[z && z.s != null ? +z.s : 0] || xfs[0], mg = merge[ref];
        let span = '', bd = x.bd;
        if (mg) { const cs = cols.filter(q => q >= mg.c1 && q <= mg.c2).length, rs = Math.min(mg.r2, zeileBis) - mg.r1 + 1; span = (cs > 1 ? ` colspan="${cs}"` : '') + (rs > 1 ? ` rowspan="${rs}"` : '');
          const xf = rr => xfs[+(Z.get(rr)?.s ?? 0)] || xfs[0]; bd = { l: x.bd.l, t: x.bd.t, r: xf(colBuch(mg.c2) + mg.r1).bd.r, b: xf(colBuch(mg.c1) + mg.r2).bd.b } }
        const txt = anzeige(z, x), num = z && typeof z.v === 'number';
        const ha = x.h === 'centerContinuous' ? 'center' : x.h && x.h !== 'general' ? x.h : (num ? 'right' : 'left');
        const va = x.v === 'center' ? 'middle' : x.v === 'top' ? 'top' : 'bottom';
        let css = `${fontCss(x.font)}text-align:${ha === 'justify' || ha === 'distributed' ? 'left' : ha};vertical-align:${va};`;
        if (x.fill) css += `background:${x.fill};`;
        css += `border-left:${bd.l || 'none'};border-right:${bd.r || 'none'};border-top:${bd.t || 'none'};border-bottom:${bd.b || 'none'};`;
        let inner = esc(txt).replace(/\n/g, '<br>');
        if (x.rot === 90 && txt) inner = `<div style="writing-mode:vertical-rl;transform:rotate(180deg);white-space:normal;line-height:1.05;margin:0 auto;max-height:${((mg ? mg.r2 - mg.r1 + 1 : 1) * stdH * 4 / 3 - 4).toFixed(0)}px;overflow:hidden">${inner}</div>`, css += 'padding:2px 0;';
        else if (x.wrap || mg && mg.r2 > mg.r1) css += 'white-space:normal;word-wrap:break-word;line-height:1.1;overflow:hidden;';
        else { // wie Excel: Text läuft in leere Nachbarzellen weiter
          const frei = ha === 'left' && !num && txt && !mg && leer(c + 1, r);
          css += frei ? 'white-space:nowrap;overflow:visible;' : 'white-space:nowrap;overflow:hidden;';
          if (frei) inner = `<span style="position:relative;z-index:1">${inner}</span>`;
        }
        tr += `<td${span} style="${css}">${inner}</td>`;
      }
      html += tr + '</tr>';
    }
    // Bilder (Logo, Unterschrift)
    let bilder = '';
    const sRels = zip.file(blattPfad.replace(/worksheets\/(sheet\d+\.xml)$/, 'worksheets/_rels/$1.rels'));
    const drId = (sheet.match(/<drawing r:id="([^"]+)"/) || [])[1];
    if (sRels && drId) {
      const rl = await sRels.async('string'), tgt = (rl.match(new RegExp('Id="' + drId + '"[^>]*Target="([^"]+)"')) || rl.match(new RegExp('Target="([^"]+)"[^>]*Id="' + drId + '"')) || [])[1];
      const dPfad = tgt && 'xl/' + tgt.replace(/^\.\.\//, '').replace(/^\/xl\//, ''), dF = dPfad && zip.file(dPfad);
      if (dF) {
        const dx = await dF.async('string'), dRelF = zip.file(dPfad.replace(/drawings\/(drawing\d+\.xml)$/, 'drawings/_rels/$1.rels')), dRel = dRelF ? await dRelF.async('string') : '';
        const xVon = c => cols.filter(q => q < c + 1).reduce((a, q) => a + px(q), 0);
        for (const m of dx.matchAll(/<xdr:(oneCellAnchor|twoCellAnchor)[^>]*>([\s\S]*?)<\/xdr:\1>/g)) {
          const a = m[2], f = a.match(/<xdr:from><xdr:col>(\d+)<\/xdr:col><xdr:colOff>(-?\d+)<\/xdr:colOff><xdr:row>(\d+)<\/xdr:row><xdr:rowOff>(-?\d+)<\/xdr:rowOff><\/xdr:from>/); if (!f) continue;
          const row = +f[3] + 1; if (row < zeileVon || row > zeileBis) continue;
          const emb = (a.match(/r:embed="([^"]+)"/) || [])[1]; const ziel = emb && (dRel.match(new RegExp('Id="' + emb + '"[^>]*Target="([^"]+)"')) || [])[1]; if (!ziel) continue;
          const mf = zip.file('xl/' + ziel.replace(/^\.\.\//, '')); if (!mf) continue;
          const ext = a.match(/<xdr:ext cx="(\d+)" cy="(\d+)"/) || a.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
          const x0 = xVon(+f[1]) + f[2] / 9525, y0 = rowsY[row] + f[4] / 9525, w = ext ? ext[1] / 9525 : 100, hh = ext ? ext[2] / 9525 : 40;
          const typ = /\.jpe?g$/i.test(ziel) ? 'jpeg' : 'png';
          bilder += `<img src="data:image/${typ};base64,${await mf.async('base64')}" style="position:absolute;left:${x0.toFixed(1)}px;top:${y0.toFixed(1)}px;width:${w.toFixed(1)}px;height:${hh.toFixed(1)}px">`;
        }
      }
    }
    const breiteGes = cols.reduce((a, q) => a + px(q), 0);
    return { html: `<table style="border-collapse:collapse;table-layout:fixed;width:${breiteGes}px"><colgroup>${cols.map(q => `<col style="width:${px(q)}px">`).join('')}</colgroup>${html}</table>${bilder}`, breite: breiteGes, hoehe: y };
  }
  // Seite wie beim Excel-Druck: A4 hochkant, Ränder und Skalierung aus der Vorlage
  async function seiteHtml(zip, blattPfad, zeileVon, zeileBis, opt = {}) {
    const sheet = await zip.file(blattPfad).async('string');
    const pm = sheet.match(/<pageMargins left="([\d.]+)" right="([\d.]+)" top="([\d.]+)" bottom="([\d.]+)"/) || [0, 0.7, 0.7, 0.75, 0.75];
    const scale = +((sheet.match(/<pageSetup[^>]*scale="(\d+)"/) || [])[1] || 100) / 100;
    const b = await blattHtml(zip, blattPfad, zeileVon, zeileBis, opt);
    const W = 794, H = 1123, L = pm[1] * 96, T = pm[3] * 96;
    const s = Math.min(scale, (W - L - 4) / b.breite, (H - T - 4) / b.hoehe);
    return `<div class="a4 xa4" style="width:${W}px;height:${H}px;padding:0;background:#fff;overflow:hidden"><div style="position:absolute;left:${L.toFixed(1)}px;top:${T.toFixed(1)}px;transform:scale(${s.toFixed(4)});transform-origin:0 0;color:#000">${b.html}</div></div>`;
  }
  root.formelnRechnen = formelnRechnen; root.seiteHtml = seiteHtml; root.zahlFormat = zahlFormat;

  root.excelFuellen = excelFuellen;
  if (typeof module !== 'undefined') module.exports = { excelFuellen, setze };
})(typeof window !== 'undefined' ? window : globalThis);
