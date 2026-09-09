import { buildHTML } from '../html-export.js';
// File and export actions: new/save/open, the export dialog (PNG, SVG, PDF,
// seamless loop GIF), the BOM and design-rule dialogs, and share links.
import { newDoc, deleteItems } from '../state.js';
import { serialize, deserialize } from '../serialize.js';
import { buildExportSVG, exportBounds, exportPNG, exportPDF, download } from '../export.js';
import { encodeGIF } from '../gif.js';
import { LOOP_MS, esc } from '../render.js';
import { buildBOM, bomCSV, bomMarkdown, bomHeaders } from '../bom.js';
import { checkDoc } from '../drc.js';
import { encodeShare } from '../share.js';
import { toast, openModal } from './press.js';
import { tr, trd, onLanguageChange } from '../i18n.js';

export function initDialogs({ store }) {
  const safeName = (ext) => `${(store.doc.title || 'schematica').replace(/[^\w-]+/g, '_')}${ext}`;

  function saveJSON() {
    download(safeName('.schematica.json'), serialize(store.doc), 'application/json');
  }

  document.getElementById('btn-new').addEventListener('click', () => {
    if (confirm(tr('Clear the board? Anything not saved to a file is lost.'))) {
      store.replaceDoc(newDoc());
    }
  });
  document.getElementById('btn-save').addEventListener('click', saveJSON);
  document.getElementById('btn-remove').addEventListener('click', () => {
    deleteItems(store, [...store.selection]);
  });

  // ---- Export dialog ----
  const exportDialog = document.getElementById('export-dialog');
  const exportW = document.getElementById('export-w');
  const exportH = document.getElementById('export-h');
  let exportAspect = 1;

  document.getElementById('btn-export').addEventListener('click', () => {
    const b = exportBounds(store.doc);
    exportAspect = b.w / b.h;
    exportW.value = Math.round(b.w * 2);
    exportH.value = Math.round(b.h * 2);
    openModal(exportDialog);
  });
  exportW.addEventListener('input', () => {
    if (document.getElementById('export-lock').checked) {
      exportH.value = Math.max(16, Math.round(Number(exportW.value) / exportAspect) || 16);
    }
  });
  exportH.addEventListener('input', () => {
    if (document.getElementById('export-lock').checked) {
      exportW.value = Math.max(16, Math.round(Number(exportH.value) * exportAspect) || 16);
    }
  });

  const exportOpts = () => ({ transparent: document.getElementById('export-transparent').checked });
  const clampPx = (v) => Math.min(16384, Math.max(16, Math.round(Number(v)) || 16));

  document.getElementById('export-png-go').addEventListener('click', () => {
    const width = clampPx(exportW.value);
    const height = clampPx(exportH.value);
    exportDialog.close();
    exportPNG(buildExportSVG(store.doc, exportOpts()), (blob) => {
      if (blob) download(safeName('.png'), blob);
      else toast(tr('PNG export failed in this browser. The SVG export still works.'));
    }, { width, height });
  });
  document.getElementById('export-html-go').addEventListener('click', () => {
    exportDialog.close();
    download(safeName('.html'), buildHTML(store.doc), 'text/html');
  });
  document.getElementById('export-svg-go').addEventListener('click', () => {
    exportDialog.close();
    download(safeName('.svg'), buildExportSVG(store.doc, exportOpts()), 'image/svg+xml');
  });
  document.getElementById('export-pdf-go').addEventListener('click', () => {
    const width = clampPx(exportW.value);
    exportDialog.close();
    exportPDF(buildExportSVG(store.doc), (blob) => {
      if (blob) download(safeName('.pdf'), blob);
      else toast(tr('PDF export failed in this browser. PNG and SVG still work.'));
    }, { width });
  });

  // A seamless loop: LOOP_MS returns every animated attribute to its start, so
  // the last frame leads perfectly back into the first.
  let loopBusy = false;
  document.getElementById('export-gifloop-go').addEventListener('click', async () => {
    if (loopBusy) return;
    loopBusy = true;
    exportDialog.close();
    toast(tr('Rendering the seamless loop GIF…'));
    try {
      const b = exportBounds(store.doc);
      let width = Math.min(960, Math.max(16, Math.round(Number(exportW.value)) || 960));
      let height = Math.max(16, Math.round(width * (b.h / b.w)));
      if (height > 960) {
        // Tall boards get the same cap as wide ones — 60 retained frames add up.
        width = Math.max(16, Math.round(width * (960 / height)));
        height = 960;
      }
      const FRAMES = 60;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const frames = [];
      for (let i = 0; i < FRAMES; i++) {
        const svgStr = buildExportSVG(store.doc, { now: (i * LOOP_MS) / FRAMES });
        const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' }));
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          ctx.drawImage(img, 0, 0, width, height);
        } finally {
          URL.revokeObjectURL(url);
        }
        frames.push({ data: ctx.getImageData(0, 0, width, height).data, width, height });
      }
      const bytes = encodeGIF(frames, { delayMs: LOOP_MS / FRAMES });
      download(safeName('.loop.gif'), new Blob([bytes], { type: 'image/gif' }), 'image/gif');
      toast(tr('Seamless loop GIF saved.'));
    } catch {
      toast(tr('Loop GIF export failed in this browser.'));
    } finally {
      loopBusy = false;
    }
  });
  document.getElementById('export-cancel').addEventListener('click', () => {
    exportDialog.close();
  });
  exportDialog.addEventListener('pointerdown', (e) => {
    if (e.target === exportDialog) exportDialog.close();
  });

  // ---- BOM dialog ----
  const bomDialog = document.getElementById('bom-dialog');
  function renderBOM() {
    const bomRows = buildBOM(store.doc);
    // A catalogue part shows its translated name; a custom part's name is the
    // user's own text and stays as typed.
    const body = bomRows.map((r) => (
      `<tr><td>${esc(r.kind === 'custom' ? r.part : trd(r.part))}</td><td>${esc(r.sublabel)}</td><td>${r.qty}</td>`
      + `<td class="wrap">${esc(r.refs.join(', '))}</td><td>${esc(r.addrs.join(', '))}</td>`
      + `<td>${esc(r.rails.join(', '))}</td><td>${esc(r.statuses.join(', '))}</td>`
      + `<td>${esc(r.flags.join(', '))}</td><td class="wrap">${esc(r.notes.join('; '))}</td></tr>`
    )).join('');
    const head = bomHeaders().map((h) => `<th>${esc(h)}</th>`).join('');
    document.getElementById('bom-table').innerHTML = bomRows.length
      ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
      : `<p style="padding:12px">${esc(tr('The board is empty - add some parts first.'))}</p>`;
  }
  document.getElementById('btn-bom').addEventListener('click', () => {
    renderBOM();
    openModal(bomDialog);
  });
  // Rows are re-derived at click time so exports always match the live board,
  // even if it was edited (e.g. via undo) while the dialog was open.
  document.getElementById('bom-csv').addEventListener('click', () => {
    download(safeName('.bom.csv'), bomCSV(buildBOM(store.doc)), 'text/csv');
  });
  document.getElementById('bom-md').addEventListener('click', () => {
    navigator.clipboard.writeText(bomMarkdown(buildBOM(store.doc)))
      .then(() => toast(tr('Markdown table copied to clipboard.')))
      .catch(() => toast(tr('Could not access the clipboard - use Download CSV instead.')));
  });
  document.getElementById('bom-close').addEventListener('click', () => {
    bomDialog.close();
  });
  bomDialog.addEventListener('pointerdown', (e) => {
    if (e.target === bomDialog) bomDialog.close();
  });

  // ---- Design rule check ----
  const drcDialog = document.getElementById('drc-dialog');
  const levelLabel = (level) => (level === 'error' ? tr('ERROR') : tr('WARNING'));
  function renderDRC() {
    const findings = checkDoc(store.doc);
    const list = document.getElementById('drc-list');
    if (!findings.length) {
      list.innerHTML = `<p class="drc-clean">${esc(tr('No issues found - the board passes every check.'))}</p>`;
      return;
    }
    list.innerHTML = findings.map((f, i) => (
      `<div class="drc-row"><span class="drc-level ${f.level}">${esc(levelLabel(f.level))}</span>`
      + `<span class="msg">${esc(f.message)}</span>`
      + `<button data-drc="${i}">${esc(tr('Select'))}</button><button data-drc-fix="${i}">${esc(tr('Fix'))}</button></div>`
    )).join('');
    list.querySelectorAll('[data-drc]').forEach((btn) => {
      btn.addEventListener('click', () => {
        store.setSelection(findings[Number(btn.dataset.drc)].ids);
        drcDialog.close();
      });
    });
    // Fix hands the finding to the assistant panel, which owns the request.
    list.querySelectorAll('[data-drc-fix]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const finding = findings[Number(btn.dataset.drcFix)];
        drcDialog.close();
        document.dispatchEvent(new CustomEvent('schematica:fix-finding', { detail: finding }));
      });
    });
  }
  document.getElementById('btn-check').addEventListener('click', () => {
    renderDRC();
    openModal(drcDialog);
  });
  document.getElementById('drc-close').addEventListener('click', () => {
    drcDialog.close();
  });
  drcDialog.addEventListener('pointerdown', (e) => {
    if (e.target === drcDialog) drcDialog.close();
  });

  onLanguageChange(() => {
    if (bomDialog.open) renderBOM();
    if (drcDialog.open) renderDRC();
  });

  // ---- Share link ----
  document.getElementById('btn-share').addEventListener('click', async () => {
    try {
      const fragment = await encodeShare(store.doc);
      const url = `${location.origin}${location.pathname}#${fragment}`;
      await navigator.clipboard.writeText(url);
      toast(tr('Share link copied to clipboard ({n} characters).', { n: url.length.toLocaleString() }));
    } catch {
      toast(tr('Could not copy the share link - your browser blocked clipboard access.'));
    }
  });

  // ---- Open a file ----
  const fileInput = document.getElementById('file-input');
  document.getElementById('btn-open').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const { doc, warnings } = deserialize(await file.text());
      store.replaceDoc(doc);
      if (warnings.length) toast(tr('Opened with warnings:\n\n{list}', { list: warnings.join('\n') }));
    } catch (err) {
      toast(err.message);
    }
  });

  return { saveJSON };
}
