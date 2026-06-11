'use strict';

// ── Flyer import pipeline (GroceryPal v2) ─────────────────────────────────
// Tesseract.js v5 OCR → candidate extraction → mandatory human review → Supabase submit

const MAX_OCR_EDGE = 2500; // px — downscale before OCR for speed

// State
let flyerCanvas = null;     // scaled-down canvas for display + OCR
let flyerCtx    = null;
let flyerScale  = 1;        // ratio: display px / original px
let candidates  = [];       // [{name, price, unit, frozen, barcode, bbox, confidence}]
let cropActive  = false;
let cropStart   = null;

// ── Section visibility ─────────────────────────────────────────────────────
function showFlyerSection(id) {
    ['flyer-upload-area', 'flyer-ocr-progress', 'flyer-review-area'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}

// ── Image upload & OCR trigger ─────────────────────────────────────────────
function initFlyerUpload() {
    const dropArea = document.getElementById('flyer-drop-area');
    const fileInput = document.getElementById('flyerFileInput');
    const uploadBtn = document.getElementById('flyerUploadBtn');

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
        if (e.target.files[0]) startOCR(e.target.files[0]);
        e.target.value = '';
    });

    dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('drag-over'); });
    dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
    dropArea.addEventListener('drop', e => {
        e.preventDefault();
        dropArea.classList.remove('drag-over');
        const f = e.dataTransfer.files[0];
        if (f && /^image\//.test(f.type)) startOCR(f);
    });
}

// ── Scale image to canvas ─────────────────────────────────────────────────
function loadImageToCanvas(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const long = Math.max(img.width, img.height);
            flyerScale = long > MAX_OCR_EDGE ? MAX_OCR_EDGE / long : 1;
            const w = Math.round(img.width  * flyerScale);
            const h = Math.round(img.height * flyerScale);
            flyerCanvas = document.getElementById('flyerCanvas');
            flyerCanvas.width  = w;
            flyerCanvas.height = h;
            flyerCtx = flyerCanvas.getContext('2d');
            flyerCtx.drawImage(img, 0, 0, w, h);
            resolve();
        };
        img.onerror = reject;
        img.src = url;
    });
}

// ── Main OCR entry point ───────────────────────────────────────────────────
async function startOCR(file) {
    showFlyerSection('flyer-ocr-progress');
    setOCRStatus('Loading image…', 0);
    try {
        await loadImageToCanvas(file);
        setOCRStatus('Running OCR… (this may take ~30 seconds)', 10);
        const result = await Tesseract.recognize(flyerCanvas, 'eng', {
            logger: m => {
                if (m.status === 'recognizing text') {
                    setOCRStatus('Running OCR…', Math.round(10 + m.progress * 80));
                }
            }
        });
        setOCRStatus('Extracting items…', 92);
        const { data } = result;
        const words = data.words || [];

        // Detect validity dates
        const validRange = parseValidityRange(data.text || '');
        prefillValidityDates(validRange);

        // Detect chain from full text
        prefillChain(data.text || '');

        // Extract candidates
        candidates = buildCandidates(words);
        setOCRStatus('Done.', 100);
        renderReviewUI();
        showFlyerSection('flyer-review-area');
    } catch (e) {
        console.error('OCR error', e);
        setOCRStatus('OCR failed: ' + e.message, 0);
        showFlyerSection('flyer-upload-area');
        alert('OCR failed. Please try a clearer image.');
    }
}

function setOCRStatus(msg, pct) {
    document.getElementById('ocrStatusText').textContent = msg;
    document.getElementById('ocrProgressBar').style.width = pct + '%';
}

// ── Validity date parser ───────────────────────────────────────────────────
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DAYS   = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const ORDINAL = '(?:st|nd|rd|th)?';

function parseValidityRange(text) {
    // Matches: "Thursday, June 11th to Wednesday, June 17th, 2026"
    // or: "June 11 – June 17, 2026"
    const dateAtom = `(?:(?:${DAYS}),?\\s+)?(?:${MONTHS})\\s+\\d{1,2}${ORDINAL}`;
    const sep   = `(?:\\s+to\\s+|\\s*[–—-]\\s*)`;
    const year  = `(?:,?\\s*(\\d{4}))?`;
    const re    = new RegExp(`(${dateAtom})${sep}(${dateAtom})${year}`, 'i');
    const m = text.match(re);
    if (!m) return null;

    const yr = m[3] || new Date().getFullYear().toString();
    const from = parseLooseDate(m[1], yr);
    const to   = parseLooseDate(m[2], yr);
    if (!from || !to) return null;
    return { from, to };
}

function parseLooseDate(str, yr) {
    const mo = new RegExp(`(${MONTHS})`, 'i').exec(str);
    const dayM = /\d{1,2}/.exec(str);
    if (!mo || !dayM) return null;
    const d = new Date(`${mo[1]} ${dayM[0]}, ${yr}`);
    if (isNaN(d)) return null;
    return d.toISOString().slice(0, 10);
}

function prefillValidityDates(range) {
    if (!range) return;
    document.getElementById('flyerValidFrom').value = range.from;
    document.getElementById('flyerValidTo').value   = range.to;
}

function prefillChain(text) {
    const lower = text.toLowerCase();
    const chainMap = [
        ['nofrills', ['no frills', 'nofrills']],
        ['freshco',  ['freshco', 'fresh co']],
        ['walmart',  ['walmart']],
        ['metro',    ['metro']],
    ];
    for (const [key, aliases] of chainMap) {
        if (aliases.some(a => lower.includes(a))) {
            document.getElementById('flyerChainSelect').value = key;
            return;
        }
    }
}

// ── Price detection ────────────────────────────────────────────────────────
const PRICE_RE  = /^\$?(\d{1,3})[\.,](\d{2})$/;   // $4.98 or 4,98
const CENTS_RE  = /^(\d{1,3})¢$/;
const DIGITS_RE = /^\d{2,3}$/;                     // superscript cents pair

function detectPriceTokens(words) {
    const tokens = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const t = w.text.trim();

        // $X.XX
        let m = PRICE_RE.exec(t);
        if (m) {
            const price = parseFloat(`${m[1]}.${m[2]}`);
            let unit = 'each';
            // peek next word for /lb, lb, per lb
            const next = words[i+1]?.text.trim().toLowerCase();
            if (next && /^(lb|\/lb|kg|\/kg)$/.test(next)) unit = next.replace('/', '');
            tokens.push({ price, unit, bbox: w.bbox, confidence: w.confidence });
            continue;
        }

        // XX¢
        m = CENTS_RE.exec(t);
        if (m) {
            tokens.push({ price: parseInt(m[1]) / 100, unit: 'each', bbox: w.bbox, confidence: w.confidence });
            continue;
        }

        // Superscript-cents pair: "$4" adjacent to "98"
        if (/^\$\d{1,2}$/.test(t) && words[i+1]) {
            const next2 = words[i+1].text.trim();
            if (DIGITS_RE.test(next2)) {
                const dollars = parseInt(t.replace('$', ''));
                const cents   = parseInt(next2);
                // Boxes should be adjacent (within 2× word height)
                const gap = words[i+1].bbox.x0 - w.bbox.x1;
                const height = w.bbox.y1 - w.bbox.y0;
                if (gap < height * 2) {
                    tokens.push({ price: dollars + cents / 100, unit: 'each',
                        bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: words[i+1].bbox.x1, y1: words[i+1].bbox.y1 },
                        confidence: Math.min(w.confidence, words[i+1].confidence) });
                    i++;
                    continue;
                }
            }
        }
    }
    return tokens;
}

// ── Spatial clustering ────────────────────────────────────────────────────
function medianWordHeight(words) {
    const heights = words.map(w => w.bbox.y1 - w.bbox.y0).filter(h => h > 0);
    if (!heights.length) return 20;
    heights.sort((a, b) => a - b);
    return heights[Math.floor(heights.length / 2)];
}

function bboxOverlapsOrNear(a, b, gap) {
    return !(b.x0 > a.x1 + gap || a.x0 > b.x1 + gap ||
             b.y0 > a.y1 + gap || a.y0 > b.y1 + gap);
}

function expandBBox(a, b) {
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
             x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function clusterTiles(words) {
    if (!words.length) return [];
    const gap = medianWordHeight(words) * 1.5;
    const clusters = [];

    for (const word of words) {
        let merged = false;
        for (const cl of clusters) {
            if (bboxOverlapsOrNear(cl.bbox, word.bbox, gap)) {
                cl.words.push(word);
                cl.bbox = expandBBox(cl.bbox, word.bbox);
                merged = true;
                break;
            }
        }
        if (!merged) {
            clusters.push({ words: [word], bbox: { ...word.bbox } });
        }
    }
    return clusters;
}

// ── Candidate building ─────────────────────────────────────────────────────
const BOILERPLATE = /^(each|product of|save|sale|limit|while supplies|no rainchecks|#\d{5,}|item\s*#|\d{8,})$/i;

function cleanName(text) {
    return text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !BOILERPLATE.test(line))
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function buildCandidates(words) {
    if (!words.length) return [];
    const priceTokens = detectPriceTokens(words);
    const clusters    = clusterTiles(words);
    const results = [];

    for (const cl of clusters) {
        // Find price tokens whose bbox falls within (or near) this cluster
        const clusterPrices = priceTokens.filter(pt =>
            pt.bbox.x0 >= cl.bbox.x0 - 10 && pt.bbox.x1 <= cl.bbox.x1 + 10 &&
            pt.bbox.y0 >= cl.bbox.y0 - 10 && pt.bbox.y1 <= cl.bbox.y1 + 10
        );
        if (!clusterPrices.length) continue;

        // Use the lowest price in the cluster (handles rollback strike-through style)
        const best = clusterPrices.reduce((a, b) => a.price < b.price ? a : b);

        // Name = all non-price text in cluster
        const priceTexts = new Set(clusterPrices.map(p => p.price.toFixed(2)));
        const nameWords = cl.words.filter(w => {
            const t = w.text.trim();
            return !PRICE_RE.test(t) && !CENTS_RE.test(t) && !DIGITS_RE.test(t) &&
                   !/^\$/.test(t) && t.length > 1;
        });
        const rawName = nameWords.map(w => w.text).join(' ');
        const name = cleanName(rawName);

        if (!name || name.length < 2) continue;

        const minConfidence = Math.min(...cl.words.map(w => w.confidence));
        results.push({
            name,
            price: best.price,
            unit: best.unit,
            frozen: false,
            barcode: '',
            bbox: cl.bbox,
            confidence: minConfidence,
        });
    }

    return results;
}

// ── Review UI ─────────────────────────────────────────────────────────────
function renderReviewUI() {
    renderFlyerOverlay();
    renderCandidateTable();
    updateSubmitBtn();
}

function renderFlyerOverlay() {
    const container = document.getElementById('flyer-image-container');
    container.innerHTML = '';
    container.appendChild(flyerCanvas);

    const overlay = document.createElement('canvas');
    overlay.id = 'flyerOverlay';
    overlay.width  = flyerCanvas.width;
    overlay.height = flyerCanvas.height;
    overlay.style.position = 'absolute';
    overlay.style.top  = '0';
    overlay.style.left = '0';
    overlay.style.cursor = 'crosshair';
    container.style.position = 'relative';
    container.style.display  = 'inline-block';
    container.appendChild(overlay);

    drawBoxes();
    initCropTool(overlay);
}

function drawBoxes(highlightIdx = -1) {
    const overlay = document.getElementById('flyerOverlay');
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    candidates.forEach((c, i) => {
        ctx.strokeStyle = i === highlightIdx ? '#ff6600' : (c.confidence < 60 ? '#ffaa00' : '#00aa44');
        ctx.lineWidth = i === highlightIdx ? 3 : 2;
        ctx.strokeRect(c.bbox.x0, c.bbox.y0, c.bbox.x1 - c.bbox.x0, c.bbox.y1 - c.bbox.y0);
    });
}

function renderCandidateTable() {
    const tbody = document.getElementById('candidateTbody');
    tbody.innerHTML = '';

    if (!candidates.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:16px;color:#888;">No items detected. Use crop-to-add to mark items manually.</td></tr>';
        return;
    }

    candidates.forEach((c, i) => {
        const warn = c.confidence < 60 || c.name.length < 3;
        const tr = document.createElement('tr');
        tr.dataset.idx = i;
        tr.className = warn ? 'candidate-row warn' : 'candidate-row';
        tr.innerHTML = `
            <td>${warn ? '<span class="warn-flag" title="Low confidence">⚠</span>' : ''}</td>
            <td><input class="big-input cand-name" data-idx="${i}" value="${esc(c.name)}" style="width:100%;min-width:160px;font-size:16px;padding:6px 10px"></td>
            <td><input type="number" class="price-input cand-price" data-idx="${i}" value="${c.price.toFixed(2)}" min="0" step="0.01" style="width:90px;font-size:16px;padding:6px 8px"></td>
            <td>
                <select class="big-select cand-unit" data-idx="${i}" style="font-size:16px;padding:6px 8px;width:auto">
                    <option value="each" ${c.unit==='each'?'selected':''}>each</option>
                    <option value="lb"   ${c.unit==='lb'  ?'selected':''}>/ lb</option>
                    <option value="kg"   ${c.unit==='kg'  ?'selected':''}>/ kg</option>
                </select>
            </td>
            <td><input type="checkbox" class="cand-frozen" data-idx="${i}" ${c.frozen?'checked':''}></td>
            <td><input type="text" class="big-input cand-barcode" data-idx="${i}" value="${esc(c.barcode)}" placeholder="optional" style="width:120px;font-size:14px;padding:6px 8px"></td>
            <td><button class="button small-btn danger-btn cand-delete" data-idx="${i}" style="font-size:13px;padding:6px 12px">×</button></td>
        `;
        tbody.appendChild(tr);

        tr.addEventListener('mouseenter', () => drawBoxes(i));
        tr.addEventListener('mouseleave', () => drawBoxes(-1));
    });

    // Live edit sync
    tbody.addEventListener('input', e => {
        const el  = e.target;
        const idx = parseInt(el.dataset.idx);
        if (isNaN(idx) || !candidates[idx]) return;
        if (el.classList.contains('cand-name'))    candidates[idx].name    = el.value;
        if (el.classList.contains('cand-price'))   candidates[idx].price   = parseFloat(el.value) || 0;
        if (el.classList.contains('cand-unit'))    candidates[idx].unit    = el.value;
        if (el.classList.contains('cand-barcode')) candidates[idx].barcode = el.value;
        updateSubmitBtn();
    });
    tbody.addEventListener('change', e => {
        const el  = e.target;
        const idx = parseInt(el.dataset.idx);
        if (isNaN(idx) || !candidates[idx]) return;
        if (el.classList.contains('cand-frozen')) candidates[idx].frozen = el.checked;
    });
    tbody.addEventListener('click', e => {
        const btn = e.target.closest('.cand-delete');
        if (!btn) return;
        const idx = parseInt(btn.dataset.idx);
        candidates.splice(idx, 1);
        renderReviewUI();
    });
}

// ── Crop-to-add tool ───────────────────────────────────────────────────────
function initCropTool(overlay) {
    let drawing = false;
    let rect    = {};

    overlay.addEventListener('mousedown', e => {
        if (!cropActive) return;
        drawing = true;
        const pos = canvasPos(overlay, e);
        rect = { x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
    });

    overlay.addEventListener('mousemove', e => {
        if (!drawing) return;
        const pos = canvasPos(overlay, e);
        rect.x1 = pos.x; rect.y1 = pos.y;
        drawBoxes(-1);
        const ctx = overlay.getContext('2d');
        ctx.strokeStyle = '#0066cc';
        ctx.lineWidth   = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
        ctx.setLineDash([]);
    });

    overlay.addEventListener('mouseup', async e => {
        if (!drawing) return;
        drawing = false;
        if (Math.abs(rect.x1 - rect.x0) < 20 || Math.abs(rect.y1 - rect.y0) < 20) { drawBoxes(); return; }
        drawBoxes(-1);
        await cropRecognize(rect);
    });
}

function canvasPos(canvas, e) {
    const r   = canvas.getBoundingClientRect();
    const scX = canvas.width  / r.width;
    const scY = canvas.height / r.height;
    return { x: (e.clientX - r.left) * scX, y: (e.clientY - r.top) * scY };
}

async function cropRecognize(rect) {
    const x = Math.min(rect.x0, rect.x1);
    const y = Math.min(rect.y0, rect.y1);
    const w = Math.abs(rect.x1 - rect.x0);
    const h = Math.abs(rect.y1 - rect.y0);

    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').drawImage(flyerCanvas, x, y, w, h, 0, 0, w, h);

    const msg = document.getElementById('cropStatusMsg');
    msg.textContent = 'Recognizing crop…';
    try {
        const result = await Tesseract.recognize(tmp, 'eng');
        const words = result.data.words || [];
        // Re-offset bboxes to full-canvas coords
        const shifted = words.map(w => ({
            ...w,
            bbox: { x0: w.bbox.x0+x, y0: w.bbox.y0+y, x1: w.bbox.x1+x, y1: w.bbox.y1+y }
        }));
        const newCands = buildCandidates(shifted);
        if (newCands.length) {
            candidates.push(...newCands);
            renderReviewUI();
            msg.textContent = `Added ${newCands.length} item(s) from crop.`;
        } else {
            msg.textContent = 'No items detected in that area. Try a tighter crop around one item.';
        }
    } catch (e) {
        msg.textContent = 'Crop OCR failed.';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const cropBtn = document.getElementById('cropToggleBtn');
    if (cropBtn) {
        cropBtn.addEventListener('click', () => {
            cropActive = !cropActive;
            cropBtn.textContent = cropActive ? 'Cancel crop' : 'Crop-to-add';
            cropBtn.classList.toggle('active', cropActive);
            const overlay = document.getElementById('flyerOverlay');
            if (overlay) overlay.style.cursor = cropActive ? 'crosshair' : 'default';
        });
    }
});

// ── Submit to Supabase ─────────────────────────────────────────────────────
function updateSubmitBtn() {
    const btn   = document.getElementById('flyerSubmitBtn');
    const count = candidates.filter(c => c.name && c.price > 0).length;
    const user  = window.gpAuthUser;

    if (!user) {
        btn.textContent = 'Sign in to submit';
        btn.disabled = true;
        return;
    }
    if (!count) {
        btn.textContent = 'No valid items to submit';
        btn.disabled = true;
        return;
    }
    btn.textContent = `Submit ${count} item${count===1?'':'s'} to community database`;
    btn.disabled = false;
}

async function submitFlyerPrices() {
    const btn       = document.getElementById('flyerSubmitBtn');
    const statusEl  = document.getElementById('flyerSubmitStatus');
    const chain     = document.getElementById('flyerChainSelect').value;
    const validFrom = document.getElementById('flyerValidFrom').value;
    const validTo   = document.getElementById('flyerValidTo').value;
    const user      = window.gpAuthUser;

    if (!user) { alert('Please sign in first.'); return; }
    if (!validFrom || !validTo) { alert('Please set the flyer validity dates.'); return; }
    if (!chain) { alert('Please select the grocery chain.'); return; }

    const rows = candidates
        .filter(c => c.name && c.name.length >= 2 && c.price > 0)
        .map(c => ({
            user_id:    user.uid,
            region:     'ontario',
            chain,
            item_name:  c.name.trim(),
            barcode:    c.barcode.trim() || null,
            price:      parseFloat(c.price.toFixed(2)),
            unit:       c.unit || 'each',
            frozen:     !!c.frozen,
            valid_from: validFrom,
            valid_to:   validTo,
            created_at: new Date().toISOString(),
        }));

    if (!rows.length) { alert('No valid items to submit.'); return; }

    btn.disabled = true;
    btn.textContent = 'Submitting…';
    statusEl.textContent = '';

    try {
        const db = window.gpDb || (typeof gpDb !== 'undefined' ? gpDb : null);
        if (!db) throw new Error('Firebase not configured.');
        const batch = db.batch();
        for (const row of rows) {
            batch.set(db.collection('flyer_prices').doc(), row);
        }
        await batch.commit();
        statusEl.textContent = `✓ ${rows.length} items submitted. Thank you!`;
        statusEl.className = 'form-msg success';

        // Optionally merge into local catalog
        const addLocal = document.getElementById('addToLocalCatalogCheck')?.checked;
        if (addLocal) mergeIntoLocalCatalog(rows, chain);

        // Refresh deal cache
        if (typeof fetchDealPrices === 'function') await fetchDealPrices();
        if (typeof updateDealsCountBadge === 'function') updateDealsCountBadge();

        candidates = [];
        renderCandidateTable();
        updateSubmitBtn();
    } catch (e) {
        statusEl.textContent = 'Submit failed: ' + (e.message || String(e));
        statusEl.className = 'form-msg error';
    } finally {
        btn.disabled = false;
        updateSubmitBtn();
    }
}

function mergeIntoLocalCatalog(rows, chain) {
    if (typeof catalog === 'undefined') return;
    let changed = false;
    for (const row of rows) {
        const normName = row.item_name.toLowerCase().trim();
        let existing = catalog.find(i =>
            (row.barcode && i.barcode === row.barcode) ||
            i.name.toLowerCase().trim() === normName
        );
        if (existing) {
            if (existing.prices[chain] == null || existing.prices[chain] > row.price) {
                existing.prices[chain] = row.price;
                changed = true;
            }
        } else {
            catalog.push({
                id: typeof uuid === 'function' ? uuid() : crypto.randomUUID(),
                name:     row.item_name,
                category: row.frozen ? 'frozen' : 'pantry',
                barcode:  row.barcode || null,
                frozen:   row.frozen,
                prices:   { metro: null, walmart: null, nofrills: null, freshco: null, [chain]: row.price },
            });
            changed = true;
        }
    }
    if (changed && typeof saveCatalog === 'function') saveCatalog();
}

// ── Deals section badge ────────────────────────────────────────────────────
function updateDealsCountBadge() {
    const el = document.getElementById('dealsCountBadge');
    if (!el || !window.gpDealPrices) return;
    const count = Object.keys(window.gpDealPrices).length;
    el.textContent = count ? `${count} active deal${count===1?'':'s'}` : 'No active deals';
}

// ── Utility ────────────────────────────────────────────────────────────────
function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    showFlyerSection('flyer-upload-area');
    initFlyerUpload();

    document.getElementById('flyerSubmitBtn')?.addEventListener('click', submitFlyerPrices);

    // "Start over" button
    document.getElementById('flyerRestartBtn')?.addEventListener('click', () => {
        candidates = [];
        flyerCanvas = null;
        showFlyerSection('flyer-upload-area');
    });
});
