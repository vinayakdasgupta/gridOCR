/**
 * gridOCR — Frontend Application
 * app.js
 *
 * Communicates with the Flask backend via fetch().
 * All heavy lifting (OpenCV, Tesseract) runs in the Python sidecar.
 */

// ── HTTP API ───────────────────────────────────────────────────────────────
const API = "http://localhost:5000";

async function sidecar(action, params = {}) {
    const res = await fetch(`${API}/api/sidecar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
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
        ocrModel:            document.getElementById('ocrModel')?.value          || 'best',
        useBest:             (document.getElementById('ocrModel')?.value || 'best') === 'best',
    };
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
        input.accept = 'image/jpeg,image/png,image/tiff,.jpg,.jpeg,.png,.tif,.tiff';
        input.onchange = async () => {
            if (!input.files.length) { resolve([]); return; }
            // Upload files to server and get back temp paths
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
  confidenceBar:  document.getElementById('confidenceBar'),
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
  // Auto-create a default volume if none exists
  if (!state.volume) {
    const vol = { id: uid(), name: 'Volume 1', spreads: [] };
    state.project.volumes.push(vol);
    state.volume = vol;
    dom.volumeName.textContent = vol.name;
  }
  // Use browser file picker
  const paths = await pickImageFiles();
  if (!paths || paths.length === 0) return;

  setStatus(`Importing ${paths.length} spread(s)…`, 'busy');

  for (const imgPath of paths) {
    const outDir = `tmp/${state.volume.id}/${uid()}`;
    const splitResult = await sidecar('split_spread', { image_path: imgPath, out_dir: outDir });

    if (!splitResult.ok) {
      console.error('Split error:', splitResult.error);
      continue;
    }

    const spread = {
      id: uid(),
      originalPath: imgPath,
      leftPath:  splitResult.left_path,
      rightPath: splitResult.right_path,
      spineX:    splitResult.spine_x,
      splitMethod: splitResult.method,
      imageW:    splitResult.image_w,
      imageH:    splitResult.image_h,
      detectionRun: false,
      pages: {
        left:  { segments: [], ocrResults: {}, confirmed: false },
        right: { segments: [], ocrResults: {}, confirmed: false },
      }
    };
    state.volume.spreads.push(spread);
  }

  renderSpreadList();
  setStatus(`Imported ${paths.length} spread(s)`, 'idle');
  updateCounts();

  // Auto-select first
  if (state.volume.spreads.length > 0 && !state.spread) {
    selectSpread(state.volume.spreads[0]);
  }
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
    const filtered = filterRegionsBySettings(result.regions);
    spread.pages[side].segments = filtered;
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
  const conf = Math.round((seg.confidence || 0) * 100);
  el.innerHTML = `
    <div class="seg-label" style="background:${cfg.color}">
      <span>${cfg.label}</span>
      <span class="seg-conf">${conf}%</span>
      <button class="seg-del" data-id="${seg.id}">✕</button>
    </div>
    <div class="seg-resize"></div>
  `;
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
    const sortedSegs = [...page.segments].sort((a,b)=>a.y-b.y);
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
        </div>
        <div class="ocr-block-text" contenteditable="true"></div>
      `;
      // Set text via textContent — never via innerHTML — so Bengali/Unicode is
      // never parsed as HTML and ZWJ/ZWNJ characters are preserved exactly.
      el.querySelector('.ocr-block-text').textContent = res.text || '';
      // Read back with innerText to preserve line breaks from <br> elements
      // that contenteditable inserts when the user presses Enter.
      el.querySelector('.ocr-block-text').addEventListener('input', ev => {
        res.text = ev.target.innerText;
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
    const sorted = [...page.segments].sort((a,b)=>a.y-b.y);
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


// ── Language selector ──────────────────────────────────────────────────────
async function populateLanguages() {
  const sel      = document.getElementById('ocrLanguage');
  const modelSel = document.getElementById('ocrModel');
  if (!sel) return;
  const useBest = (modelSel?.value || 'best') === 'best';
  try {
    const r = await sidecar('get_languages');
    if (!r.ok) return;
    const langs = useBest
      ? (r.languages.tessdata_best || [])
      : (r.languages.tessdata     || []);
    const prev = sel.value;
    sel.innerHTML = '';
    if (!langs.length) {
      sel.innerHTML = '<option value="eng">eng</option>';
      return;
    }
    langs.forEach(code => {
      const opt = document.createElement('option');
      opt.value       = code;
      opt.textContent = code;
      if (code === prev || code === 'eng') opt.selected = true;
      sel.appendChild(opt);
    });
    if (!sel.value) sel.value = langs[0];
  } catch(e) {
    console.warn('Could not load language list:', e);
  }
}

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

  // Repopulate when model changes
  document.getElementById('ocrModel')?.addEventListener('change', populateLanguages);
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