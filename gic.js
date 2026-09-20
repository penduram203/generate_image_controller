import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ===== 定数 =====
const BUTTON_ID = 'gic-release-override-button';
const LABEL_OVERRIDE = '背景生成';   // 強制表示モード時
const LABEL_NORMAL   = '事前設定';   // 通常モード時

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

/**
 * 強制表示モードがアクティブかどうかを取得
 */
function isOverrideActive() {
    try {
        return window.ImageDisplayExtension?.isOverride?.() === true;
    } catch (e) {
        return false;
    }
}

/**
 * ボタンのラベルを現在のモードに同期
 */
function syncButtonLabel() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    const newLabel = isOverrideActive() ? LABEL_OVERRIDE : LABEL_NORMAL;
    if (btn.textContent !== newLabel) {
        btn.textContent = newLabel;
        console.log(`[GIC] ラベル同期: ${newLabel}`);
    }
}

/**
 * ボタンのラベルを明示的に設定
 */
function setButtonLabel(label) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    if (btn.textContent !== label) {
        btn.textContent = label;
        console.log(`[GIC] ラベル設定: ${label}`);
    }
}

// ===== トグルボタン =====

function createReleaseButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
        console.log('[GIC] 既存のボタンを削除して再作成します');
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
        zIndex: '2147483647',      // 最大値（他のUIより確実に前面）
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
        opacity: '0.08',           // ← 非ホバー時はさらに薄く
        transition: 'opacity 0.2s ease, background-color 0.2s ease',
        userSelect: 'none',
        outline: 'none',
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',     // ← クリックを確実に受け取る
    });

    btn.addEventListener('mouseenter', () => {
        btn.style.opacity = '1';
        btn.style.backgroundColor = '#666';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.opacity = '0.08';
        btn.style.backgroundColor = '#444';
    });

    // ===== クリック時のトグル処理 =====
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();

        const wasOverride = isOverrideActive();
        console.log(`[GIC] ボタンクリック: 現在のモード = ${wasOverride ? '強制表示' : '通常'}`);
        console.log(`[GIC] lastGeneratedImageUrl = ${lastGeneratedImageUrl}`);

        if (wasOverride) {
            // ---- 強制表示 → 通常モードへ ----
            if (window.ImageDisplayExtension?.clearOverrideImage) {
                try {
                    window.ImageDisplayExtension.clearOverrideImage();
                    console.log('[GIC] clearOverrideImage() 呼び出し成功');
                    setButtonLabel(LABEL_NORMAL);   // ← 即座にラベル変更
                } catch (err) {
                    console.error('[GIC] clearOverrideImage エラー:', err);
                }
            } else {
                console.warn('[GIC] ImageDisplayExtension.clearOverrideImage が利用できません');
            }
        } else {
            // ---- 通常モード → 強制表示へ ----
            if (!lastGeneratedImageUrl) {
                console.warn('[GIC] 再表示できる生成画像がまだありません。先に画像を生成してください。');
                return;
            }
            if (window.ImageDisplayExtension?.setOverrideImage) {
                try {
                    window.ImageDisplayExtension.setOverrideImage(lastGeneratedImageUrl);
                    console.log(`[GIC] setOverrideImage() 呼び出し成功: ${lastGeneratedImageUrl}`);
                    setButtonLabel(LABEL_OVERRIDE); // ← 即座にラベル変更
                } catch (err) {
                    console.error('[GIC] setOverrideImage エラー:', err);
                }
            } else {
                console.warn('[GIC] ImageDisplayExtension.setOverrideImage が利用できません');
            }
        }

        // 少し遅延して実際の状態と再同期（IDE側で失敗していた場合の保険）
        setTimeout(syncButtonLabel, 300);
    });

    document.body.appendChild(btn);
    console.log('[GIC] ✅ トグルボタンを画面左端(bottom:10%)に配置しました');
    syncButtonLabel();
}

// ===== イベントハンドラ登録 =====

function setupMessageListener() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async (index) => {
        const context = getContext();
        const message = context.chat[index];

        if (!isGeneratedImageMessage(message)) return;

        // 1) AIから隠す
        message.is_system = true;

        // 2) 生成画像URLを取得
        const imageUrl = extractImageUrl(message);

        // 3) IDE に強制表示を依頼
        if (imageUrl && window.ImageDisplayExtension?.setOverrideImage) {
            try {
                lastGeneratedImageUrl = imageUrl;
                const ok = await window.ImageDisplayExtension.setOverrideImage(imageUrl);
                console.log(ok
                    ? `[GIC] 🖼️ 生成画像を背景に設定: ${imageUrl}`
                    : `[GIC] ⚠️ 背景設定に失敗: ${imageUrl}`);
                setButtonLabel(LABEL_OVERRIDE);  // ← 生成直後にラベル更新
            } catch (e) {
                console.error('[GIC] ImageDisplayExtension 連携エラー:', e);
            }
        } else if (!imageUrl) {
            console.warn('[GIC] ⚠️ 生成画像URLが取得できませんでした');
        } else {
            console.warn('[GIC] ⚠️ ImageDisplayExtension が見つかりません');
        }

        // 4) 保存＆再描画
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

    // 2秒ごとにラベルを同期（外部から状態が変わった場合の保険）
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
