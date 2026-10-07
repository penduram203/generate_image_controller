import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ===== 定数 =====
const MODULE_NAME      = 'generate_image_controller';
const BUTTON_ID        = 'gic-release-override-button';
const GALLERY_BUTTON_ID = 'gic-open-gallery-button';
const LABEL_OVERRIDE   = '背景生成';
const LABEL_NORMAL     = '事前設定';
const HIDE_CLASS       = 'gic-hidden-by-text-styling';
const HIDDEN_MES_CLASS = 'gic-hidden-message';

// ===== ギャラリー配置カスタマイズ用定数 =====

const GALLERY_WINDOW_SELECTORS = [
    '#gallery',
];

const GALLERY_PREVIEW_SELECTORS = [
    '.galleryImageDraggable',
    '#gallery .galleryImageDraggable',
];

const GALLERY_PREVIEW_MARGIN_X = 0;
const GALLERY_PREVIEW_MARGIN_Y = 0;

const GALLERY_PREVIEW_SCALE_MULTIPLIER = 1.0;
const GALLERY_PREVIEW_MAX_WIDTH = 1440;
const GALLERY_PREVIEW_CLOSE_SCALE = 2.5;

const GALLERY_WINDOW_HEIGHT_DELTA = 600;
const GALLERY_WINDOW_MAX_VIEWPORT_MARGIN = 20;
const GALLERY_PAGINATION_HEIGHT = 40;

/**
 * 起動後、ギャラリーのウォームアップを開始するまでの待機時間(ms)。
 * ST 本体や他拡張の初期化が終わった頃に実行する。
 */
const GALLERY_WARMUP_DELAY_MS = 2000;

/**
 * ウォームアップでギャラリーを開いておく時間(ms)。
 * この間に画像の読み込み・キャッシュが進む。
 */
const GALLERY_WARMUP_HOLD_MS = 6000;

// ===== 状態 =====
let lastGeneratedImageUrl = null;
let isOverrideLocal = false;
const processedMessageKeys = new Set();

let currentPreviewEl = null;
let isApplyingLayout = false;

const galleryBaseHeightCache = new WeakMap();

let _galleryOpenCache = { value: false, timestamp: 0 };
const GALLERY_OPEN_CACHE_TTL = 100;

// ===== ウォームアップ状態管理 =====
// 'idle'      : 未実行
// 'running'   : 実行中
// 'done'      : 完了
// 'aborted'   : ユーザー操作により中断
let warmupState = 'idle';

// ===== 永続化ヘルパー =====
function loadPersistedState() {
    try {
        const ctx = getContext();
        const st = ctx?.extensionSettings?.[MODULE_NAME];
        if (!st) return;
        if (typeof st.isOverrideLocal === 'boolean') isOverrideLocal = st.isOverrideLocal;
        if (typeof st.lastGeneratedImageUrl === 'string') lastGeneratedImageUrl = st.lastGeneratedImageUrl;
        console.log(`[GIC] 永続状態を復元: isOverrideLocal=${isOverrideLocal}, lastUrl=${lastGeneratedImageUrl}`);
    } catch (e) {
        console.warn('[GIC] 永続状態の読込に失敗:', e);
    }
}

function savePersistedState() {
    try {
        const ctx = getContext();
        if (!ctx) return;
        if (!ctx.extensionSettings[MODULE_NAME]) ctx.extensionSettings[MODULE_NAME] = {};
        ctx.extensionSettings[MODULE_NAME].isOverrideLocal = isOverrideLocal;
        ctx.extensionSettings[MODULE_NAME].lastGeneratedImageUrl = lastGeneratedImageUrl;
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    } catch (e) {
        console.warn('[GIC] 永続状態の保存に失敗:', e);
    }
}

// ===== スタイル注入 =====
(function injectGicStyle() {
    if (document.getElementById('gic-injected-style')) return;
    const style = document.createElement('style');
    style.id = 'gic-injected-style';
    style.textContent = `
        #${BUTTON_ID}.${HIDE_CLASS} {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
})();

(function injectGalleryLayoutStyle() {
    if (document.getElementById('gic-gallery-layout-style')) return;
    const style = document.createElement('style');
    style.id = 'gic-gallery-layout-style';

    const previewSel = GALLERY_PREVIEW_SELECTORS.join(', ');

    style.textContent = `
        ${previewSel} {
            position: fixed !important;
            top: 50% !important;
            left: 0 !important;
            right: auto !important;
            bottom: auto !important;
            transform: translateY(-50%) !important;
            transform-origin: left center !important;
            margin: 0 !important;
            visibility: hidden !important;
        }

        ${previewSel} .dragClose {
            transform: scale(${GALLERY_PREVIEW_CLOSE_SCALE}) !important;
            transform-origin: top right !important;
            display: inline-block !important;
        }

        .nGY2GalleryBottom {
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
        }
        .nGY2paginationRectangle,
        .nGY2paginationRectangleCurrentPage {
            height: ${GALLERY_PAGINATION_HEIGHT}px !important;
            min-height: ${GALLERY_PAGINATION_HEIGHT}px !important;
            max-height: ${GALLERY_PAGINATION_HEIGHT}px !important;
            position: relative !important;
        }

        .gic-page-number {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            font-weight: bold !important;
            font-size: 16px !important;
            color: #000000 !important;
            -webkit-text-stroke: 3px #ffffff !important;
            paint-order: stroke fill !important;
            pointer-events: none !important;
            z-index: 10 !important;
            line-height: 1 !important;
            user-select: none !important;
            font-family: sans-serif !important;
        }

        /* ギャラリー上部の"Drag and drop images..."メッセージを非表示 */
        .nGY2GalleryTop,
        .nGY2GalleryHeader {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
    console.log('[GIC] 🖼️ ギャラリー配置CSSを注入しました');
})();

// ===== ユーティリティ =====

function isGeneratedImageMessage(message) {
    return Array.isArray(message?.extra?.media) &&
           message.extra.media.some(m => m.source === 'generated');
}

function extractImageUrl(message) {
    if (!Array.isArray(message?.extra?.media)) return null;
    const media = message.extra.media.find(m => m.source === 'generated');
    return media?.url || null;
}

function getMessageKey(message) {
    if (message?.send_date) return message.send_date;
    return `${message?.name || 'unknown'}_${(message?.mes || '').slice(0, 80)}`;
}

function setButtonLabel(label) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    if (btn.textContent !== label) {
        btn.textContent = label;
        console.log(`[GIC] ラベル設定: ${label}`);
        requestAnimationFrame(positionGalleryButton);
    }
}

// ===== DOMマーキング =====

function markGeneratedMessagesInDom() {
    const context = getContext();
    if (!context?.chat) return;
    for (let i = 0; i < context.chat.length; i++) {
        const msg = context.chat[i];
        if (!isGeneratedImageMessage(msg)) continue;
        const el = document.querySelector(`.mes[mesid="${i}"]`);
        if (el && !el.classList.contains(HIDDEN_MES_CLASS)) {
            el.classList.add(HIDDEN_MES_CLASS);
        }
    }
}

// ===== Text_stylingパネル開閉監視 =====

function isTextStylingPanelOpen() {
    const panel = document.getElementById('text-styling-panel');
    if (!panel) return false;
    if (panel.classList.contains('hidden')) return false;
    const cs = getComputedStyle(panel);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
}

let lastTextStylingState = null;

function syncButtonVisibilityForTextStyling() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    const isOpen = isTextStylingPanelOpen();
    if (isOpen === lastTextStylingState) return;
    lastTextStylingState = isOpen;

    if (isOpen) {
        btn.classList.add(HIDE_CLASS);
        console.log('[GIC] 📝 Text_stylingパネル表示中 → GICボタンを非表示');
    } else {
        btn.classList.remove(HIDE_CLASS);
        console.log('[GIC] 📝 Text_stylingパネル閉じた → GICボタンを再表示');
    }
}

function setupTextStylingObserver() {
    setInterval(syncButtonVisibilityForTextStyling, 300);
    console.log('[GIC] 📝 Text_stylingパネル監視を開始しました（ポーリング方式）');
}

// ===== 生成画像のスキャン =====

async function scanForGeneratedImages() {
    const context = getContext();
    if (!context?.chat) return;

    let newest = null;
    let newestIdx = -1;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (isGeneratedImageMessage(context.chat[i])) {
            newest = context.chat[i];
            newestIdx = i;
            break;
        }
    }
    if (!newest) {
        markGeneratedMessagesInDom();
        return;
    }

    const url = extractImageUrl(newest);
    if (!url) {
        markGeneratedMessagesInDom();
        return;
    }

    const key = getMessageKey(newest);
    const alreadyProcessed = processedMessageKeys.has(key);

    lastGeneratedImageUrl = url;

    if (!alreadyProcessed) {
        processedMessageKeys.add(key);

        if (!newest.is_system) {
            newest.is_system = true;
            try {
                await saveChat();
                printMessages();
            } catch (e) {
                console.error('[GIC] saveChat/printMessages エラー:', e);
            }
        }

        if (window.ImageDisplayExtension?.setOverrideImage) {
            try {
                await window.ImageDisplayExtension.setOverrideImage(url);
                isOverrideLocal = true;
                setButtonLabel(LABEL_OVERRIDE);
                savePersistedState();
                console.log(`[GIC] 🖼️ 最新の生成画像を背景に設定: ${url}`);
            } catch (e) {
                console.error('[GIC] ImageDisplayExtension エラー:', e);
            }
        }
    } else {
        if (!isOverrideLocal) {
            const ideIsOverride = window.ImageDisplayExtension?.isOverride?.();
            if (ideIsOverride) {
                isOverrideLocal = true;
                setButtonLabel(LABEL_OVERRIDE);
                savePersistedState();
            } else if (newest.is_system) {
                if (window.ImageDisplayExtension?.setOverrideImage) {
                    try {
                        await window.ImageDisplayExtension.setOverrideImage(url);
                        isOverrideLocal = true;
                        setButtonLabel(LABEL_OVERRIDE);
                        savePersistedState();
                        console.log(`[GIC] 🔄 リロード後のoverride状態を復元: ${url}`);
                    } catch (e) {
                        console.error('[GIC] override復元エラー:', e);
                    }
                }
            }
        }
    }

    for (let i = 0; i < newestIdx; i++) {
        const msg = context.chat[i];
        if (isGeneratedImageMessage(msg)) {
            processedMessageKeys.add(getMessageKey(msg));
        }
    }

    markGeneratedMessagesInDom();
}

// ===== ボタンのアクション =====

function handleButtonAction() {
    console.log(`[GIC] ボタンアクション: 現在=${isOverrideLocal ? '背景生成' : '事前設定'}, lastUrl=${lastGeneratedImageUrl}`);

    if (isOverrideLocal) {
        if (window.ImageDisplayExtension?.clearOverrideImage) {
            try {
                window.ImageDisplayExtension.clearOverrideImage();
                console.log('[GIC] clearOverrideImage() 成功');
            } catch (err) {
                console.error('[GIC] clearOverrideImage エラー:', err);
            }
        }
        isOverrideLocal = false;
        setButtonLabel(LABEL_NORMAL);
    } else {
        if (lastGeneratedImageUrl && window.ImageDisplayExtension?.setOverrideImage) {
            try {
                window.ImageDisplayExtension.setOverrideImage(lastGeneratedImageUrl);
                console.log(`[GIC] setOverrideImage() 成功: ${lastGeneratedImageUrl}`);
            } catch (err) {
                console.error('[GIC] setOverrideImage エラー:', err);
            }
        } else if (!lastGeneratedImageUrl) {
            console.warn('[GIC] 生成画像がまだありません（ラベルのみ切り替えます）');
        }
        isOverrideLocal = true;
        setButtonLabel(LABEL_OVERRIDE);
    }
    savePersistedState();
}

// ===== ギャラリーボタンの位置制御 =====

function positionGalleryButton() {
    const gicBtn = document.getElementById(BUTTON_ID);
    const galleryBtn = document.getElementById(GALLERY_BUTTON_ID);
    if (!gicBtn || !galleryBtn) return;
    const w = gicBtn.offsetWidth;
    if (!w) return;
    galleryBtn.style.left = (w + 4) + 'px';
}

// ===== 公式ギャラリーの開閉検知（キャッシュ付き） =====

function isGalleryOpen() {
    const now = performance.now();
    if (now - _galleryOpenCache.timestamp < GALLERY_OPEN_CACHE_TTL) {
        return _galleryOpenCache.value;
    }

    let result = false;

    const primary = document.getElementById('gallery');
    if (primary) {
        const style = window.getComputedStyle(primary);
        if (style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) !== 0) {
            const rect = primary.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                result = true;
            }
        }
    }

    if (!result) {
        const candidates = document.querySelectorAll([
            '#gallery_container',
            '.gallery-container',
            '.gallery_container',
            '.gallery',
            '[data-gallery-container]',
            '.gallery-grid',
            '#gallery-grid',
        ].join(','));
        for (const el of candidates) {
            if (!el) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none') continue;
            if (style.visibility === 'hidden') continue;
            if (parseFloat(style.opacity) === 0) continue;
            if (el.offsetParent === null && style.position !== 'fixed') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            result = true;
            break;
        }
    }

    _galleryOpenCache = { value: result, timestamp: now };
    return result;
}

// ===== ギャラリー配置・プレビュー制御 =====

function getAllPreviews() {
    const selector = GALLERY_PREVIEW_SELECTORS.join(', ');
    return Array.from(document.querySelectorAll(selector));
}

function closePreviewElement(el) {
    if (!el || !el.parentNode) return;
    const closeBtn = el.querySelector('.dragClose');
    if (closeBtn && typeof closeBtn.click === 'function') {
        try {
            closeBtn.click();
            return;
        } catch (e) {
            // フォールバックへ
        }
    }
    try { el.remove(); } catch (e) { /* ignore */ }
}

function closeAllPreviews() {
    const previews = getAllPreviews();
    if (previews.length === 0) {
        currentPreviewEl = null;
        return;
    }
    for (const el of previews) {
        closePreviewElement(el);
    }
    currentPreviewEl = null;
    console.log(`[GIC] ギャラリーが閉じたため ${previews.length} 個のプレビューを閉じました`);
}

/**
 * ギャラリーの上部に表示される"Drag and drop images..."メッセージを非表示にする。
 * CSSで .nGY2GalleryTop を消しているが、ST のバージョンによっては別要素のため
 * テキストマッチによるフォールバックも行う。
 */
function hideGalleryUploadMessage() {
    const messages = [
        'Drag and drop images onto the gallery',
        'Images can also be found in the folder',
    ];

    // 既知のクラスを最優先で非表示
    document.querySelectorAll('.nGY2GalleryTop, .nGY2GalleryHeader').forEach(el => {
        el.style.setProperty('display', 'none', 'important');
    });

    // テキストマッチによるフォールバック
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
    );

    const toHide = new Set();
    let node;
    while ((node = walker.nextNode())) {
        const t = node.textContent || '';
        let matched = false;
        for (const msg of messages) {
            if (t.includes(msg)) { matched = true; break; }
        }
        if (!matched) continue;

        // 最小の祖先で、テキスト長が短いものを選ぶ
        let el = node.parentElement;
        let candidate = null;
        while (el && el !== document.body) {
            const text = el.textContent || '';
            if (text.length > 300) break;
            candidate = el;
            el = el.parentElement;
        }
        if (candidate) toHide.add(candidate);
    }

    toHide.forEach(el => {
        if (getComputedStyle(el).display !== 'none') {
            el.style.setProperty('display', 'none', 'important');
        }
    });
}

function applyGalleryWindowLayout() {
    for (const sel of GALLERY_WINDOW_SELECTORS) {
        const el = document.querySelector(sel);
        if (!el) continue;

        el.style.setProperty('position', 'fixed', 'important');
        el.style.setProperty('top', '50%', 'important');
        el.style.setProperty('left', '0', 'important');
        el.style.setProperty('right', 'auto', 'important');
        el.style.setProperty('bottom', 'auto', 'important');
        el.style.setProperty('transform', 'translateY(-50%)', 'important');
        el.style.setProperty('margin', '0', 'important');

        if (!galleryBaseHeightCache.has(el)) {
            const h = el.getBoundingClientRect().height;
            if (h > 0) {
                galleryBaseHeightCache.set(el, h);
            } else {
                continue;
            }
        }

        const base = galleryBaseHeightCache.get(el);
        const desired = Math.round(base + GALLERY_WINDOW_HEIGHT_DELTA);

        const vh = window.innerHeight;
        const maxAllowed = Math.max(100, vh - GALLERY_WINDOW_MAX_VIEWPORT_MARGIN * 2);
        const targetH = Math.min(desired, maxAllowed);

        if (el.dataset.gicHeightLogged !== 'true') {
            el.dataset.gicHeightLogged = 'true';
            console.log(`[GIC] ギャラリー高さ: ST本来=${Math.round(base)}px, 希望=${desired}px, 適用=${targetH}px (上限=${maxAllowed}px)`);
        }

        el.style.setProperty('height', targetH + 'px', 'important');
        el.style.setProperty('min-height', targetH + 'px', 'important');
        el.style.setProperty('max-height', targetH + 'px', 'important');
    }
}

function resetGalleryHeightCache() {
    for (const sel of GALLERY_WINDOW_SELECTORS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (galleryBaseHeightCache.has(el)) {
            galleryBaseHeightCache.delete(el);
            console.log('[GIC] ギャラリー高さキャッシュをリセット');
        }
        if (el.dataset.gicHeightLogged) {
            delete el.dataset.gicHeightLogged;
        }
    }
}

function applyPageNumbers() {
    const container = document.querySelector('.nGY2GalleryBottom');
    if (!container) return;

    const dots = Array.from(container.querySelectorAll(
        '.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage'
    ));

    let visibleIndex = 0;
    dots.forEach(dot => {
        const existing = dot.querySelector('.gic-page-number');
        const cs = getComputedStyle(dot);
        const visible = cs.display !== 'none' &&
                        cs.visibility !== 'hidden' &&
                        parseFloat(cs.opacity) !== 0;

        if (visible) {
            visibleIndex++;
            const expected = String(visibleIndex);
            if (existing) {
                if (existing.textContent !== expected) {
                    existing.textContent = expected;
                }
            } else {
                const span = document.createElement('span');
                span.className = 'gic-page-number';
                span.textContent = expected;
                dot.appendChild(span);
            }
        } else {
            if (existing) existing.remove();
        }
    });
}

function fitPreviewToViewport(panel) {
    if (!panel) return;

    const img = panel.querySelector('img');
    const header = panel.querySelector('.panelControlBar');
    if (!img) return;

    const closeBtn = panel.querySelector('.dragClose');
    if (closeBtn) {
        closeBtn.style.setProperty('transform', `scale(${GALLERY_PREVIEW_CLOSE_SCALE})`, 'important');
        closeBtn.style.setProperty('transform-origin', 'top right', 'important');
        closeBtn.style.setProperty('display', 'inline-block', 'important');
    }

    if (header) {
        header.style.setProperty('flex', '0 0 auto', 'important');
    }

    const applySize = () => {
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        if (!nw || !nh) return;

        const galleryEl = document.getElementById('gallery');
        let galleryRight = 0;
        if (galleryEl) {
            const gr = galleryEl.getBoundingClientRect();
            galleryRight = Math.round(gr.right);
        }

        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const availableW = Math.max(100, vw - galleryRight - GALLERY_PREVIEW_MARGIN_X);
        const availableH = Math.max(100, vh - GALLERY_PREVIEW_MARGIN_Y * 2);

        const fitScale = Math.min(availableW / nw, availableH / nh);
        const desiredScale = fitScale * GALLERY_PREVIEW_SCALE_MULTIPLIER;

        const maxScaleByWidth = GALLERY_PREVIEW_MAX_WIDTH / nw;

        const finalScale = Math.min(desiredScale, maxScaleByWidth);

        const finalW = Math.max(1, Math.floor(nw * finalScale));
        const finalH = Math.max(1, Math.floor(nh * finalScale));

        panel.style.setProperty('position', 'fixed', 'important');
        panel.style.setProperty('left', galleryRight + 'px', 'important');
        panel.style.setProperty('top', '50%', 'important');
        panel.style.setProperty('right', 'auto', 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
        panel.style.setProperty('transform', 'translateY(-50%)', 'important');
        panel.style.setProperty('transform-origin', 'left center', 'important');
        panel.style.setProperty('margin', '0', 'important');
        panel.style.setProperty('padding', '0', 'important');
        panel.style.setProperty('box-sizing', 'border-box', 'important');
        panel.style.setProperty('overflow', 'visible', 'important');
        panel.style.setProperty('display', 'flex', 'important');
        panel.style.setProperty('flex-direction', 'column', 'important');
        panel.style.setProperty('width', finalW + 'px', 'important');
        panel.style.setProperty('height', 'auto', 'important');
        panel.style.setProperty('max-width', 'none', 'important');
        panel.style.setProperty('max-height', 'none', 'important');

        img.style.setProperty('width', finalW + 'px', 'important');
        img.style.setProperty('height', finalH + 'px', 'important');
        img.style.setProperty('max-width', 'none', 'important');
        img.style.setProperty('max-height', 'none', 'important');
        img.style.setProperty('object-fit', 'contain', 'important');
        img.style.setProperty('display', 'block', 'important');
        img.style.setProperty('flex', '0 0 auto', 'important');

        panel.style.setProperty('visibility', 'visible', 'important');
    };

    if (img.complete && img.naturalWidth) {
        applySize();
    } else {
        if (img.dataset.gicFitBound !== 'true') {
            img.dataset.gicFitBound = 'true';
            img.addEventListener('load', () => {
                if (document.body.contains(panel)) {
                    fitPreviewToViewport(panel);
                }
            });
        }
    }
}

function applyGalleryLayout() {
    if (isApplyingLayout) return;
    isApplyingLayout = true;
    try {
        if (!isGalleryOpen()) {
            closeAllPreviews();
            return;
        }

        applyGalleryWindowLayout();

        document.querySelectorAll(
            '.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage'
        ).forEach(el => {
            el.style.setProperty('height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('min-height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('max-height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('position', 'relative', 'important');
        });

        applyPageNumbers();

        // アップロードメッセージを非表示
        hideGalleryUploadMessage();

        const previews = getAllPreviews();
        if (previews.length === 0) {
            currentPreviewEl = null;
            return;
        }

        const latest = previews[previews.length - 1];
        if (latest !== currentPreviewEl) {
            for (const el of previews) {
                if (el === latest) continue;
                closePreviewElement(el);
            }
            currentPreviewEl = latest;
        }

        fitPreviewToViewport(latest);
    } finally {
        setTimeout(() => { isApplyingLayout = false; }, 0);
    }
}

let lastGalleryStateForGic = null;

function syncGalleryButtonVisibility() {
    const galleryOpen = isGalleryOpen();
    if (galleryOpen === lastGalleryStateForGic) return;
    lastGalleryStateForGic = galleryOpen;

    const btn = document.getElementById(GALLERY_BUTTON_ID);
    if (btn) {
        if (galleryOpen) {
            btn.style.setProperty('display', 'none', 'important');
            console.log('[GIC] 📷 ギャラリー表示中 → ギャラリーボタンを非表示');
        } else {
            btn.style.removeProperty('display');
            console.log('[GIC] 📷 ギャラリー非表示 → ギャラリーボタンを再表示');
        }
    }

    if (galleryOpen) {
        applyGalleryLayout();
    } else {
        resetGalleryHeightCache();
        closeAllPreviews();
    }
}

function setupGalleryObserverForGic() {
    setInterval(() => {
        syncGalleryButtonVisibility();
        applyGalleryLayout();
    }, 300);

    syncGalleryButtonVisibility();
    applyGalleryLayout();
}

// ===== 公式ギャラリーを開く =====

function openGalleryFromGic() {
    try {
        const ctx = getContext();
        if (ctx && typeof ctx.openGallery === 'function') {
            ctx.openGallery();
            console.log('[GIC] ギャラリーを開きました (ctx.openGallery)');
            return true;
        }
    } catch (e) { /* ignore */ }

    const directSelectors = [
        '#gallery_button',
        '#gallery-button',
        '#open-gallery-button',
        '.gallery-button',
        '.open-gallery',
    ];
    for (const sel of directSelectors) {
        const el = document.querySelector(sel);
        if (el && typeof el.click === 'function') {
            el.click();
            console.log(`[GIC] ギャラリーを開きました (selector: ${sel})`);
            return true;
        }
    }

    const menu = document.querySelector('#extensionsMenu');
    if (menu) {
        const items = menu.querySelectorAll('a, button, .list-group-item, [role="menuitem"]');
        for (const item of items) {
            const text = (item.textContent || '').trim().toLowerCase();
            if (text === 'gallery' || text === 'ギャラリー' ||
                text.includes('gallery') || text.includes('ギャラリー')) {
                item.click();
                console.log('[GIC] ギャラリーを開きました (extensionsMenu 経由)');
                return true;
            }
        }
    }

    const allClickable = document.querySelectorAll('button, a');
    for (const el of allClickable) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text === 'gallery' || text === 'ギャラリー') {
            el.click();
            console.log('[GIC] ギャラリーを開きました (全体検索)');
            return true;
        }
    }

    console.warn('[GIC] ギャラリーを開くためのボタン/APIが見つかりませんでした');
    return false;
}

// ===== 公式ギャラリーを閉じる（プログラム的） =====

function closeGalleryProgrammatically() {
    // 方法1: #gallery 内の閉じるボタン
    const g = document.getElementById('gallery');
    if (g) {
        const closeBtn = g.querySelector(':scope > .dragClose') ||
                         g.querySelector(':scope > .panelControlBar .dragClose') ||
                         g.querySelector('.dragClose');
        if (closeBtn && typeof closeBtn.click === 'function') {
            try {
                closeBtn.click();
                console.log('[GIC] ギャラリーを閉じました (dragClose)');
                return true;
            } catch (e) { /* fallthrough */ }
        }
    }

    // 方法2: Escape キー
    try {
        const esc = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
        });
        document.dispatchEvent(esc);
        console.log('[GIC] ギャラリーを閉じました (Escape)');
        return true;
    } catch (e) {
        console.warn('[GIC] ギャラリーを閉じるのに失敗:', e);
        return false;
    }
}

// ===== ギャラリーのウォームアップ =====

/**
 * 起動時にギャラリーを1度だけ開いて画像を読み込ませる。
 * これにより、ユーザーが初めてギャラリーを開く時の遅延を解消する。
 * ユーザーが先に操作した場合は中断する。
 */
async function warmUpGallery() {
    if (warmupState !== 'idle') return;
    if (isGalleryOpen()) {
        // 既に何らかの理由で開いているなら何もしない
        warmupState = 'done';
        return;
    }

    warmupState = 'running';
    console.log('[GIC] 🔥 ギャラリーのウォームアップを開始します');

    // ウォームアップ中はギャラリーを完全に隠す
    const hideStyle = document.createElement('style');
    hideStyle.id = 'gic-gallery-warmup-hide';
    hideStyle.textContent = `
        #gallery,
        .nGY2Gallery,
        .nGY2GalleryTop,
        .nGY2GalleryBottom,
        [forchar="gallery"] {
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
    `;
    document.head.appendChild(hideStyle);

    const startTime = Date.now();

    try {
        const opened = openGalleryFromGic();
        if (!opened) {
            console.warn('[GIC] 🔥 ウォームアップ: ギャラリーを開けませんでした');
            warmupState = 'idle';
            hideStyle.remove();
            return;
        }

        // GALLERY_WARMUP_HOLD_MS の間、ギャラリーを開いたままにする
        await new Promise(r => setTimeout(r, GALLERY_WARMUP_HOLD_MS));

        // ユーザーに中断されていたら何もしない
        if (warmupState === 'aborted') {
            console.log('[GIC] 🔥 ウォームアップはユーザー操作により中断されました');
            hideStyle.remove();
            return;
        }

        // ギャラリーを閉じる
        closeGalleryProgrammatically();

        // 少し待ってから非表示スタイルを解除
        setTimeout(() => {
            hideStyle.remove();
        }, 500);

        warmupState = 'done';
        console.log(`[GIC] 🔥 ウォームアップ完了 (${Date.now() - startTime}ms)`);
    } catch (e) {
        console.warn('[GIC] 🔥 ウォームアップ中にエラー:', e);
        warmupState = 'idle';
        try { hideStyle.remove(); } catch (_) {}
    }
}

// ===== GICボタン（事前設定 / 背景生成）の生成 =====

function createReleaseButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = '強制表示モード（背景生成）と通常モード（事前設定）を切り替える';
    btn.textContent = isOverrideLocal ? LABEL_OVERRIDE : LABEL_NORMAL;

    Object.assign(btn.style, {
        position: 'fixed',
        left: '0',
        bottom: 'calc(10% - 10px)',
        zIndex: '15000',
        padding: '6px 12px',
        fontSize: '12px',
        color: '#ffffff',
        backgroundColor: '#444',
        border: '1px solid #666',
        borderLeft: 'none',
        borderTopRightRadius: '6px',
        borderBottomRightRadius: '6px',
        cursor: 'pointer',
        opacity: '0.12',
        transition: 'opacity 0.15s ease, background-color 0.15s ease',
        userSelect: 'none',
        outline: 'none',
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',
        touchAction: 'manipulation',
    });

    btn.addEventListener('mouseenter', () => {
        btn.style.opacity = '1';
        btn.style.backgroundColor = '#666';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.opacity = '0.12';
        btn.style.backgroundColor = '#444';
    });

    let flashTimer = null;
    const flashBlue = () => {
        if (flashTimer) clearTimeout(flashTimer);
        btn.style.backgroundColor = '#0a84ff';
        btn.style.opacity = '1';
        flashTimer = setTimeout(() => {
            const hovering = btn.matches(':hover');
            btn.style.backgroundColor = hovering ? '#666' : '#444';
            btn.style.opacity = hovering ? '1' : '0.12';
            flashTimer = null;
        }, 250);
    };

    let lastActionTime = 0;
    const triggerAction = (source) => {
        const now = Date.now();
        if (now - lastActionTime < 200) return;
        lastActionTime = now;
        console.log(`[GIC] トリガー: ${source}`);
        flashBlue();
        handleButtonAction();
    };

    btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        triggerAction('pointerdown');
    }, true);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        triggerAction('click');
    }, true);

    document.body.appendChild(btn);
    console.log('[GIC] ✅ ボタンを画面左端(bottom:10%-10px)に配置しました');
    setButtonLabel(isOverrideLocal ? LABEL_OVERRIDE : LABEL_NORMAL);

    syncButtonVisibilityForTextStyling();

    requestAnimationFrame(positionGalleryButton);
}

// ===== ギャラリーボタンの生成 =====

function createGalleryButton() {
    const existing = document.getElementById(GALLERY_BUTTON_ID);
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = GALLERY_BUTTON_ID;
    btn.type = 'button';
    btn.title = 'SillyTavern公式ギャラリーを開く';
    btn.textContent = 'ギャラリー';

    Object.assign(btn.style, {
        position: 'fixed',
        left: '0',
        bottom: 'calc(10% - 10px)',
        zIndex: '15000',
        padding: '6px 12px',
        fontSize: '12px',
        color: '#ffffff',
        backgroundColor: '#444',
        border: '1px solid #666',
        borderTopRightRadius: '6px',
        borderBottomRightRadius: '6px',
        cursor: 'pointer',
        opacity: '0.12',
        transition: 'opacity 0.15s ease, background-color 0.15s ease',
        userSelect: 'none',
        outline: 'none',
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',
        touchAction: 'manipulation',
    });

    btn.addEventListener('mouseenter', () => {
        btn.style.opacity = '1';
        btn.style.backgroundColor = '#666';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.opacity = '0.12';
        btn.style.backgroundColor = '#444';
    });

    let flashTimer = null;
    const flashBlue = () => {
        if (flashTimer) clearTimeout(flashTimer);
        btn.style.backgroundColor = '#0a84ff';
        btn.style.opacity = '1';
        flashTimer = setTimeout(() => {
            const hovering = btn.matches(':hover');
            btn.style.backgroundColor = hovering ? '#666' : '#444';
            btn.style.opacity = hovering ? '1' : '0.12';
            flashTimer = null;
        }, 250);
    };

    let lastActionTime = 0;
    const triggerAction = (source) => {
        const now = Date.now();
        if (now - lastActionTime < 200) return;
        lastActionTime = now;
        console.log(`[GIC] ギャラリーボタントリガー: ${source}`);

        // ★ ユーザーが操作した → ウォームアップを中断
        if (warmupState === 'running') {
            warmupState = 'aborted';
            const hs = document.getElementById('gic-gallery-warmup-hide');
            if (hs) hs.remove();
            console.log('[GIC] 🔥 ユーザー操作によりウォームアップを中断');
        }

        flashBlue();
        openGalleryFromGic();
    };

    btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        triggerAction('pointerdown');
    }, true);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        triggerAction('click');
    }, true);

    document.body.appendChild(btn);
    console.log('[GIC] ✅ ギャラリーボタンをDOMに追加しました');

    requestAnimationFrame(positionGalleryButton);

    syncGalleryButtonVisibility();
}

// ===== イベント登録 =====

function setupListeners() {
    const safeOn = (type, handler) => {
        if (type && eventSource?.on) eventSource.on(type, handler);
    };
    safeOn(event_types.MESSAGE_RECEIVED, scanForGeneratedImages);
    safeOn(event_types.CHARACTER_MESSAGE_RENDERED, scanForGeneratedImages);
    safeOn(event_types.USER_MESSAGE_RENDERED, scanForGeneratedImages);
    if (event_types.MESSAGE_UPDATED) safeOn(event_types.MESSAGE_UPDATED, scanForGeneratedImages);
    if (event_types.MESSAGE_SWIPED) safeOn(event_types.MESSAGE_SWIPED, scanForGeneratedImages);
    if (event_types.CHAT_CHANGED) safeOn(event_types.CHAT_CHANGED, scanForGeneratedImages);
    console.log('[GIC] ✅ イベントリスナーを登録しました');
}

// ===== 初期化 =====

function initializeGIC() {
    console.log('[GIC] 初期化開始');

    loadPersistedState();

    createReleaseButton();
    createGalleryButton();
    setupListeners();
    setupTextStylingObserver();
    setupGalleryObserverForGic();

    setInterval(() => {
        scanForGeneratedImages();
        syncButtonVisibilityForTextStyling();
        syncGalleryButtonVisibility();
        markGeneratedMessagesInDom();
        positionGalleryButton();
        applyGalleryLayout();
    }, 1500);

    scanForGeneratedImages();
    syncButtonVisibilityForTextStyling();
    syncGalleryButtonVisibility();
    applyGalleryLayout();

    // ★ 一定時間後にギャラリーのウォームアップを開始
    setTimeout(() => {
        warmUpGallery().catch(e => {
            console.warn('[GIC] ウォームアップ呼び出しでエラー:', e);
        });
    }, GALLERY_WARMUP_DELAY_MS);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeGIC);
} else {
    if (document.body) {
        initializeGIC();
    } else {
        setTimeout(() => {
            if (document.body) initializeGIC();
            else document.addEventListener('DOMContentLoaded', initializeGIC);
        }, 100);
    }
}

// ===== activate フック =====

export async function activate() {
    console.log('[GIC] activate() が呼ばれました');
    loadPersistedState();
    createReleaseButton();
    createGalleryButton();
    setupGalleryObserverForGic();
    applyGalleryLayout();
    console.log('[GIC] ✅ Generate Image Controller: アクティベート完了');
}
