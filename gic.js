import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ===== 定数 =====
const BUTTON_ID = 'gic-release-override-button';
const LABEL_OVERRIDE = '背景生成';
const LABEL_NORMAL   = '事前設定';

// ===== 状態 =====
let lastGeneratedImageUrl = null;
const processedMessageKeys = new Set();

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

/**
 * メッセージを一意に識別するキーを生成
 * send_date は一意のタイムスタンプなので優先的に使用
 */
function getMessageKey(message) {
    if (message?.send_date) return message.send_date;
    return `${message?.name || 'unknown'}_${(message?.mes || '').slice(0, 80)}`;
}

function isOverrideActive() {
    try {
        return window.ImageDisplayExtension?.isOverride?.() === true;
    } catch (e) {
        return false;
    }
}

function syncButtonLabel() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    const newLabel = isOverrideActive() ? LABEL_OVERRIDE : LABEL_NORMAL;
    if (btn.textContent !== newLabel) {
        btn.textContent = newLabel;
        console.log(`[GIC] ラベル同期: ${newLabel}`);
    }
}

function setButtonLabel(label) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    if (btn.textContent !== label) {
        btn.textContent = label;
        console.log(`[GIC] ラベル設定: ${label}`);
    }
}

// ===== 生成画像のスキャン（イベント非依存） =====

async function scanForGeneratedImages() {
    const context = getContext();
    if (!context?.chat) return;

    // チャットの末尾から未処理の生成画像メッセージを探す
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (!isGeneratedImageMessage(msg)) continue;

        const key = getMessageKey(msg);
        if (processedMessageKeys.has(key)) continue;

        // 未処理の生成画像メッセージを発見
        processedMessageKeys.add(key);
        const url = extractImageUrl(msg);
        console.log(`[GIC] 🔍 未処理の生成画像メッセージを検出 (index=${i}, key=${key})`);
        console.log(`[GIC] URL: ${url}`);

        if (!url) continue;

        // AIから隠す（ghost状態）
        if (!msg.is_system) {
            msg.is_system = true;
            try {
                await saveChat();
                printMessages();
                console.log('[GIC] メッセージをAI非表示に設定');
            } catch (e) {
                console.error('[GIC] saveChat/printMessages エラー:', e);
            }
        }

        // IDEに強制表示を依頼
        lastGeneratedImageUrl = url;
        if (window.ImageDisplayExtension?.setOverrideImage) {
            try {
                await window.ImageDisplayExtension.setOverrideImage(url);
                console.log(`[GIC] 🖼️ 生成画像を背景に設定: ${url}`);
                setButtonLabel(LABEL_OVERRIDE);
            } catch (e) {
                console.error('[GIC] ImageDisplayExtension エラー:', e);
            }
        }
        break; // 最新の1件のみ処理
    }
}

// ===== ボタンのアクション =====

function handleButtonAction() {
    const wasOverride = isOverrideActive();
    console.log(`[GIC] ボタンアクション: 現在=${wasOverride ? '強制表示' : '通常'}, lastUrl=${lastGeneratedImageUrl}`);

    if (wasOverride) {
        // 強制表示 → 通常モード
        if (window.ImageDisplayExtension?.clearOverrideImage) {
            try {
                window.ImageDisplayExtension.clearOverrideImage();
                console.log('[GIC] clearOverrideImage() 成功');
                setButtonLabel(LABEL_NORMAL);
            } catch (err) {
                console.error('[GIC] clearOverrideImage エラー:', err);
            }
        }
    } else {
        // 通常 → 強制表示
        if (!lastGeneratedImageUrl) {
            console.warn('[GIC] 再表示できる生成画像がありません。先に画像を生成してください。');
            return;
        }
        if (window.ImageDisplayExtension?.setOverrideImage) {
            try {
                window.ImageDisplayExtension.setOverrideImage(lastGeneratedImageUrl);
                console.log(`[GIC] setOverrideImage() 成功: ${lastGeneratedImageUrl}`);
                setButtonLabel(LABEL_OVERRIDE);
            } catch (err) {
                console.error('[GIC] setOverrideImage エラー:', err);
            }
        }
    }

    setTimeout(syncButtonLabel, 300);
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
        zIndex: '2147483647',
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

    // 二重発火防止用のタイムスタンプ
    let lastActionTime = 0;
    const triggerAction = (source) => {
        const now = Date.now();
        if (now - lastActionTime < 200) return;
        lastActionTime = now;
        console.log(`[GIC] トリガー: ${source}`);
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
    syncButtonLabel();
}

// ===== イベント登録（保険として複数） =====

function setupListeners() {
    const safeOn = (type, handler) => {
        if (type && eventSource?.on) {
            eventSource.on(type, handler);
        }
    };

    // 生成画像メッセージを取りこぼさないよう複数イベントを監視
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

    // 定期的にラベル同期と未処理画像のスキャン
    setInterval(() => {
        syncButtonLabel();
        scanForGeneratedImages();
    }, 1500);

    // 初回スキャン
    scanForGeneratedImages();
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
