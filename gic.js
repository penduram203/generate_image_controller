import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ===== 定数 =====
const BUTTON_ID = 'gic-release-override-button';
const LABEL_OVERRIDE = '背景生成';
const LABEL_NORMAL   = '事前設定';
const HIDE_CLASS     = 'gic-hidden-by-text-styling';

// ===== 状態 =====
let lastGeneratedImageUrl = null;
let isOverrideLocal = false;
const processedMessageKeys = new Set();

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
    }
}

// ===== Text_stylingパネル開閉監視 =====

/**
 * Text_styling拡張機能のパネルが表示中かどうかを判定
 */
function isTextStylingPanelOpen() {
    const panel = document.getElementById('text-styling-panel');
    if (!panel) return false;
    const cs = getComputedStyle(panel);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    const rect = panel.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
}

let lastTextStylingState = null;

/**
 * Text_stylingパネルの開閉状態に応じてボタンの表示/非表示を切り替え
 * クラスで制御するため、IDE側のstyle.display操作と競合しない
 */
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

/**
 * bodyのDOM変化を監視して、Text_stylingパネルの開閉を検出
 */
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

// ===== 生成画像のスキャン =====

async function scanForGeneratedImages() {
    const context = getContext();
    if (!context?.chat) return;

    let foundNewest = false;

    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (!isGeneratedImageMessage(msg)) continue;

        const key = getMessageKey(msg);

        if (!foundNewest) {
            foundNewest = true;

            if (processedMessageKeys.has(key)) {
                continue;
            }
            processedMessageKeys.add(key);

            const url = extractImageUrl(msg);
            if (!url) continue;

            if (!msg.is_system) {
                msg.is_system = true;
                try {
                    await saveChat();
                    printMessages();
                } catch (e) {
                    console.error('[GIC] saveChat/printMessages エラー:', e);
                }
            }

            lastGeneratedImageUrl = url;
            if (window.ImageDisplayExtension?.setOverrideImage) {
                try {
                    await window.ImageDisplayExtension.setOverrideImage(url);
                    isOverrideLocal = true;
                    setButtonLabel(LABEL_OVERRIDE);
                    console.log(`[GIC] 🖼️ 最新の生成画像を背景に設定: ${url}`);
                } catch (e) {
                    console.error('[GIC] ImageDisplayExtension エラー:', e);
                }
            }
        } else {
            if (!processedMessageKeys.has(key)) {
                processedMessageKeys.add(key);
            }
        }
    }
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
}

// ===== ボタンの生成 =====

function createReleaseButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = '強制表示モード（背景生成）と通常モード（事前設定）を切り替える';
    btn.textContent = LABEL_NORMAL;

    Object.assign(btn.style, {
        position: 'fixed',
        left: '0',
        bottom: '10%',
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
    console.log('[GIC] ✅ ボタンを画面左端(bottom:10%)に配置しました');
    setButtonLabel(isOverrideLocal ? LABEL_OVERRIDE : LABEL_NORMAL);

    // 初期状態を反映
    syncButtonVisibilityForTextStyling();
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
    createReleaseButton();
    setupListeners();
    setupTextStylingObserver();

    setInterval(() => {
        scanForGeneratedImages();
        syncButtonVisibilityForTextStyling();
    }, 1500);

    scanForGeneratedImages();
    syncButtonVisibilityForTextStyling();
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
    createReleaseButton();
    console.log('[GIC] ✅ Generate Image Controller: アクティベート完了');
}
