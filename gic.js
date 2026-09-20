import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ===== 定数 =====
const BUTTON_ID = 'gic-release-override-button';
const LABEL_OVERRIDE = '背景生成';
const LABEL_NORMAL   = '事前設定';

// ===== 状態 =====
let lastGeneratedImageUrl = null;

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

// ===== クリック処理本体 =====

function handleButtonAction() {
    const wasOverride = isOverrideActive();
    console.log(`[GIC] ボタンアクション発火: 現在=${wasOverride ? '強制表示' : '通常'}, lastUrl=${lastGeneratedImageUrl}`);

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
        } else {
            console.warn('[GIC] clearOverrideImage 利用不可');
        }
    } else {
        // 通常モード → 強制表示
        if (!lastGeneratedImageUrl) {
            console.warn('[GIC] 再表示できる生成画像がありません');
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
        } else {
            console.warn('[GIC] setOverrideImage 利用不可');
        }
    }

    // IDE側の状態と再同期
    setTimeout(syncButtonLabel, 300);
}

// ===== トグルボタン =====

function createReleaseButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
        console.log('[GIC] 既存のボタンを削除');
        existing.remove();
    }

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
        borderTopLeftRadius: '0',
        borderBottomLeftRadius: '0',
        cursor: 'pointer',
        opacity: '0.16',                 // ← 0.08 から 0.16 に変更
        transition: 'opacity 0.15s ease, background-color 0.15s ease',
        userSelect: 'none',
        outline: 'none',
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',
        touchAction: 'manipulation',
    });

    // ホバー時の視覚フィードバック
    btn.addEventListener('mouseenter', () => {
        btn.style.opacity = '1';
        btn.style.backgroundColor = '#666';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.opacity = '0.16';
        btn.style.backgroundColor = '#444';
    });

    // クリック視覚フィードバック（一瞬色を変える）
    const flash = () => {
        btn.style.backgroundColor = '#0a84ff';
        setTimeout(() => {
            btn.style.backgroundColor = (btn.matches(':hover') ? '#666' : '#444');
        }, 150);
    };

    // ===== クリック処理 =====
    // pointerdown と click の両方を登録。pointerdown が先に発火するが、
    // ダブル発火を防ぐためデバウンス的に 200ms のガードを入れる。
    let lastActionTime = 0;
    const triggerAction = (source) => {
        const now = Date.now();
        if (now - lastActionTime < 200) {
            console.log(`[GIC] 連続発火を無視 (${source})`);
            return;
        }
        lastActionTime = now;
        console.log(`[GIC] トリガー: ${source}`);
        flash();
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
    console.log('[GIC] ✅ トグルボタンを画面左端(bottom:10%)に配置しました');
    syncButtonLabel();

    // デバッグ用：クリック位置に何があるか確認できるようにする
    setTimeout(() => {
        const rect = btn.getBoundingClientRect();
        const topEl = document.elementFromPoint(rect.left + 5, rect.top + rect.height / 2);
        console.log('[GIC] ボタン位置:', rect);
        console.log('[GIC] その位置の最前面要素:', topEl);
        console.log('[GIC] ボタンが最前面か:', topEl === btn);
    }, 500);
}

// ===== イベントハンドラ登録 =====

function setupMessageListener() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async (index) => {
        const context = getContext();
        const message = context.chat[index];

        if (!isGeneratedImageMessage(message)) return;

        message.is_system = true;

        const imageUrl = extractImageUrl(message);

        if (imageUrl && window.ImageDisplayExtension?.setOverrideImage) {
            try {
                lastGeneratedImageUrl = imageUrl;
                const ok = await window.ImageDisplayExtension.setOverrideImage(imageUrl);
                console.log(ok
                    ? `[GIC] 🖼️ 生成画像を背景に設定: ${imageUrl}`
                    : `[GIC] ⚠️ 背景設定に失敗: ${imageUrl}`);
                setButtonLabel(LABEL_OVERRIDE);
            } catch (e) {
                console.error('[GIC] ImageDisplayExtension 連携エラー:', e);
            }
        } else if (!imageUrl) {
            console.warn('[GIC] ⚠️ 生成画像URLが取得できませんでした');
        } else {
            console.warn('[GIC] ⚠️ ImageDisplayExtension が見つかりません');
        }

        await saveChat();
        printMessages();
    });
    console.log('[GIC] ✅ MESSAGE_RECEIVED リスナーを登録しました');
}

// ===== 初期化 =====

function initializeGIC() {
    console.log('[GIC] 初期化開始');
    createReleaseButton();
    setupMessageListener();

    setInterval(syncButtonLabel, 2000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeGIC);
} else {
    if (document.body) {
        initializeGIC();
    } else {
        setTimeout(() => {
            if (document.body) {
                initializeGIC();
            } else {
                document.addEventListener('DOMContentLoaded', initializeGIC);
            }
        }, 100);
    }
}

// ===== activate フック =====

export async function activate() {
    console.log('[GIC] activate() が呼ばれました');
    createReleaseButton();
    console.log('[GIC] ✅ Generate Image Controller: アクティベート完了');
}
