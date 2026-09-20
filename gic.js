import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ===== 定数 =====
const BUTTON_ID = 'gic-release-override-button';

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

// ===== 手動解除ボタン =====

/**
 * 強制表示解除ボタンを生成して画面左端に配置
 * 位置: 左端, 高さ 500px / 半透明 / 常に表示
 */
function createReleaseButton() {
    // 既存ボタンがあれば削除（拡張機能再ロード時対策）
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
        console.log('[GIC] 既存の解除ボタンを削除して再作成します');
        existing.remove();
    }

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = '生成画像の強制表示を解除し、通常のキーワードマッチに戻す';
    btn.textContent = '解除';

    // インラインスタイルで確実に配置（CSSファイル非依存）
    Object.assign(btn.style, {
        position: 'fixed',
        left: '0',
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: '99999',
        padding: '8px 4px',
        fontSize: '11px',
        lineHeight: '1.2',
        writingMode: 'vertical-rl',
        textOrientation: 'mixed',
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

    // クリックで強制表示を解除
    btn.addEventListener('click', () => {
        if (window.ImageDisplayExtension?.clearOverrideImage) {
            try {
                window.ImageDisplayExtension.clearOverrideImage();
                console.log('[GIC] 手動解除ボタン: 強制表示を解除しました');
            } catch (e) {
                console.error('[GIC] 強制表示解除エラー:', e);
            }
        } else {
            console.warn('[GIC] ImageDisplayExtension.clearOverrideImage が利用できません');
        }
    });

    document.body.appendChild(btn);
    console.log('[GIC] ✅ 解除ボタンを画面左端(top:500px)に配置しました');
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
                const ok = await window.ImageDisplayExtension.setOverrideImage(imageUrl);
                console.log(ok
                    ? `[GIC] 🖼️ 生成画像を背景に設定: ${imageUrl}`
                    : `[GIC] ⚠️ 背景設定に失敗: ${imageUrl}`);
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

// ===== 初期化（activate が呼ばれない環境への対応） =====

function initializeGIC() {
    console.log('[GIC] 初期化開始');
    createReleaseButton();
    setupMessageListener();
}

// DOMContentLoaded または即時実行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeGIC);
} else {
    // bodyが既に存在する場合は即時実行
    if (document.body) {
        initializeGIC();
    } else {
        // bodyがまだない場合は少し待つ
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
    // 既に初期化済みでも、ボタンが無ければ再作成
    createReleaseButton();
    console.log('[GIC] ✅ Generate Image Controller: アクティベート完了');
}
