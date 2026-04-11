/**
 * gridOCR — Frontend Application
 * app.js
 *
 * Communicates with the Flask backend via fetch().
 * All heavy lifting (OpenCV, Tesseract) runs in the Python sidecar.
 */

// ── HTTP API ───────────────────────────────────────────────────────────────
const API = "http://localhost:5000";

async function sidecar(action, params = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${API}/api/sidecar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...params }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    } finally {
        clearTimeout(timer);
    }
}



// ── Detection settings ────────────────────────────────────────────────────
function getDetectSettings() {
    const preserveLineBreaks = document.getElementById('preserveLineBreaks')?.checked ?? true;
    return {
        body:                document.getElementById('detectBody')?.checked    ?? true,
        header:              document.getElementById('detectHeader')?.checked  ?? true,
        pagenum:             document.getElementById('detectPagenum')?.checked ?? true,
        footnote:            document.getElementById('detectFootnote')?.checked ?? true,
        mergeBody:           !preserveLineBreaks,
        preserveParas:       preserveLineBreaks,
        preserveNewlines:    preserveLineBreaks,
        preserveLineBreaks,
        ocrLanguage:         document.getElementById('ocrLanguage')?.value     || 'eng',
        ocrModel:            document.getElementById('ocrModel')?.value        || 'best',
        useBest:             (document.getElementById('ocrModel')?.value || 'best') === 'best',
    };
}

// Remove regions substantially contained within another region.
// A region is "inside" another if >80% of its area overlaps with the larger one.
function filterContainedRegions(regions) {
  const out = [];
  for (let i = 0; i < regions.length; i++) {
    const a = regions[i];
    let contained = false;
    for (let j = 0; j < regions.length; j++) {
      if (i === j) continue;
      const b = regions[j];
      // Check if a is inside b
      const ix1 = Math.max(a.x, b.x);
      const iy1 = Math.max(a.y, b.y);
      const ix2 = Math.min(a.x + a.w, b.x + b.w);
      const iy2 = Math.min(a.y + a.h, b.y + b.h);
      if (ix2 <= ix1 || iy2 <= iy1) continue;
      const interArea = (ix2 - ix1) * (iy2 - iy1);
      const aArea     = a.w * a.h;
      if (aArea > 0 && interArea / aArea > 0.80) {
        // a is mostly inside b — keep whichever is larger
        if (aArea < b.w * b.h) { contained = true; break; }
      }
    }
    if (!contained) out.push(a);
  }
  return out;
}

function filterRegionsBySettings(regions) {
    const settings = getDetectSettings();
    return regions.filter(r => settings[r.type] !== false);
}

function toggleDetectSettings() {
    const panel = document.getElementById('detectSettingsPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// Close settings panel when clicking outside
document.addEventListener('click', (e) => {
    const panel = document.getElementById('detectSettingsPanel');
    const btn   = document.getElementById('btnDetectSettings');
    if (panel && !panel.contains(e.target) && e.target !== btn) {
        panel.style.display = 'none';
    }
});

// ── Save / Load project ────────────────────────────────────────────────────
async function saveProject() {
    if (!state.project) { alert('No project to save.'); return; }
    setStatus('Saving…', 'busy');
    const res  = await fetch(`${API}/api/project/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: state.project }),
    });
    const data = await res.json();
    if (data.ok) {
        setStatus(`Saved to ${data.path}`);
    } else {
        setStatus('Save failed: ' + data.error, 'error');
    }
}

async function loadProject() {
    // Show list of saved projects
    const listRes  = await fetch(`${API}/api/project/list`);
    const listData = await listRes.json();

    if (!listData.ok || listData.files.length === 0) {
        // Fall back to manual path entry
        const path = prompt('Enter full path to .gridocr file:');
        if (!path) return;
        await loadProjectFromPath(path);
        return;
    }

    // Build a simple chooser
    const names = listData.files.map((f, i) => `${i + 1}. ${f.name}`).join('');
    const choice = prompt(`Saved projects:
${names}

Enter number to load:`);
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= listData.files.length) { alert('Invalid choice'); return; }
    await loadProjectFromPath(listData.files[idx].path);
}

async function loadProjectFromPath(path) {
    setStatus('Loading…', 'busy');
    const res  = await fetch(`${API}/api/project/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!data.ok) { setStatus('Load failed: ' + data.error, 'error'); return; }
    state.project = data.project;
    // Restore active volume (last one)
    if (state.project.volumes?.length > 0) {
        state.volume = state.project.volumes[state.project.volumes.length - 1];
        dom.volumeName.textContent = state.volume.name;
        renderSpreadList();
        updateCounts();
        if (state.volume.spreads?.length > 0) selectSpread(state.volume.spreads[0]);
    }
    renderProjectName();
    setStatus(`Loaded: ${state.project.name}`);
}

// ── Browser file picker ───────────────────────────────────────────────────
function pickImageFiles() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'image/jpeg,image/png,image/tiff,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,.pdf';
        input.onchange = async () => {
            if (!input.files.length) { resolve([]); return; }
            const formData = new FormData();
            for (const file of input.files) formData.append('files', file);
            const res  = await fetch(`${API}/api/upload`, { method: 'POST', body: formData });
            const data = await res.json();
            resolve(data.ok ? data.paths : []);
        };
        input.oncancel = () => resolve([]);
        input.click();
    });
}

// ── App State ──────────────────────────────────────────────────────────────
const state = window._gridOCRState = {
  project: null,       // { id, name, volumes: [] }
  volume: null,        // currently selected volume
  spread: null,        // currently selected spread
  page: null,          // currently selected page (left|right)
  activeType: 'body',
  drawMode: true,
};

// ── Region type config ─────────────────────────────────────────────────────
const TYPES = {
  body:      { label: 'Body Text',      color: '#3d5a6b', bg: 'rgba(61,90,107,0.18)'  },
  header:    { label: 'Running Header', color: '#c4922a', bg: 'rgba(196,146,42,0.22)' },
  pagenum:   { label: 'Page Number',    color: '#8b3a1a', bg: 'rgba(139,58,26,0.22)'  },
  footnote:  { label: 'Footnote',       color: '#6b4a7a', bg: 'rgba(107,74,122,0.22)' },
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const dom = {
  spreadList:     document.getElementById('spreadList'),
  pageImgLeft:    document.getElementById('pageImgLeft'),
  pageImgRight:   document.getElementById('pageImgRight'),
  segLayerLeft:   document.getElementById('segLayerLeft'),
  segLayerRight:  document.getElementById('segLayerRight'),
  wrapLeft:       document.getElementById('wrapLeft'),
  wrapRight:      document.getElementById('wrapRight'),
  statusText:     document.getElementById('statusText'),
  statusDot:      document.getElementById('statusDot'),
  segCount:       document.getElementById('segCount'),
  spreadCount:    document.getElementById('spreadCount'),
  rightTabs:      document.querySelectorAll('.tab-btn'),
  tabContents:    document.querySelectorAll('.tab-content'),
  segmentList:    document.getElementById('segmentListInner'),
  ocrPanel:       document.getElementById('ocrPanel'),
  compiledPanel:  document.getElementById('compiledPanel'),
  volumeName:     document.getElementById('volumeName'),
};

// ── Status ─────────────────────────────────────────────────────────────────
function setStatus(msg, state = 'idle') {
  dom.statusText.textContent = msg;
  dom.statusDot.className = 'status-dot ' + state;
}

// ── Project / Volume / Spread lifecycle ────────────────────────────────────

async function newProject() {
  const name = prompt('Project name:', 'My Periodical');
  if (!name) return;
  state.project = {
    id: uid(), name,
    volumes: [],
  };
  state.volume = null;
  dom.volumeName.textContent = 'No volume';
  renderProjectName();
  setStatus(`Project "${name}" created`);
}

async function importSpreads() {
  if (!state.project) { alert('Create a project first.'); return; }
  if (!state.volume) {
    const vol = { id: uid(), name: 'Volume 1', spreads: [] };
    state.project.volumes.push(vol);
    state.volume = vol;
    dom.volumeName.textContent = vol.name;
  }

  const paths = await pickImageFiles();
  if (!paths || paths.length === 0) return;

  const pdfs   = paths.filter(p => p.toLowerCase().endsWith('.pdf'));
  const images = paths.filter(p => !p.toLowerCase().endsWith('.pdf'));

  // ── Convert PDFs page-by-page with progress ──────────────────────────
  const allImagePaths = [...images];
  for (const pdfPath of pdfs) {
    const pdfName = pdfPath.split(/[\/]/).pop();

    // Start job — opens PDF, returns page count immediately
    const jobRes = await sidecar('pdf_start_job', { pdf_path: pdfPath, dpi: 200 }, 30000);
    if (!jobRes.ok) { setStatus(`PDF error: ${jobRes.error}`, 'idle'); continue; }

    const { job_id, page_count } = jobRes;
    showProgressBar(`Converting ${pdfName}`, 0, page_count);

    // Convert one page per sidecar call — each call is fast (< 2s)
    let pagePaths = [];
    for (let p = 0; p < page_count; p++) {
      const pageRes = await sidecar('pdf_next_page', { job_id }, 30000);
      if (!pageRes.ok) { setStatus(`PDF page error: ${pageRes.error}`, 'idle'); break; }
      updateProgressBar(pageRes.page_index, page_count,
        `Converting ${pdfName}: ${pageRes.page_index} / ${page_count}`);
      if (pageRes.done) { pagePaths = pageRes.paths || []; break; }
    }
    hideProgressBar();
    allImagePaths.push(...pagePaths);
    setStatus(`PDF: ${pagePaths.length} pages from ${pdfName}`, 'idle');
  }

  if (allImagePaths.length === 0) return;

  // ── Import each page image through split_spread ───────────────────────
  let imported = 0;
  showProgressBar('Importing pages', 0, allImagePaths.length);
  for (const imgPath of allImagePaths) {
    const splitResult = await sidecar('split_spread',
      { image_path: imgPath, out_dir: `tmp/${state.volume.id}_${uid()}` });
    if (!splitResult.ok) { console.error('Split error:', splitResult.error); continue; }

    state.volume.spreads.push({
      id: uid(),
      originalPath: imgPath,
      leftPath:     splitResult.left_path,
      rightPath:    splitResult.right_path,
      spineX:       splitResult.spine_x,
      splitMethod:  splitResult.method,
      imageW:       splitResult.image_w,
      imageH:       splitResult.image_h,
      isSingle:     splitResult.is_single || false,
      detectionRun: false,
      pages: {
        left:  { segments: [], ocrResults: {}, confirmed: false },
        right: { segments: [], ocrResults: {}, confirmed: false },
      }
    });
    imported++;
    updateProgressBar(imported, allImagePaths.length, `Importing: ${imported} / ${allImagePaths.length}`);
    if (imported % 5 === 0 || imported === allImagePaths.length) {
      renderSpreadList(); updateCounts();
    }
  }

  hideProgressBar();
  renderSpreadList(); updateCounts();
  setStatus(`Imported ${imported} page(s)`, 'idle');
  if (state.volume.spreads.length > 0)
    selectSpread(state.volume.spreads[state.volume.spreads.length - imported]);
}

// ── Spread selection ───────────────────────────────────────────────────────

async function selectSpread(spread) {
  state.spread = spread;

  // Load images
  resetPagePlaceholders();
  loadPageImageFromPath(dom.pageImgLeft, spread.leftPath);
  // Hide right panel for single-page spreads
  if (spread.rightPath) {
    dom.wrapRight.style.display = "";
    loadPageImageFromPath(dom.pageImgRight, spread.rightPath);
  } else {
    dom.wrapRight.style.display = "none";
  }

  // Auto-detect only on first visit (never detected before)
  // Use spread.detectionRun flag to distinguish "detected but found nothing" from "never run"
  if (!spread.detectionRun) {
    spread.detectionRun = true;
    await detectPage('left');
    if (spread.rightPath) await detectPage('right');
  }

  renderSegments('left');
  renderSegments('right');
  renderSegmentList();
  updateCounts();
  document.querySelectorAll('.tab-content').forEach(el => { el.scrollTop = 0; });
  syncPanelScroll();

  // Highlight in list
  document.querySelectorAll('.spread-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === spread.id);
  });
}

async function loadPageImageFromPath(imgEl, filePath) {
  const side    = imgEl.id === 'pageImgLeft' ? 'Left' : 'Right';
  const emptyEl = document.getElementById('pageEmpty' + side);
  if (!filePath) {
    imgEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }
  imgEl.style.opacity = '0';
  try {
    const _res  = await fetch(`${API}/api/image?path=${encodeURIComponent(filePath)}`);
    const result = await _res.json();
    if (result.ok) {
      imgEl.src = result.data_url;
      imgEl.style.display = '';
      if (emptyEl) emptyEl.style.display = 'none';
      imgEl.onload = () => { imgEl.style.opacity = '1'; };
    } else {
      setStatus('Image load error: ' + result.error);
    }
  } catch(e) {
    setStatus('Image load failed: ' + e.message);
  }
}

function resetPagePlaceholders() {
  dom.pageImgLeft.src  = '';
  dom.pageImgLeft.style.display  = 'none';
  dom.pageImgRight.src = '';
  dom.pageImgRight.style.display = 'none';
  const eL = document.getElementById('pageEmptyLeft');
  const eR = document.getElementById('pageEmptyRight');
  if (eL) eL.style.display = 'flex';
  if (eR) eR.style.display = 'flex';
}

function loadPageImage(imgEl, src) {
  imgEl.style.opacity = '0';
  imgEl.src = src;
  imgEl.onload = () => { imgEl.style.opacity = '1'; };
}

// ── OpenCV detection ───────────────────────────────────────────────────────

async function detectPage(side) {
  if (!state.spread) return;
  const spread = state.spread;
  const imgPath = side === 'left' ? spread.leftPath : spread.rightPath;
  if (!imgPath) return;

  setStatus(`Detecting regions (${side})…`, 'busy');

  const volId = state.volume?.id;
  const detectSettings = getDetectSettings();
  const result = await sidecar('detect_regions', {
    image_path:        imgPath,
    page_side:         side,
    volume_id:         volId || null,
    merge_body:        detectSettings.mergeBody,
    preserve_paras:    detectSettings.preserveParas,
    preserve_newlines: detectSettings.preserveNewlines,
  });

  if (result.ok) {
    const filtered = filterContainedRegions(filterRegionsBySettings(result.regions));
    spread.pages[side].segments = filtered;
    recomputeOrder(side);
    computeVolumeOrder();
    setStatus(`Detected ${filtered.length} region(s) on ${side} page (${result.regions.length} total)`, 'idle');
  } else {
    setStatus(`Detection error: ${result.error}`, 'idle');
  }
  renderSpreadList();
}

async function redetectAll() {
  if (!state.spread) return;
  state.spread.pages.left.segments  = [];
  state.spread.pages.right.segments = [];
  await detectPage('left');
  if (state.spread.rightPath) await detectPage('right');
  renderSegments('left');
  renderSegments('right');
  renderSegmentList();
}

// ── Render segments ────────────────────────────────────────────────────────

function renderSegments(side) {
  const layer = side === 'left' ? dom.segLayerLeft : dom.segLayerRight;
  if (!state.spread) return;
  layer.innerHTML = '';
  const segments = state.spread.pages[side]?.segments || [];
  segments.forEach(seg => {
    const el = createSegmentEl(seg);
    attachSegmentEvents(el, seg, side);
    layer.appendChild(el);
  });
}

function createSegmentEl(seg) {
  const cfg = TYPES[seg.type] || TYPES.body;
  const el  = document.createElement('div');
  el.className    = 'seg-box';
  el.dataset.id   = seg.id;
  el.dataset.type = seg.type;
  // Store in % units so position/size is immune to image-load timing.
  // The layer is positioned:relative and sized to match the image,
  // so % is always relative to the true page dimensions.
  el.style.cssText = `
    left:   ${seg.x * 100}%;
    top:    ${seg.y * 100}%;
    width:  ${seg.w * 100}%;
    height: ${seg.h * 100}%;
    border-color: ${cfg.color};
    background:   ${cfg.bg};
  `;
  const conf     = Math.round((seg.confidence || 0) * 100);
  const orderVal = seg.volOrder !== undefined ? seg.volOrder + 1 : (seg.order !== undefined ? seg.order + 1 : '?');
  const colBadge = seg.column > 0 ? `<span class="seg-col">c${seg.column}</span>` : '';
  el.innerHTML = `
    <div class="seg-label" style="background:${cfg.color}">
      <input class="seg-order-input" type="number" min="1" value="${orderVal}" title="Reading order">
      ${colBadge}<span>${cfg.label}</span>
      <span class="seg-conf">${conf}%</span>
      <button class="seg-del" data-id="${seg.id}">✕</button>
    </div>
    <div class="seg-resize"></div>
  `;
  el.querySelector('.seg-order-input').addEventListener('change', ev => {
    ev.stopPropagation();
    const newOrder = parseInt(ev.target.value, 10) - 1;
    if (isNaN(newOrder) || newOrder < 0) return;
    const page = state.spread?.pages[_segSide(el)];
    if (page) page.segments.forEach(s => { if (s.id !== seg.id && s.order >= newOrder) s.order++; });
    seg.order = newOrder; seg.orderLocked = true;
    renderSegments(_segSide(el));
  });
  el.querySelector('.seg-order-input').addEventListener('mousedown', ev => ev.stopPropagation());
  el.querySelector('.seg-order-input').addEventListener('click',     ev => ev.stopPropagation());
  return el;
}

function attachSegmentEvents(el, seg, side) {
  const layer = side === 'left' ? dom.segLayerLeft : dom.segLayerRight;

  el.querySelector('.seg-del').addEventListener('click', e => {
    e.stopPropagation();
    removeSegment(seg.id, side);
  });

  // Drag — work in px during interaction, write back as % on mouseup
  el.addEventListener('mousedown', e => {
    if (e.target.closest('.seg-resize') || e.target.closest('.seg-del')) return;
    e.stopPropagation();
    const rect = layer.getBoundingClientRect();
    // Convert current % position to px for arithmetic during drag
    const startPxL = seg.x * rect.width;
    const startPxT = seg.y * rect.height;
    const offX = e.clientX - rect.left - startPxL;
    const offY = e.clientY - rect.top  - startPxT;
    const onMove = ev => {
      const newL = Math.max(0, ev.clientX - rect.left - offX);
      const newT = Math.max(0, ev.clientY - rect.top  - offY);
      el.style.left = (newL / rect.width  * 100) + '%';
      el.style.top  = (newT / rect.height * 100) + '%';
    };
    const onUp = () => {
      syncSegFromEl(el, seg, layer);
      renderSegmentList();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Resize — track delta from start in px, convert to % on each move
  el.querySelector('.seg-resize').addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    const rect  = layer.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = seg.w * rect.width;
    const startH = seg.h * rect.height;
    const onMove = ev => {
      const newW = Math.max(20, startW + ev.clientX - startX);
      const newH = Math.max(16, startH + ev.clientY - startY);
      el.style.width  = (newW / rect.width  * 100) + '%';
      el.style.height = (newH / rect.height * 100) + '%';
    };
    const onUp = () => {
      syncSegFromEl(el, seg, layer);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Read back normalised coords from element's current % style values
function syncSegFromEl(el, seg, layer) {
  seg.x = parseFloat(el.style.left)   / 100;
  seg.y = parseFloat(el.style.top)    / 100;
  seg.w = parseFloat(el.style.width)  / 100;
  seg.h = parseFloat(el.style.height) / 100;
}

function removeSegment(id, side) {
  if (!state.spread) return;
  const page = state.spread.pages[side];
  page.segments = page.segments.filter(s => s.id !== id);
  delete page.ocrResults[id];
  renderSegments(side);
  renderSegmentList();
  updateCounts();
}

// ── Draw new segments ──────────────────────────────────────────────────────

function initDrawing(layer, side) {
  let drawing = false, drawEl = null, startX = 0, startY = 0;

  layer.addEventListener('mousedown', e => {
    if (!state.drawMode) return;
    if (e.target !== layer) return;
    if (!state.spread) return;
    e.preventDefault();
    drawing = true;
    const rect = layer.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    drawEl = document.createElement('div');
    drawEl.className = 'seg-box seg-drawing';
    const cfg = TYPES[state.activeType];
    drawEl.style.cssText = `
      left:${startX}px; top:${startY}px; width:2px; height:2px;
      border-color:${cfg.color}; background:${cfg.bg};
    `;
    layer.appendChild(drawEl);
  });

  document.addEventListener('mousemove', e => {
    if (!drawing || !drawEl) return;
    const rect = layer.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    drawEl.style.left   = Math.min(cx, startX) + 'px';
    drawEl.style.top    = Math.min(cy, startY) + 'px';
    drawEl.style.width  = Math.abs(cx - startX) + 'px';
    drawEl.style.height = Math.abs(cy - startY) + 'px';
  });

  document.addEventListener('mouseup', e => {
    if (!drawing) return;
    drawing = false;
    if (!drawEl) return;
    const w = parseFloat(drawEl.style.width);
    const h = parseFloat(drawEl.style.height);
    if (w < 10 || h < 10) { drawEl.remove(); drawEl = null; return; }

    const rect2 = layer.getBoundingClientRect();
    const seg = {
      id:         uid(),
      type:       state.activeType,
      x:          parseFloat(drawEl.style.left) / rect2.width,
      y:          parseFloat(drawEl.style.top)  / rect2.height,
      w:          w / rect2.width,
      h:          h / rect2.height,
      confidence: 1.0,
      source:     'manual',
    };

    state.spread.pages[side].segments.push(seg);
    recomputeOrder(side);
    computeVolumeOrder();
    drawEl.remove(); drawEl = null;
    renderSegments(side);
    renderSegmentList();
    updateCounts();
  });
}

// ── OCR ────────────────────────────────────────────────────────────────────

async function runOCR() {
  if (!state.spread) return;
  setStatus('Running OCR…', 'busy');
  switchTab('ocr');

  for (const side of ['left', 'right']) {
    const page    = state.spread.pages[side];
    const imgPath = side === 'left'
      ? state.spread.leftPath
      : state.spread.rightPath;
    if (!imgPath || page.segments.length === 0) continue;

    const settings = getDetectSettings();
    const result = await sidecar('run_ocr', {
      image_path:         imgPath,
      regions:            page.segments,
      language:           settings.ocrLanguage,
      use_best:           settings.useBest,
      preserve_newlines:  settings.preserveLineBreaks,
    });

    if (result.ok) {
      // Merge results so manually-drawn box results are not wiped
      page.ocrResults = Object.assign(page.ocrResults || {}, result.results);

    } else {
      setStatus(`OCR error (${side}): ${result.error}`, 'idle');
    }
  }

  renderOCRPanel();
  setStatus('OCR complete', 'idle');
}

// ── UI Rendering ───────────────────────────────────────────────────────────

// ── Spread list — drag state ───────────────────────────────────────────────
let _dragSrcId = null;

function renderSpreadList() {
  if (!state.volume) { dom.spreadList.innerHTML = ''; return; }
  dom.spreadList.innerHTML = '';

  state.volume.spreads.forEach((spread, i) => {
    const el = document.createElement('div');
    el.className = 'spread-item' + (state.spread?.id === spread.id ? ' active' : '');
    el.dataset.id = spread.id;
    el.draggable = true;

    const conf = avgConfidence(spread);
    const confColor = conf > 0.8 ? '#4a6741' : conf > 0.6 ? '#c4922a' : '#8b3a1a';
    const rightSegs = spread.pages.right?.segments?.length ?? 0;

    el.innerHTML = `
      <div class="spread-drag-handle" title="Drag to reorder">⠿</div>
      <div class="spread-num">${i + 1}</div>
      <div class="spread-info">
        <div class="spread-name">${shortName(spread.originalPath)}</div>
        <div class="spread-meta">
          ${spread.pages.left.segments.length + rightSegs} regions
          <span style="color:${confColor}">● ${Math.round(conf*100)}%</span>
          ${spread.splitMethod === 'centre' ? '<span class="warn-badge">⚠ centre split</span>' : ''}
        </div>
      </div>
      <button class="spread-del-btn" title="Delete this spread" data-id="${spread.id}">✕</button>
    `;

    // Select on click (but not on delete button)
    el.addEventListener('click', (e) => {
      if (e.target.closest('.spread-del-btn')) return;
      selectSpread(spread);
    });

    // Delete button
    el.querySelector('.spread-del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSpread(spread.id);
    });

    // Drag-and-drop handlers
    el.addEventListener('dragstart', (e) => {
      _dragSrcId = spread.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      document.querySelectorAll('.spread-item').forEach(s => s.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (spread.id !== _dragSrcId) {
        document.querySelectorAll('.spread-item').forEach(s => s.classList.remove('drag-over'));
        el.classList.add('drag-over');
      }
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (_dragSrcId && _dragSrcId !== spread.id) {
        const spreads = state.volume.spreads;
        const fromIdx = spreads.findIndex(s => s.id === _dragSrcId);
        const toIdx   = spreads.findIndex(s => s.id === spread.id);
        if (fromIdx >= 0 && toIdx >= 0) {
          const [moved] = spreads.splice(fromIdx, 1);
          spreads.splice(toIdx, 0, moved);
          renderSpreadList();
          updateCounts();
        }
      }
      _dragSrcId = null;
    });

    dom.spreadList.appendChild(el);
  });
}

function deleteSpread(spreadId) {
  if (!state.volume) return;
  if (!confirm('Delete this spread? This cannot be undone.')) return;
  const idx = state.volume.spreads.findIndex(s => s.id === spreadId);
  if (idx < 0) return;
  state.volume.spreads.splice(idx, 1);
  // If the deleted spread was selected, clear or select next
  if (state.spread?.id === spreadId) {
    state.spread = null;
    resetPagePlaceholders();
    dom.segLayerLeft.innerHTML  = '';
    dom.segLayerRight.innerHTML = '';
    if (state.volume.spreads.length > 0) {
      selectSpread(state.volume.spreads[Math.min(idx, state.volume.spreads.length - 1)]);
    }
  }
  renderSpreadList();
  updateCounts();
  setStatus('Spread deleted');
}

function renderSegmentList() {
  if (!state.spread) { dom.segmentList.innerHTML = '<div class="empty-state">No segments</div>'; return; }
  dom.segmentList.innerHTML = '';
  for (const side of ['left', 'right']) {
    const page = state.spread.pages[side];
    if (!page) continue;
    page.segments.forEach(seg => {
      const cfg = TYPES[seg.type] || TYPES.body;
      const el  = document.createElement('div');
      el.className = 'seg-list-item';
      el.innerHTML = `
        <span class="seg-dot" style="background:${cfg.color}"></span>
        <div>
          <div class="seg-item-type">${cfg.label} <span style="color:#5a5040;font-size:0.65rem">(${side})</span></div>
          <div class="seg-item-pos">${pct(seg.x)},${pct(seg.y)} ${pct(seg.w)}×${pct(seg.h)}</div>
        </div>
        <div class="seg-item-conf" style="color:${seg.confidence>0.75?'#4a6741':'#c4922a'}">${Math.round(seg.confidence*100)}%</div>
      `;
      el.addEventListener('click', () => {
        // Type relabelling
        const newType = prompt(`Change type (body/header/pagenum/footnote):`, seg.type);
        if (newType && TYPES[newType]) {
          seg.type = newType;
          seg.confidence = 1.0;
          renderSegments(side);
          renderSegmentList();
        }
      });
      dom.segmentList.appendChild(el);
    });
  }
}

function renderOCRPanel() {
  if (!state.spread) return;
  dom.ocrPanel.innerHTML = '';
  for (const side of ['left', 'right']) {
    const page = state.spread.pages[side];
    if (!page) continue;
    const sortedSegs = [...page.segments].sort((a,b)=>(a.order??a.y)-(b.order??b.y));
    sortedSegs.forEach(seg => {
      const res = page.ocrResults[seg.id];
      if (!res) return;
      const cfg = TYPES[seg.type] || TYPES.body;
      const el  = document.createElement('div');
      el.className = 'ocr-block';
      el.innerHTML = `
        <div class="ocr-block-hdr" style="background:${cfg.color}">
          <span>${cfg.label}</span>
          <span style="font-size:0.6rem;opacity:0.8">${side} · ${Math.round((res.confidence||0)*100)}% conf</span>
          <button class="ocr-autocorrect-btn">Auto-correct</button>
        </div>
        <div class="ocr-block-text" contenteditable="true"></div>
      `;
      // Set text via textContent — never via innerHTML — so Bengali/Unicode is
      // never parsed as HTML and ZWJ/ZWNJ characters are preserved exactly.
      el.querySelector('.ocr-block-text').textContent = res.text || '';
      // Read back with innerText to preserve line breaks from <br> elements
      // that contenteditable inserts when the user presses Enter.
      el.querySelector('.ocr-block-text').addEventListener('input', ev => { res.text = ev.target.innerText; });
      el.querySelector('.ocr-autocorrect-btn').addEventListener('click', async () => {
        const btn = el.querySelector('.ocr-autocorrect-btn');
        const textEl = el.querySelector('.ocr-block-text');
        const orig = res.text || '';
        if (!orig.trim()) return;
        if (!res._original) res._original = orig;
        btn.textContent = 'Correcting…'; btn.disabled = true;
        try {
          const result = await sidecar('correct_ocr', { text: orig });
          if (result.ok && result.corrected) {
            res.text = result.corrected; textEl.textContent = result.corrected;
            btn.textContent = '✓ Undo'; btn.disabled = false;
            btn.classList.add('ocr-autocorrect-done');
            btn.onclick = () => {
              res.text = res._original; textEl.textContent = res._original;
              delete res._original;
              btn.textContent = 'Auto-correct'; btn.disabled = false;
              btn.classList.remove('ocr-autocorrect-done'); btn.onclick = null;
            };
          } else {
            btn.textContent = 'Error'; btn.disabled = false;
            setTimeout(() => { btn.textContent = 'Auto-correct'; }, 2000);
            if (result.error) setStatus(`Auto-correct: ${result.error}`, 'idle');
          }
        } catch(e) { btn.textContent = 'Error'; btn.disabled = false; setTimeout(() => { btn.textContent = 'Auto-correct'; }, 2000); }
      });
      dom.ocrPanel.appendChild(el);
    });
  }
  if (!dom.ocrPanel.children.length) {
    dom.ocrPanel.innerHTML = '<div class="empty-state">Run OCR first</div>';
  }
}

function renderCompiledPanel() {
  if (!state.spread) return;
  let html = '';
  for (const side of ['left', 'right']) {
    const page = state.spread.pages[side];
    if (!page || Object.keys(page.ocrResults).length === 0) continue;
    const sorted = [...page.segments].sort((a,b)=>(a.order??a.y)-(b.order??b.y));
    sorted.forEach(seg => {
      const res = page.ocrResults[seg.id];
      if (!res?.text?.trim()) return;
      const cfg = TYPES[seg.type] || TYPES.body;
      html += `<div class="compiled-block ${seg.type}">
        <div class="compiled-block-label" style="color:${cfg.color}">${cfg.label}</div>
        <div class="compiled-block-text">${escHtml(res.text)}</div>
      </div>`;
    });
  }
  dom.compiledPanel.innerHTML = html || '<div class="empty-state">Compile a page to see output</div>';
}


function updateCounts() {
  const segs = state.spread
    ? state.spread.pages.left.segments.length + (state.spread.pages.right?.segments.length || 0)
    : 0;
  const spreads = state.volume?.spreads.length || 0;
  dom.segCount.textContent   = `${segs} region${segs !== 1 ? 's' : ''}`;
  dom.spreadCount.textContent = `${spreads} spread${spreads !== 1 ? 's' : ''}`;
}

function renderProjectName() {
  document.getElementById('projectName').textContent = state.project?.name || 'No project';
}

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(name) {
  dom.rightTabs.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  dom.tabContents.forEach(c => c.classList.toggle('active', c.id === 'tab-' + name));
}
dom.rightTabs.forEach(btn => btn.addEventListener('click', () => {
  switchTab(btn.dataset.tab);
  if (btn.dataset.tab === 'ocr')      renderOCRPanel();
  if (btn.dataset.tab === 'compiled') renderCompiledPanel();
}));

// ── Toolbar type selection ─────────────────────────────────────────────────
document.querySelectorAll('.type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.activeType = btn.dataset.type;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ── Init ──────────────────────────────────────────────────────────────────

// ── Panel scroll sync ──────────────────────────────────────────────────────
function syncPanelScroll() {
  const a = document.querySelector('.spread-item.active');
  if (a) a.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Language selector ──────────────────────────────────────────────────────
async function populateLanguages() {
  const sel = document.getElementById('ocrLanguage');
  const mod = document.getElementById('ocrModel');
  if (!sel) return;
  try {
    const r = await sidecar('get_languages');
    if (!r.ok) return;
    const useBest = (mod?.value || 'best') === 'best';
    const langs = useBest ? (r.languages.tessdata_best||[]) : (r.languages.tessdata||[]);
    const prev = sel.value;
    sel.innerHTML = '';
    if (!langs.length) { sel.innerHTML = '<option value="eng">eng</option>'; return; }
    langs.forEach(code => {
      const o = document.createElement('option');
      o.value = code; o.textContent = code;
      if (code === prev || code === 'eng') o.selected = true;
      sel.appendChild(o);
    });
    if (!sel.value) sel.value = langs[0];
  } catch(e) { console.warn('Could not load languages:', e); }
}

// ── Reading order ──────────────────────────────────────────────────────────
function recomputeOrder(side) {
  const page = state.spread?.pages[side];
  if (!page) return;
  const segs = page.segments;
  const bodySegs = segs.filter(s => s.type === 'body');
  let gutterX = null;
  if (bodySegs.some(s => s.column > 0)) {
    const c1 = bodySegs.filter(s => s.column === 1);
    const c2 = bodySegs.filter(s => s.column === 2);
    if (c1.length && c2.length)
      gutterX = (Math.max(...c1.map(s=>s.x+s.w)) + Math.min(...c2.map(s=>s.x))) / 2;
  }
  const locked = segs.filter(s => s.orderLocked);
  if (locked.length) {
    const used = new Set(locked.map(s => s.order));
    let idx = 0;
    segs.filter(s => !s.orderLocked).sort((a,b)=>a.y-b.y)
        .forEach(s => { while (used.has(idx)) idx++; s.order = idx++; });
    return;
  }
  let idx = 0;
  segs.filter(s=>s.type==='header').sort((a,b)=>a.y-b.y).forEach(s=>{s.order=idx++;s.column=s.column||0;});
  const bodies = segs.filter(s=>s.type==='body');
  if (gutterX !== null) {
    const c1 = bodies.filter(s=>(s.x+s.w/2)<gutterX).sort((a,b)=>a.y-b.y);
    const c2 = bodies.filter(s=>(s.x+s.w/2)>=gutterX).sort((a,b)=>a.y-b.y);
    if (c1.length && c2.length) {
      c1.forEach(s=>{s.order=idx++;s.column=1;}); c2.forEach(s=>{s.order=idx++;s.column=2;});
    } else bodies.sort((a,b)=>a.y-b.y).forEach(s=>{s.order=idx++;s.column=0;});
  } else bodies.sort((a,b)=>a.y-b.y).forEach(s=>{s.order=idx++;s.column=0;});
  segs.filter(s=>!['header','pagenum','body'].includes(s.type)).sort((a,b)=>a.y-b.y).forEach(s=>{s.order=idx++;});
  segs.filter(s=>s.type==='pagenum').sort((a,b)=>a.y-b.y).forEach(s=>{s.order=idx++;});
}

function _segSide(el) {
  const layer = (el.closest('.seg-box')||el).closest('.seg-layer');
  return layer?.id === 'segLayerLeft' ? 'left' : 'right';
}

function computeVolumeOrder() {
  if (!state.volume) return;
  let idx = 0;
  for (const spread of state.volume.spreads)
    for (const side of ['left','right']) {
      const page = spread.pages[side];
      if (!page?.segments?.length) continue;
      [...page.segments].sort((a,b)=>(a.order??0)-(b.order??0)).forEach(seg => { seg.volOrder = idx++; });
    }
}

// ── Image tools ────────────────────────────────────────────────────────────
function getPageHistory(side) {
  if (!state.spread) return [];
  const page = state.spread.pages[side];
  if (!page.imageHistory) page.imageHistory = [];
  return page.imageHistory;
}

async function processImage(side, op, params={}) {
  if (!state.spread) return;
  const imgPath = side==='left' ? state.spread.leftPath : state.spread.rightPath;
  if (!imgPath) return;
  setStatus(`Applying ${op}...`, 'busy');
  const result = await sidecar('process_image', {op, image_path:imgPath, ...params});
  if (!result.ok) { setStatus(`Image error: ${result.error}`, 'idle'); return; }
  getPageHistory(side).push(imgPath);
  if (side==='left') state.spread.leftPath=result.new_path;
  else state.spread.rightPath=result.new_path;
  const imgEl = side==='left' ? dom.pageImgLeft : dom.pageImgRight;
  await loadPageImageFromPath(imgEl, result.new_path);
  state.spread.pages[side].segments=[]; state.spread.pages[side].ocrResults={};
  await detectPage(side); renderSegments(side); renderSegmentList();
  updateImageToolPanel(side, result); setStatus(`${op} applied`, 'idle');
}

async function undoImageOp(side) {
  const hist = getPageHistory(side); if (!hist.length) return;
  const prev = hist.pop();
  if (side==='left') state.spread.leftPath=prev; else state.spread.rightPath=prev;
  const imgEl = side==='left' ? dom.pageImgLeft : dom.pageImgRight;
  await loadPageImageFromPath(imgEl, prev);
  state.spread.pages[side].segments=[]; state.spread.pages[side].ocrResults={};
  await detectPage(side); renderSegments(side); renderSegmentList();
  setStatus('Undo applied', 'idle'); updateImageToolPanel(side, null);
}

function updateImageToolPanel(side, result) {
  const panel = document.getElementById(`imgToolPanel_${side}`);
  if (!panel) return;
  const u = panel.querySelector('.itp-undo');
  if (u) u.disabled = getPageHistory(side).length === 0;
  const st = panel.querySelector('.itp-status');
  if (st) st.textContent = result?.angle !== undefined ? `Corrected ${result.angle}°` : result ? 'Applied' : '';
}

let perspState = null;

function startPerspectiveMode(side) {
  if (perspState) cancelPerspectiveMode();
  const layer = side==='left' ? dom.segLayerLeft : dom.segLayerRight;
  const overlay = document.createElement('div'); overlay.className='persp-overlay'; layer.appendChild(overlay);
  const handles = [[0.02,0.02],[0.98,0.02],[0.98,0.98],[0.02,0.98]].map(([nx,ny]) => {
    const el = document.createElement('div'); el.className='persp-handle';
    el.style.left=`${nx*100}%`; el.style.top=`${ny*100}%`; layer.appendChild(el);
    const h = {x:nx,y:ny,el};
    el.addEventListener('mousedown', ev => {
      ev.stopPropagation(); const lr = layer.getBoundingClientRect();
      const mv=e=>{h.x=Math.max(0,Math.min(1,(e.clientX-lr.left)/lr.width));h.y=Math.max(0,Math.min(1,(e.clientY-lr.top)/lr.height));el.style.left=`${h.x*100}%`;el.style.top=`${h.y*100}%`;};
      const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);};
      document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
    }); return h;
  });
  perspState={side,handles,overlay};
  const panel=document.getElementById(`imgToolPanel_${side}`);
  if(panel){panel.querySelector('.persp-apply-bar').style.display='flex';panel.querySelector('[data-op="perspective"]').textContent='Editing...';}
}

function cancelPerspectiveMode() {
  if (!perspState) return;
  const layer=perspState.side==='left'?dom.segLayerLeft:dom.segLayerRight;
  perspState.overlay.remove(); perspState.handles.forEach(h=>h.el.remove());
  const panel=document.getElementById(`imgToolPanel_${perspState.side}`);
  if(panel){panel.querySelector('.persp-apply-bar').style.display='none';panel.querySelector('[data-op="perspective"]').textContent='Perspective';}
  perspState=null;
}

async function applyPerspective() {
  if (!perspState) return;
  const pts=perspState.handles.map(h=>[h.x,h.y]); const side=perspState.side;
  cancelPerspectiveMode(); await processImage(side,'perspective_correct',{src_points:pts});
}

function renderImageToolPanel(side) {
  const wrap=side==='left'?dom.wrapLeft:dom.wrapRight;
  const existing=document.getElementById(`imgToolPanel_${side}`);
  if(existing){existing._resetPreview?.();existing.remove();return;}
  const panel=document.createElement('div'); panel.id=`imgToolPanel_${side}`; panel.className='img-tool-panel';
  panel.innerHTML=`
    <div class="itp-header"><span>Image Tools</span><span class="itp-status"></span><button class="itp-undo tbtn" disabled>Undo</button></div>
    <div class="itp-section"><div class="itp-section-title">Auto-correct</div><div class="itp-row"><button class="tbtn" data-op="deskew">Deskew</button></div></div>
    <div class="itp-section"><div class="itp-section-title">Rotate</div>
      <div class="itp-row"><button class="tbtn" data-op="rotate-ccw">90 CCW</button><button class="tbtn" data-op="rotate-cw">90 CW</button><button class="tbtn" data-op="rotate-180">180</button></div>
      <div class="itp-row itp-slider-row"><label>Fine <span class="itp-fine-val">0</span></label><input type="range" min="-10" max="10" step="0.5" value="0" class="itp-rotate-fine"><button class="tbtn" data-op="rotate-fine">Apply</button></div>
    </div>
    <div class="itp-section"><div class="itp-section-title">Levels <small>(live preview)</small></div>
      <div class="itp-row itp-slider-row"><label>Black <span class="itp-bp-val">0</span></label><input type="range" min="0" max="127" value="0" class="itp-black-pt"></div>
      <div class="itp-row itp-slider-row"><label>White <span class="itp-wp-val">255</span></label><input type="range" min="128" max="255" value="255" class="itp-white-pt"></div>
      <div class="itp-row itp-slider-row"><label>Gamma <span class="itp-gm-val">1.0</span></label><input type="range" min="0.2" max="3.0" step="0.1" value="1.0" class="itp-gamma"></div>
      <div class="itp-row"><button class="tbtn" data-op="levels">Apply Levels</button></div>
    </div>
    <div class="itp-section"><div class="itp-section-title">Perspective</div>
      <div class="itp-row"><button class="tbtn" data-op="perspective">Perspective</button></div>
      <div class="persp-apply-bar itp-row" style="display:none"><button class="tbtn primary" data-op="persp-apply">Apply</button><button class="tbtn" data-op="persp-cancel">Cancel</button></div>
    </div>`;
  wrap.appendChild(panel);
  const imgEl=side==='left'?dom.pageImgLeft:dom.pageImgRight;
  const bp=panel.querySelector('.itp-black-pt'),wp=panel.querySelector('.itp-white-pt'),gm=panel.querySelector('.itp-gamma');
  function lvlPreview(){
    const b=parseInt(bp.value),w=parseInt(wp.value),g=parseFloat(gm.value);
    panel.querySelector('.itp-bp-val').textContent=b;
    panel.querySelector('.itp-wp-val').textContent=w;
    panel.querySelector('.itp-gm-val').textContent=g.toFixed(1);
    const c=(255/(w-b)).toFixed(2),br=(1-b/255).toFixed(2),gb=(g>1?(1+(g-1)*0.25):(1-(1-g)*0.25)).toFixed(2);
    imgEl.style.filter=`contrast(${c}) brightness(${br}) brightness(${gb})`;
  }
  bp.addEventListener('input',lvlPreview); wp.addEventListener('input',lvlPreview); gm.addEventListener('input',lvlPreview);
  panel._resetPreview=()=>{imgEl.style.filter='';};
  panel.querySelector('.itp-rotate-fine').addEventListener('input',ev=>{panel.querySelector('.itp-fine-val').textContent=ev.target.value;});
  panel.addEventListener('click',async ev=>{
    const btn=ev.target.closest('[data-op]'); if(!btn)return; const op=btn.dataset.op;
    if(op==='deskew')           await processImage(side,'deskew');
    else if(op==='rotate-ccw')  await processImage(side,'rotate',{angle:270});
    else if(op==='rotate-cw')   await processImage(side,'rotate',{angle:90});
    else if(op==='rotate-180')  await processImage(side,'rotate',{angle:180});
    else if(op==='rotate-fine'){const a=parseFloat(panel.querySelector('.itp-rotate-fine').value);if(a!==0)await processImage(side,'rotate',{angle:(a+360)%360});}
    else if(op==='levels'){imgEl.style.filter='';await processImage(side,'adjust_levels',{black_pt:parseInt(bp.value),white_pt:parseInt(wp.value),gamma:parseFloat(gm.value)});}
    else if(op==='perspective')  startPerspectiveMode(side);
    else if(op==='persp-apply')  await applyPerspective();
    else if(op==='persp-cancel') cancelPerspectiveMode();
  });
  panel.querySelector('.itp-undo').addEventListener('click',()=>undoImageOp(side));
  updateImageToolPanel(side,null);
}


// ── PDF progress UI ────────────────────────────────────────────────────────
function showPdfProgress(filename, done, total) {
  let bar = document.getElementById('pdfProgressBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pdfProgressBar';
    bar.className = 'pdf-progress-overlay';
    bar.innerHTML = `
      <div class="pdf-progress-box">
        <div class="pdf-progress-title">Converting PDF</div>
        <div class="pdf-progress-filename" id="pdfProgressName"></div>
        <div class="pdf-progress-track">
          <div class="pdf-progress-fill" id="pdfProgressFill"></div>
        </div>
        <div class="pdf-progress-label" id="pdfProgressLabel">Starting…</div>
      </div>`;
    document.body.appendChild(bar);
  }
  bar.style.display = 'flex';
  document.getElementById('pdfProgressName').textContent = filename;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('pdfProgressFill').style.width = pct + '%';
  document.getElementById('pdfProgressLabel').textContent =
    total > 0 ? `${done} / ${total} pages (${pct}%)` : 'Starting…';
}

function hidePdfProgress() {
  const bar = document.getElementById('pdfProgressBar');
  if (bar) bar.style.display = 'none';
}

async function pollPdfJob(jobId, filename) {
  while (true) {
    await new Promise(r => setTimeout(r, 800));
    let job;
    try {
      job = await fetch(`${API}/api/pdf_progress/${jobId}`).then(r => r.json());
    } catch(e) { continue; }

    if (!job.ok) return null;

    showPdfProgress(filename, job.progress, job.total);

    if (job.status === 'done')  return job.page_paths;
    if (job.status === 'error') {
      setStatus(`PDF error: ${job.error}`, 'idle');
      return null;
    }
  }
}


// ── Progress bar ───────────────────────────────────────────────────────────
let _progressBar = null;

function showProgressBar(label, current, total) {
  hideProgressBar();
  const el = document.createElement('div');
  el.className = 'progress-bar-wrap';
  el.innerHTML = `
    <span class="progress-bar-label">${label}</span>
    <div class="progress-bar-track"><div class="progress-bar-fill" style="width:0%"></div></div>
    <span class="progress-bar-count">${current} / ${total}</span>
  `;
  document.querySelector('.statusbar').after(el);
  _progressBar = el;
  updateProgressBar(current, total, label);
}

function updateProgressBar(current, total, label) {
  if (!_progressBar) return;
  const pct = total > 0 ? Math.round(current / total * 100) : 0;
  _progressBar.querySelector('.progress-bar-fill').style.width = pct + '%';
  _progressBar.querySelector('.progress-bar-count').textContent = `${current} / ${total}`;
  if (label) _progressBar.querySelector('.progress-bar-label').textContent = label;
}

function hideProgressBar() {
  if (_progressBar) { _progressBar.remove(); _progressBar = null; }
}

document.addEventListener('DOMContentLoaded', () => {
  // Toolbar actions
  document.getElementById('btnNewProject').addEventListener('click', newProject);
  document.getElementById('btnImport').addEventListener('click', importSpreads);
  document.getElementById('btnSaveProject').addEventListener('click', saveProject);
  document.getElementById('btnLoadProject').addEventListener('click', loadProject);
  document.getElementById('btnRedetect').addEventListener('click', redetectAll);
  document.getElementById('btnRunOcr').addEventListener('click', runOCR);

  // Type selector buttons
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeType = btn.dataset.type;
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Init drawing on both pages
  initDrawing(dom.segLayerLeft,  'left');
  initDrawing(dom.segLayerRight, 'right');

  // Rerender on resize
  window.addEventListener('resize', () => {
    if (state.spread) { renderSegments('left'); renderSegments('right'); }
  });

  // Sidebar collapse
  const _sbBtn = document.getElementById('btnSidebarToggle');
  _sbBtn?.addEventListener('click', () => {
    const c = document.querySelector('.sidebar').classList.toggle('collapsed');
    _sbBtn.textContent = c ? '›' : '‹';
    _sbBtn.title = c ? 'Expand sidebar' : 'Collapse sidebar';
  });
  // Panel expand
  const _panBtn = document.getElementById('btnPanelExpand');
  _panBtn?.addEventListener('click', () => {
    const e = document.querySelector('.right-panel').classList.toggle('expanded');
    _panBtn.textContent = e ? '‹' : '›';
    _panBtn.title = e ? 'Collapse panel' : 'Expand panel';
  });
  // Canvas view controls
  document.querySelectorAll('.canvas-ctrl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.canvas-ctrl-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const cv = document.getElementById('canvasArea');
      cv.classList.remove('view-both','view-left','view-right');
      cv.classList.add('view-' + btn.dataset.view);
    });
  });
  // Edit image buttons
  document.getElementById('btnEditImageLeft')?.addEventListener('click', () => renderImageToolPanel('left'));
  document.getElementById('btnEditImageRight')?.addEventListener('click', () => renderImageToolPanel('right'));
  // Language list reload on model change
  document.getElementById('ocrModel')?.addEventListener('change', populateLanguages);
  // Ping sidecar then populate languages
  (async () => {
    try {
      const r = await sidecar('ping');
      setStatus(`Ready (v${r.version})`, 'idle');
      await populateLanguages();
    } catch(e) {
      setStatus('Server not available — is app.py running?', 'error');
    }
  })();
});

// ── Helpers ────────────────────────────────────────────────────────────────
function uid()        { return Math.random().toString(36).slice(2, 10); }
function pct(v)       { return Math.round(v * 100) + '%'; }
function escHtml(s)   { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function shortName(p) { return p ? p.split(/[\\/]/).pop() : ''; }
function avgConfidence(spread) {
  const all = [...spread.pages.left.segments, ...(spread.pages.right?.segments||[])];
  if (!all.length) return 0;
  return all.reduce((s, r) => s + (r.confidence||0), 0) / all.length;
}