'use strict';

// ── Flyer import pipeline (GroceryPal v2) ─────────────────────────────────
// Primary: Gemini 2.0 Flash vision API (free tier, user's key stored in localStorage)
// Fallback: copyable prompt for any AI assistant + paste-JSON textarea

const BUILT_IN_GEMINI_KEY = '';
const LS_GEMINI_KEY = 'groceryPal_geminiKey';
// Try models in order; fall back to next on quota errors
const GEMINI_MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

const EXTRACTION_PROMPT = `You are extracting grocery sale prices from a flyer image.

Return ONLY a JSON array (no markdown, no explanation) like this:
[
  { "item_name": "Corn", "price": 0.44, "unit": "each", "pack_count": 1, "unit_volume_ml": null, "unit_weight_g": null, "frozen": false, "barcode": "9479895" },
  { "item_name": "Coca-Cola", "price": 4.29, "unit": "each", "pack_count": 6, "unit_volume_ml": 222, "unit_weight_g": null, "frozen": false, "barcode": null },
  { "item_name": "Chicken breast", "price": 3.98, "unit": "lb", "pack_count": 1, "unit_volume_ml": null, "unit_weight_g": null, "frozen": false, "barcode": null }
]

Rules:
- unit is "each", "lb", or "kg"
- pack_count: number of individual units in the package (e.g. 6 for a 6-pack, 24 for a 24-pack, 1 if sold individually)
- unit_volume_ml: volume of ONE unit in millilitres if it's a drink/liquid (e.g. 355 for a 355mL can), null otherwise
- unit_weight_g: weight of ONE unit in grams if it's a solid sold by weight (e.g. 500 for a 500g bag), null otherwise
- item_name: use the BASE product name only, no size/count suffix (e.g. "Coca-Cola" not "Coca-Cola 6x222mL")
- frozen is true only for items in the freezer section (ice cream, frozen pizza, etc.)
- For rollback/sale items with two prices shown, use the LOWER (sale) price
- barcode is the item number shown (e.g. #9479895 → "9479895"), or null if not shown
- Skip store banners, logos, and promotional text (e.g. "Save on 1000s of items")
- Include every product with a price`;

// State
let flyerFile    = null;   // original File object
let flyerCanvas  = null;   // displayed canvas
let candidates   = [];     // [{name, price, unit, frozen, barcode}]

// ── Gemini key helpers ────────────────────────────────────────────────────
function getGeminiKey() {
    return localStorage.getItem(LS_GEMINI_KEY) || BUILT_IN_GEMINI_KEY;
}

function isKeyConfigured() {
    return !!getGeminiKey();
}

// ── Section visibility ─────────────────────────────────────────────────────
function showFlyerSection(id) {
    ['flyer-upload-area', 'flyer-processing', 'flyer-review-area', 'flyer-fallback'].forEach(s => {
        document.getElementById(s).style.display = s === id ? 'block' : 'none';
    });
}

// ── Image → base64 ────────────────────────────────────────────────────────
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ── Display image for reference ───────────────────────────────────────────
function displayFlyerImage(file) {
    return new Promise(resolve => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const maxW = 700;
            const scale = img.width > maxW ? maxW / img.width : 1;
            flyerCanvas = document.createElement('canvas');
            flyerCanvas.width  = Math.round(img.width  * scale);
            flyerCanvas.height = Math.round(img.height * scale);
            flyerCanvas.getContext('2d').drawImage(img, 0, 0, flyerCanvas.width, flyerCanvas.height);
            resolve();
        };
        img.src = url;
    });
}

// ── Gemini Files API upload (used for PDFs — too large for inline base64) ─
async function uploadToGeminiFiles(file) {
    const key = getGeminiKey();

    // Step 1: initiate resumable upload
    const initResp = await fetch(
        `https://www.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${key}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': file.size,
                'X-Goog-Upload-Header-Content-Type': file.type,
            },
            body: JSON.stringify({ file: { display_name: file.name } }),
        }
    );
    if (!initResp.ok) throw new Error(`Files API init failed: HTTP ${initResp.status}`);
    const sessionUri = initResp.headers.get('X-Goog-Upload-URL');
    if (!sessionUri) throw new Error('No upload session URI returned');

    // Step 2: upload the bytes
    const uploadResp = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
            'Content-Type': file.type,
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': '0',
        },
        body: file,
    });
    if (!uploadResp.ok) throw new Error(`Files API upload failed: HTTP ${uploadResp.status}`);
    const data = await uploadResp.json();
    return data.file.uri;  // e.g. "files/abc123"
}

// ── Gemini API call (tries each model in GEMINI_MODELS until one succeeds) ─
async function callGemini(file) {
    const key  = getGeminiKey();
    const mime = file.type || 'image/jpeg';
    const isPdf = mime === 'application/pdf';

    let filePart;
    if (isPdf) {
        setProcessingStatus('Uploading PDF to Gemini…', true);
        const fileUri = await uploadToGeminiFiles(file);
        filePart = { file_data: { mime_type: 'application/pdf', file_uri: fileUri } };
    } else {
        const b64 = await fileToBase64(file);
        filePart = { inline_data: { mime_type: mime, data: b64 } };
    }

    const body = {
        contents: [{
            parts: [ { text: EXTRACTION_PROMPT }, filePart ]
        }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    };

    let lastErr = '';
    for (const model of GEMINI_MODELS) {
        setProcessingStatus(`Sending to Gemini AI (${model})…`, true);
        const resp = await fetch(`${GEMINI_BASE}${model}:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (resp.status === 429 || resp.status === 403) {
            // quota or permission — try next model
            lastErr = await friendlyGeminiError(resp);
            continue;
        }
        if (!resp.ok) {
            lastErr = await friendlyGeminiError(resp);
            continue;
        }

        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        return JSON.parse(clean);
    }

    throw new Error(lastErr || 'All Gemini models returned errors.');
}

async function friendlyGeminiError(resp) {
    const err = await resp.json().catch(() => ({}));
    const raw = err?.error?.message || `HTTP ${resp.status}`;
    if (raw.includes('Quota exceeded') || resp.status === 429) {
        return 'Gemini free-tier quota exceeded. Add your own API key (free at aistudio.google.com) or use the manual fallback below.';
    }
    if (resp.status === 400 && raw.includes('API_KEY')) {
        return 'Invalid API key. Get a free key at aistudio.google.com/app/apikey — it starts with "AIza".';
    }
    if (resp.status === 403) {
        return 'API key does not have permission to use Gemini. Make sure it was created at aistudio.google.com (not Google Cloud Console).';
    }
    return raw.split('\n')[0]; // first line only — raw errors are very long
}

// ── Validity date detection from full text (kept for manual fallback) ─────
const MONTHS  = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DAYS    = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const ORDINAL = '(?:st|nd|rd|th)?';

function parseValidityRange(text) {
    const dateAtom = `(?:(?:${DAYS}),?\\s+)?(?:${MONTHS})\\s+\\d{1,2}${ORDINAL}`;
    const sep  = `(?:\\s+to\\s+|\\s*[–—-]\\s*)`;
    const year = `(?:,?\\s*(\\d{4}))?`;
    const re   = new RegExp(`(${dateAtom})${sep}(${dateAtom})${year}`, 'i');
    const m    = text.match(re);
    if (!m) return null;
    const yr   = m[3] || new Date().getFullYear().toString();
    const from = parseLooseDate(m[1], yr);
    const to   = parseLooseDate(m[2], yr);
    if (!from || !to) return null;
    return { from, to };
}

function parseLooseDate(str, yr) {
    const mo   = new RegExp(`(${MONTHS})`, 'i').exec(str);
    const dayM = /\d{1,2}/.exec(str);
    if (!mo || !dayM) return null;
    const d = new Date(`${mo[1]} ${dayM[0]}, ${yr}`);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
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

// ── Main entry: upload handler ─────────────────────────────────────────────
function initFlyerUpload() {
    const dropArea  = document.getElementById('flyer-drop-area');
    const fileInput = document.getElementById('flyerFileInput');
    const uploadBtn = document.getElementById('flyerUploadBtn');

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
        if (e.target.files[0]) processFile(e.target.files[0]);
        e.target.value = '';
    });

    // Camera button — shown only on touch devices
    const cameraBtn   = document.getElementById('flyerCameraBtn');
    const cameraInput = document.getElementById('flyerCameraInput');
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        cameraBtn.style.display = 'inline-block';
    }
    cameraBtn.addEventListener('click', () => cameraInput.click());
    cameraInput.addEventListener('change', e => {
        if (e.target.files[0]) processFile(e.target.files[0]);
        e.target.value = '';
    });
    // Clipboard paste (Ctrl+V with an image copied)
    document.addEventListener('paste', e => {
        const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
        if (!item) return;
        const f = item.getAsFile();
        if (f) processFile(f);
    });

    // Use the whole upload section as the drop target so child elements don't block drops
    const dropTarget = document.getElementById('flyer-upload-area');
    dropTarget.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('drag-over'); });
    dropTarget.addEventListener('dragleave', e => {
        // Only remove highlight when leaving the whole area, not a child element
        if (!dropTarget.contains(e.relatedTarget)) dropArea.classList.remove('drag-over');
    });
    dropTarget.addEventListener('drop', e => {
        e.preventDefault();
        dropArea.classList.remove('drag-over');
        const f = e.dataTransfer.files[0];
        if (f && (/^image\//.test(f.type) || f.type === 'application/pdf' || /\.(jpe?g|png|webp|pdf)$/i.test(f.name))) processFile(f);
    });
}

async function processFile(file) {
    flyerFile = file;
    showFlyerSection('flyer-processing');
    setProcessingStatus('Reading flyer…', true);

    await displayFlyerImage(file);

    // Try to detect chain from filename as a hint
    prefillChain(file.name);

    if (!isKeyConfigured()) {
        showFallback('No Gemini API key configured.');
        return;
    }

    setProcessingStatus('Sending to Gemini AI…', true);
    try {
        const items = await callGemini(file);
        if (!Array.isArray(items) || !items.length) throw new Error('No items returned.');

        candidates = items.map(it => {
            const price      = parseFloat(it.price) || 0;
            const packCount  = parseInt(it.pack_count) || 1;
            const volMl      = parseFloat(it.unit_volume_ml) || null;
            const weightG    = parseFloat(it.unit_weight_g) || null;
            const totalMl    = volMl   ? packCount * volMl   : null;
            const totalG     = weightG ? packCount * weightG : null;
            // price per mL or per g — used for cross-size matching
            const unitPriceMl = totalMl ? price / totalMl : null;
            const unitPriceG  = totalG  ? price / totalG  : null;
            return {
                name:         String(it.item_name || '').trim(),
                price,
                unit:         it.unit || 'each',
                frozen:       !!it.frozen,
                barcode:      it.barcode ? String(it.barcode) : '',
                packCount,
                totalMl,
                totalG,
                unitPriceMl,
                unitPriceG,
            };
        });

        setProcessingStatus(`Found ${candidates.length} items.`, false);
        renderReviewUI();
        showFlyerSection('flyer-review-area');
    } catch (e) {
        console.warn('Gemini extraction failed:', e.message);
        showFallback(e.message);
    }
}

function setProcessingStatus(msg, spinner) {
    document.getElementById('processingStatusText').textContent = msg;
    document.getElementById('processingSpinner').style.display = spinner ? 'inline' : 'none';
}

// ── Fallback: copyable prompt ─────────────────────────────────────────────
function showFallback(reason) {
    document.getElementById('fallbackReason').textContent = reason
        ? `(Gemini unavailable: ${reason})`
        : '';

    // Show the flyer image in fallback view too
    const imgContainer = document.getElementById('fallback-image-container');
    imgContainer.innerHTML = '';
    if (flyerCanvas) {
        flyerCanvas.style.maxWidth = '100%';
        imgContainer.appendChild(flyerCanvas);
    }

    // Build the copyable prompt
    const chain = document.getElementById('flyerChainSelect').value;
    const validFrom = document.getElementById('flyerValidFrom').value;
    const validTo   = document.getElementById('flyerValidTo').value;

    const prompt = `${EXTRACTION_PROMPT}

Additional context:
- Chain: ${chain || '(see flyer)'}
${validFrom ? `- Valid from: ${validFrom}` : ''}
${validTo   ? `- Valid to: ${validTo}`   : ''}

Return ONLY the JSON array, nothing else.`;

    document.getElementById('fallbackPromptText').value = prompt;
    showFlyerSection('flyer-fallback');
}

// ── Review UI ─────────────────────────────────────────────────────────────
function renderReviewUI() {
    // Show flyer image alongside table
    const imgContainer = document.getElementById('review-image-container');
    imgContainer.innerHTML = '';
    if (flyerCanvas) {
        flyerCanvas.style.maxWidth = '100%';
        imgContainer.appendChild(flyerCanvas);
    }
    renderCandidateTable();
    updateSubmitBtn();
}

function renderCandidateTable() {
    const tbody = document.getElementById('candidateTbody');
    tbody.innerHTML = '';

    if (!candidates.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:16px;color:#888;">No items. Use "+ Add row" to add items manually.</td></tr>';
        updateSubmitBtn();
        return;
    }

    candidates.forEach((c, i) => {
        const tr = document.createElement('tr');
        tr.className = 'candidate-row';
        tr.innerHTML = `
            <td style="color:#888;font-size:13px;padding:4px 8px">${i + 1}</td>
            <td><input class="big-input cand-name" data-idx="${i}" value="${esc(c.name)}" style="width:100%;min-width:160px;font-size:16px;padding:6px 10px"></td>
            <td><input type="number" class="price-input cand-price" data-idx="${i}" value="${c.price > 0 ? c.price.toFixed(2) : ''}" min="0" step="0.01" placeholder="0.00" style="width:90px;font-size:16px;padding:6px 8px"></td>
            <td>
                <select class="big-select cand-unit" data-idx="${i}" style="font-size:16px;padding:6px 8px;width:auto">
                    <option value="each" ${c.unit==='each'?'selected':''}>each</option>
                    <option value="lb"   ${c.unit==='lb'  ?'selected':''}>/ lb</option>
                    <option value="kg"   ${c.unit==='kg'  ?'selected':''}>/ kg</option>
                </select>
            </td>
            <td style="text-align:center"><input type="checkbox" class="cand-frozen" data-idx="${i}" ${c.frozen?'checked':''}></td>
            <td><input type="text" class="big-input cand-barcode" data-idx="${i}" value="${esc(c.barcode)}" placeholder="optional" style="width:110px;font-size:14px;padding:6px 8px"></td>
            <td><button class="button small-btn danger-btn cand-delete" data-idx="${i}" style="font-size:13px;padding:6px 12px">×</button></td>
        `;
        tbody.appendChild(tr);
    });

    // Live sync
    tbody.addEventListener('input', e => {
        const el = e.target, idx = parseInt(el.dataset.idx);
        if (isNaN(idx) || !candidates[idx]) return;
        if (el.classList.contains('cand-name'))    candidates[idx].name    = el.value;
        if (el.classList.contains('cand-price'))   candidates[idx].price   = parseFloat(el.value) || 0;
        if (el.classList.contains('cand-unit'))    candidates[idx].unit    = el.value;
        if (el.classList.contains('cand-barcode')) candidates[idx].barcode = el.value;
        updateSubmitBtn();
    });
    tbody.addEventListener('change', e => {
        const el = e.target, idx = parseInt(el.dataset.idx);
        if (isNaN(idx) || !candidates[idx]) return;
        if (el.classList.contains('cand-frozen')) candidates[idx].frozen = el.checked;
    });
    tbody.addEventListener('click', e => {
        const btn = e.target.closest('.cand-delete');
        if (!btn) return;
        candidates.splice(parseInt(btn.dataset.idx), 1);
        renderCandidateTable();
        updateSubmitBtn();
    });
}

function addBlankRow() {
    candidates.push({ name: '', price: 0, unit: 'each', frozen: false, barcode: '' });
    renderCandidateTable();
    // Focus the new name input
    const inputs = document.querySelectorAll('.cand-name');
    if (inputs.length) inputs[inputs.length - 1].focus();
}

// ── Submit ─────────────────────────────────────────────────────────────────
function updateSubmitBtn() {
    const btn   = document.getElementById('flyerSubmitBtn');
    if (!btn) return;
    const count = candidates.filter(c => c.name && c.price > 0).length;
    const user  = window.gpAuthUser;
    if (!user) {
        btn.textContent = 'Sign in to submit';
        btn.disabled = true;
    } else if (!count) {
        btn.textContent = 'No valid items to submit';
        btn.disabled = true;
    } else {
        btn.textContent = `Submit ${count} item${count===1?'':'s'} to community database`;
        btn.disabled = false;
    }
}

async function submitFlyerPrices() {
    const btn       = document.getElementById('flyerSubmitBtn');
    const statusEl  = document.getElementById('flyerSubmitStatus');
    const chain     = document.getElementById('flyerChainSelect').value;
    const validFrom = document.getElementById('flyerValidFrom').value;
    const validTo   = document.getElementById('flyerValidTo').value;
    const user      = window.gpAuthUser;

    if (!user)      { alert('Please sign in first.'); return; }
    if (!validFrom || !validTo) { alert('Please set the flyer validity dates.'); return; }
    if (!chain)     { alert('Please select the grocery chain.'); return; }

    const rows = candidates
        .filter(c => c.name && c.name.length >= 2 && c.price > 0)
        .map(c => ({
            user_id:       user.uid,
            region:        'ontario',
            chain,
            item_name:     c.name.trim(),
            barcode:       c.barcode.trim() || null,
            price:         parseFloat(c.price.toFixed(2)),
            unit:          c.unit || 'each',
            frozen:        !!c.frozen,
            pack_count:    c.packCount || 1,
            total_ml:      c.totalMl   || null,
            total_g:       c.totalG    || null,
            unit_price_ml: c.unitPriceMl || null,
            unit_price_g:  c.unitPriceG  || null,
            valid_from:    validFrom,
            valid_to:      validTo,
            created_at:    new Date().toISOString(),
            ttl:           firebase.firestore.Timestamp.fromDate(
                               new Date(new Date(validTo).getTime() + 7 * 24 * 60 * 60 * 1000)
                           ),
        }));

    if (!rows.length) { alert('No valid items to submit.'); return; }

    btn.disabled = true;
    btn.textContent = 'Submitting…';
    statusEl.textContent = '';

    try {
        const db = window.gpDb;
        if (!db) throw new Error('Firebase not configured.');
        const batch = db.batch();
        for (const row of rows) batch.set(db.collection('flyer_prices').doc(), row);
        await batch.commit();

        statusEl.textContent = `✓ ${rows.length} items submitted. Thank you!`;
        statusEl.className = 'form-msg success';

        if (document.getElementById('addToLocalCatalogCheck')?.checked) {
            mergeIntoLocalCatalog(rows, chain);
        }
        if (typeof fetchDealPrices === 'function') await fetchDealPrices();
        if (typeof updateDealsCountBadge === 'function') updateDealsCountBadge();

        const today = new Date().toISOString().slice(0, 10);
        const expiredSnap = await db.collection('flyer_prices').where('valid_to', '<', today).get();
        if (!expiredSnap.empty) {
            const cleanupBatch = db.batch();
            expiredSnap.forEach(doc => cleanupBatch.delete(doc.ref));
            await cleanupBatch.commit();
        }

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
                id:       typeof uuid === 'function' ? uuid() : crypto.randomUUID(),
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

// ── Deals badge ────────────────────────────────────────────────────────────
function updateDealsCountBadge() {
    const el = document.getElementById('dealsCountBadge');
    if (!el || !window.gpDealPrices) return;
    const count = Object.keys(window.gpDealPrices).length;
    el.textContent = count ? `${count} active deal${count===1?'':'s'}` : 'No active deals';
}

// ── Paste-JSON fallback handler ────────────────────────────────────────────
function loadFallbackJson() {
    const raw = document.getElementById('fallbackJsonInput').value.trim();
    const msg = document.getElementById('fallbackJsonMsg');
    if (!raw) { msg.textContent = 'Paste the JSON from your AI assistant first.'; msg.className='form-msg error'; return; }
    let items;
    try {
        items = JSON.parse(raw);
        if (!Array.isArray(items)) throw new Error('Expected a JSON array');
    } catch (e) {
        msg.textContent = 'Invalid JSON: ' + e.message;
        msg.className = 'form-msg error';
        return;
    }
    candidates = items.map(it => {
        const price     = parseFloat(it.price) || 0;
        const packCount = parseInt(it.pack_count) || 1;
        const volMl     = parseFloat(it.unit_volume_ml) || null;
        const weightG   = parseFloat(it.unit_weight_g) || null;
        const totalMl   = volMl   ? packCount * volMl   : null;
        const totalG    = weightG ? packCount * weightG : null;
        return {
            name:         String(it.item_name || '').trim(),
            price,
            unit:         it.unit || 'each',
            frozen:       !!it.frozen,
            barcode:      it.barcode ? String(it.barcode) : '',
            packCount,
            totalMl,
            totalG,
            unitPriceMl:  totalMl ? price / totalMl : null,
            unitPriceG:   totalG  ? price / totalG  : null,
        };
    }).filter(c => c.name);

    if (!candidates.length) { msg.textContent = 'No valid items found in that JSON.'; msg.className='form-msg error'; return; }
    msg.textContent = '';
    renderReviewUI();
    showFlyerSection('flyer-review-area');
}

// ── Utility ────────────────────────────────────────────────────────────────
function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Gemini key settings ────────────────────────────────────────────────────
function openGeminiKeyModal() {
    document.getElementById('geminiKeyInput').value = localStorage.getItem(LS_GEMINI_KEY) || '';
    document.getElementById('geminiKeyModal').style.display = 'flex';
}
function closeGeminiKeyModal() {
    document.getElementById('geminiKeyModal').style.display = 'none';
}
function saveGeminiKey() {
    const val = document.getElementById('geminiKeyInput').value.trim();
    if (val) localStorage.setItem(LS_GEMINI_KEY, val);
    else localStorage.removeItem(LS_GEMINI_KEY);
    closeGeminiKeyModal();
    document.getElementById('geminiKeyStatus').textContent = val ? '✓ API key saved' : 'No API key — flyer import will use manual fallback';
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    showFlyerSection('flyer-upload-area');
    initFlyerUpload();


    document.getElementById('flyerSubmitBtn')?.addEventListener('click', submitFlyerPrices);
    document.getElementById('flyerRestartBtn')?.addEventListener('click', () => {
        candidates = []; flyerFile = null; flyerCanvas = null;
        showFlyerSection('flyer-upload-area');
    });
    document.getElementById('addCandidateRowBtn')?.addEventListener('click', addBlankRow);

    // Fallback
    document.getElementById('copyPromptBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(document.getElementById('fallbackPromptText').value)
            .then(() => { document.getElementById('copyPromptBtn').textContent = '✓ Copied!'; setTimeout(() => { document.getElementById('copyPromptBtn').textContent = 'Copy prompt'; }, 2000); });
    });
    document.getElementById('loadFallbackJsonBtn')?.addEventListener('click', loadFallbackJson);
    document.getElementById('fallbackRestartBtn')?.addEventListener('click', () => {
        candidates = []; flyerFile = null; flyerCanvas = null;
        showFlyerSection('flyer-upload-area');
    });

    // Gemini key
    document.getElementById('geminiKeyBtn')?.addEventListener('click', openGeminiKeyModal);
    document.getElementById('saveGeminiKeyBtn')?.addEventListener('click', saveGeminiKey);
    document.getElementById('cancelGeminiKeyBtn')?.addEventListener('click', closeGeminiKeyModal);

    document.getElementById('geminiKeyStatus').textContent = isKeyConfigured()
        ? '✓ API key saved'
        : 'No API key — add one to use Gemini (free at aistudio.google.com)';
});
