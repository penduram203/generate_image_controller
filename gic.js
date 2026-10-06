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

/**
 * 公式ギャラリーウィンドウのセレクタ。
 * 画面左端・高さ中央に配置する。
 */
const GALLERY_WINDOW_SELECTORS = [
    '#gallery',
];

/**
 * 画像クリック時に表示される拡大パネルのセレクタ。
 * 画面中央に配置し、ビューポート内に収まるサイズへ自動調整する。
 */
const GALLERY_PREVIEW_SELECTORS = [
    '.galleryImageDraggable',
    '#gallery .galleryImageDraggable',
];

/**
 * 拡大パネルを画面内に収めるときのマージン(px)
 */
const GALLERY_PREVIEW_MARGIN_X = 40;
const GALLERY_PREVIEW_MARGIN_Y = 60;

// ===== 状態 =====
let lastGeneratedImageUrl = null;
let isOverrideLocal = false;
const processedMessageKeys = new Set();

// 現在表示中の拡大パネル（最新のもの）を追跡
let currentPreviewEl = null;

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

// ===== スタイル注入（クラスで非表示にするためのCSS） =====
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

// ===== ギャラリー配置用CSS注入 =====
(function injectGalleryLayoutStyle() {
    if (document.getElementById('gic-gallery-layout-style')) return;
    const style = document.createElement('style');
    style.id = 'gic-gallery-layout-style';

    const windowSel = GALLERY_WINDOW_SELECTORS.join(', ');
    const previewSel = GALLERY_PREVIEW_SELECTORS.join(', ');

    style.textContent = `
        /* ギャラリーウィンドウ: 画面左端・高さ中央 */
        ${windowSel} {
            position: fixed !important;
            top: 50% !important;
            left: 0 !important;
            right: auto !important;
            bottom: auto !important;
            transform: translateY(-50%) !important;
            margin: 0 !important;
        }

        /* 画像クリック時の拡大パネル: 画面中央（サイズはJSで動的計算） */
        ${previewSel} {
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            right: auto !important;
            bottom: auto !important;
            transform: translate(-50%, -50%) !important;
            transform-origin: center center !important;
            margin: 0 !important;
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
        // ラベル幅が変わるのでギャラリーボタンの位置を更新
        requestAnimationFrame(positionGalleryButton);
    }
}

// ===== DOMマーキング（パス非依存のCSSフォールバック用） =====

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
    const observer = new MutationObserver(() => {
        syncButtonVisibilityForTextStyling();
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
    });
    console.log('[GIC] 📝 Text_stylingパネル監視を開始しました');
}

// ===== 生成画像のスキャン（リロード後の状態復元を含む） =====

async function scanForGeneratedImages() {
    const context = getContext();
    if (!context?.chat) return;

    // --- 最新の生成画像メッセージを探索 ---
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

    // ★ 処理済みでも常に最新URLは復元する（リロード対策）
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

        // 新規検出時は自動的に背景表示モードへ
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
        // ★ 処理済み（リロード後など）: override状態を復元
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

    // 古い生成画像メッセージも processed としてマーク
    for (let i = 0; i < newestIdx; i++) {
        const msg = context.chat[i];
        if (isGeneratedImageMessage(msg)) {
            processedMessageKeys.add(getMessageKey(msg));
        }
    }

    // DOM に gic-hidden-message クラスを付与（CSSフォールバック）
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

/**
 * GICボタンの実幅を読み取り、ギャラリーボタンをその右隣に配置する。
 * ラベル変更などでGICボタン幅が変わった際に呼ぶ。
 */
function positionGalleryButton() {
    const gicBtn = document.getElementById(BUTTON_ID);
    const galleryBtn = document.getElementById(GALLERY_BUTTON_ID);
    if (!gicBtn || !galleryBtn) return;
    const w = gicBtn.offsetWidth;
    if (!w) return; // まだレイアウトされていない
    // 4px の隙間を開けて配置
    galleryBtn.style.left = (w + 4) + 'px';
}

// ===== 公式ギャラリーの開閉検知 =====

function isGalleryOpen() {
    const candidates = document.querySelectorAll([
        '#gallery_container',
        '.gallery-container',
        '.gallery_container',
        '#gallery',
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
        return true;
    }
    return false;
}

// ===== ギャラリー配置・プレビュー制御 =====

/**
 * すべての拡大パネルを取得する
 */
function getAllPreviews() {
    const selector = GALLERY_PREVIEW_SELECTORS.join(', ');
    return Array.from(document.querySelectorAll(selector));
}

/**
 * 拡大パネルを閉じる
 * - 公式の閉じるボタン(.dragClose)があればクリック
 * - なければ直接DOMから削除
 */
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

/**
 * 拡大パネル内の画像を、縦横比を保ったままビューポート内に収める
 * - naturalWidth/naturalHeight を基準に倍率を計算
 * - 画面外にはみ出さない最大サイズに拡大
 */
function fitPreviewToViewport(panel) {
    if (!panel) return;

    // パネル自体を画面中央に固定
    panel.style.setProperty('position', 'fixed', 'important');
    panel.style.setProperty('top', '50%', 'important');
    panel.style.setProperty('left', '50%', 'important');
    panel.style.setProperty('right', 'auto', 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
    panel.style.setProperty('transform-origin', 'center center', 'important');
    panel.style.setProperty('margin', '0', 'important');
    panel.style.setProperty('width', 'auto', 'important');
    panel.style.setProperty('height', 'auto', 'important');

    const img = panel.querySelector('img');
    if (!img) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxW = Math.max(100, vw - GALLERY_PREVIEW_MARGIN_X * 2);
    const maxH = Math.max(100, vh - GALLERY_PREVIEW_MARGIN_Y * 2);

    const applySize = () => {
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        if (!nw || !nh) return;

        // 縦横比を保ったまま maxW/maxH 内に収まる倍率
        const scale = Math.min(maxW / nw, maxH / nh);
        const finalW = Math.max(1, Math.floor(nw * scale));
        const finalH = Math.max(1, Math.floor(nh * scale));

        img.style.setProperty('width', finalW + 'px', 'important');
        img.style.setProperty('height', finalH + 'px', 'important');
        img.style.setProperty('max-width', 'none', 'important');
        img.style.setProperty('max-height', 'none', 'important');
        img.style.setProperty('object-fit', 'contain', 'important');
        img.style.setProperty('display', 'block', 'important');
    };

    if (img.complete && img.naturalWidth) {
        applySize();
    } else {
        // 読み込み完了後に再実行（多重登録防止）
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

/**
 * ギャラリーとプレビューの位置・サイズをJSで強制適用する。
 * - 最新のプレビューのみを残し、古いものは閉じる
 * - 最新プレビューをビューポート内に収める
 */
function applyGalleryLayout() {
    // ギャラリーウィンドウ
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
    }

    // 拡大パネル群
    const previews = getAllPreviews();
    if (previews.length === 0) {
        currentPreviewEl = null;
        return;
    }

    // 最新（DOM順で最後）のみを残す
    const latest = previews[previews.length - 1];
    if (latest !== currentPreviewEl) {
        for (const el of previews) {
            if (el === latest) continue;
            closePreviewElement(el);
        }
        currentPreviewEl = latest;
    }

    // 最新の拡大パネルをビューポート内に収める
    fitPreviewToViewport(latest);
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

    // ★ ギャラリーが開いたタイミングで配置を即時適用
    if (galleryOpen) {
        applyGalleryLayout();
    }
}

function setupGalleryObserverForGic() {
    const observer = new MutationObserver(() => {
        syncGalleryButtonVisibility();
        applyGalleryLayout();   // ギャラリー・プレビューの配置を毎回強制
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
    });

    // 保険の定期チェック
    setInterval(() => {
        syncGalleryButtonVisibility();
        applyGalleryLayout();
    }, 300);

    // 初回チェック
    syncGalleryButtonVisibility();
    applyGalleryLayout();
}

// ===== 公式ギャラリーを開く =====

/**
 * SillyTavern公式ギャラリーを開く。
 * 複数の方法を順に試行し、成功した時点で true を返す。
 */
function openGalleryFromGic() {
    // 1. SillyTavern context に公開された関数があれば使う
    try {
        const ctx = getContext();
        if (ctx && typeof ctx.openGallery === 'function') {
            ctx.openGallery();
            console.log('[GIC] ギャラリーを開きました (ctx.openGallery)');
            return true;
        }
    } catch (e) { /* ignore */ }

    // 2. 直接的なボタンIDを試す
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

    // 3. extensionsMenu 内の項目をテキストで探す
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

    // 4. ページ全体からテキスト一致で探す（最終手段）
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

    // レイアウト確定後にギャラリーボタンを再配置
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
        left: '0',           // positionGalleryButton() で動的に更新
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

    // レイアウト確定後に位置を合わせる
    requestAnimationFrame(positionGalleryButton);

    // 初回のギャラリー状態チェック
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

    // ★ 永続化された状態を復元してからボタンを生成
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
