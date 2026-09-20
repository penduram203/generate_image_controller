import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ===== 定数 =====
const BUTTON_ID = 'gic-release-override-button';

// ===== 状態 =====
let lastGeneratedImageUrl = null;

// ===== ユーティリティ =====

/**
 * 生成画像メッセージかどうかを判定
 */
function isGeneratedImageMessage(message) {
    return Array.isArray(message?.extra?.media) &&
           message.extra.media.some(m => m.source === 'generated');
}

/**
 * 生成画像メッセージから画像URLを取得
 */
function extractImageUrl(message) {
    if (!Array.isArray(message?.extra?.media)) return null;
    const media = message.extra.media.find(m => m.source === 'generated');
    return media?.url || null;
}

/**
 * 強制表示モードがアクティブかどうかを取得
 */
function isOverrideActive() {
    return window.ImageDisplayExtension?.isOverride?.() || false;
}

// ===== ボタンのラベル更新 =====

/**
 * 現在のモードに応じてボタンのラベルを更新
 * - 強制表示モード中 → 「背景生成」
 * - 通常モード時     → 「事前設定」
 */
function updateButtonLabel() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    const newLabel = isOverrideActive() ? '背景生成' : '事前設定';
    if (btn.textContent !== newLabel) {
        btn.textContent = newLabel;
        console.log(`[GIC] ボタンラベル更新: ${newLabel}`);
    }
}

// ===== トグルボタン =====

/**
 * モード切替ボタンを生成して画面左端に配置
 * 位置: 左端, 最下部から高さ10% / 半透明 / 常に表示
 */
function createReleaseButton() {
    // 既存ボタンがあれば削除（拡張機能再ロード時対策）
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
        console.log('[GIC] 既存のボタンを削除して再作成します');
        existing.remove();
    }

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = '強制表示モード（背景生成）と通常モード（事前設定）を切り替える';
    btn.textContent = '事前設定'; // 初期ラベル（後で updateButtonLabel が正しく上書き）

    // インラインスタイルで確実に配置（CSSファイル非依存）
    Object.assign(btn.style, {
        position: 'fixed',
        left: '0',
        bottom: '10%',                        // ← 画面最下部から高さ10%の位置
        zIndex: '99999',
        padding: '6px 12px',
        fontSize: '12px',
        // writingMode / textOrientation は指定しない（横書き）
        color: '#ffffff',
        backgroundColor: '#444',
        border: '1px solid #666',
        borderLeft: 'none',
        borderTopRightRadius: '6px',
        borderBottomRightRadius: '6px',
        borderTopLeftRadius: '0',
        borderBottomLeftRadius: '0',
        cursor: 'pointer',
        opacity: '0.25',
        transition: 'opacity 0.2s ease, background-color 0.2s ease',
        userSelect: 'none',
        outline: 'none',
        whiteSpace: 'nowrap',
    });

    // ホバー時の視覚フィードバック
    btn.addEventListener('mouseenter', () => {
        btn.style.opacity = '1';
        btn.style.backgroundColor = '#666';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.opacity = '0.25';
        btn.style.backgroundColor = '#444';
    });

    // クリックでモードをトグル
    btn.addEventListener('click', () => {
        if (isOverrideActive()) {
            // 強制表示モード → 通常モードへ
            if (window.ImageDisplayExtension?.clearOverrideImage) {
                try {
                    window.ImageDisplayExtension.clearOverrideImage();
                    console.log('[GIC] ボタン: 強制表示モード → 通常モードへ切替');
                } catch (e) {
                    console.error('[GIC] 解除エラー:', e);
                }
            } else {
                console.warn('[GIC] ImageDisplayExtension.clearOverrideImage が利用できません');
            }
        } else {
            // 通常モード → 強制表示モードへ（最後の生成画像を再表示）
            if (lastGeneratedImageUrl && window.ImageDisplayExtension?.setOverrideImage) {
                try {
                    window.ImageDisplayExtension.setOverrideImage(lastGeneratedImageUrl);
                    console.log(`[GIC] ボタン: 通常モード → 強制表示モードへ切替 (${lastGeneratedImageUrl})`);
                } catch (e) {
                    console.error('[GIC] 強制表示エラー:', e);
                }
            } else {
                console.warn('[GIC] 再表示できる生成画像がまだありません');
            }
        }
        // ラベル更新は少し遅延させる（IDE側の状態反映を待つ）
        setTimeout(updateButtonLabel, 150);
    });

    document.body.appendChild(btn);
    console.log('[GIC] ✅ トグルボタンを画面左端(bottom:10%)に配置しました');
    updateButtonLabel();
}

// ===== イベントハンドラ登録 =====

function setupMessageListener() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async (index) => {
        const context = getContext();
        const message = context.chat[index];

        if (!isGeneratedImageMessage(message)) return;

        // 1) AIから隠す（ghost状態にする）
        message.is_system = true;

        // 2) 生成画像URLを取得
        const imageUrl = extractImageUrl(message);

        // 3) Image Display Extension に背景画像として強制表示を依頼
        if (imageUrl && window.ImageDisplayExtension?.setOverrideImage) {
            try {
                lastGeneratedImageUrl = imageUrl;
                const ok = await window.ImageDisplayExtension.setOverrideImage(imageUrl);
                console.log(ok
                    ? `[GIC] 🖼️ 生成画像を背景に設定: ${imageUrl}`
                    : `[GIC] ⚠️ 背景設定に失敗: ${imageUrl}`);
                // ラベルを「背景生成」に更新
                setTimeout(updateButtonLabel, 150);
            } catch (e) {
                console.error('[GIC] ImageDisplayExtension 連携エラー:', e);
            }
        } else if (!imageUrl) {
            console.warn('[GIC] ⚠️ 生成画像URLが取得できませんでした');
        } else {
            console.warn('[GIC] ⚠️ ImageDisplayExtension が見つかりません。先にロードされているか確認してください。');
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

    // 定期的にラベルを同期
    // IDE側が外部から clearOverrideImage を呼んだ場合や、
    // 画像生成以外の要因で状態が変わった場合に対応する保険。
    setInterval(updateButtonLabel, 2000);
}

// DOMContentLoaded または即時実行
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

// ===== activate フック（SillyTavernが呼ぶ場合） =====

export async function activate() {
    console.log('[GIC] activate() が呼ばれました');
    createReleaseButton();
    console.log('[GIC] ✅ Generate Image Controller: アクティベート完了');
}
