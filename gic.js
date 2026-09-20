import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

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
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = '生成画像の強制表示を解除し、通常のキーワードマッチに戻す';
    btn.textContent = '解除';

    // インラインスタイルで確実に配置（CSSファイル非依存）
    Object.assign(btn.style, {
        position: 'fixed',
        left: '0',
        top: '500px',
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
                console.log('🖱️ 手動解除ボタン: 強制表示を解除しました');
            } catch (e) {
                console.error('❌ 強制表示解除エラー:', e);
            }
        } else {
            console.warn('⚠️ ImageDisplayExtension.clearOverrideImage が利用できません');
        }
    });

    document.body.appendChild(btn);
    console.log('✅ 強制表示解除ボタンを画面左端(top:500px)に配置しました');
}

// ===== 拡張機能のアクティベート =====

export async function activate() {
    // 手動解除ボタンを配置
    createReleaseButton();

    // 画像生成メッセージの受信を監視
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
                    ? `🖼️ 生成画像を背景に設定: ${imageUrl}`
                    : `⚠️ 背景設定に失敗: ${imageUrl}`);
            } catch (e) {
                console.error('❌ ImageDisplayExtension 連携エラー:', e);
            }
        } else if (!imageUrl) {
            console.warn('⚠️ 生成画像URLが取得できませんでした');
        } else {
            console.warn('⚠️ ImageDisplayExtension が見つかりません。先にロードされているか確認してください。');
        }

        // 4) 保存＆再描画
        await saveChat();
        printMessages();
    });

    console.log('✅ Generate Image Controller: アクティベート完了');
}
