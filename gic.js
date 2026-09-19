import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

// 画像生成メッセージかどうかを判定
function isImageGenerationMessage(message) {
    if (!message) return false;
    // extra.media に source: "generated" の要素があるか
    return Array.isArray(message.extra?.media) &&
           message.extra.media.some(m => m.source === 'generated');
}

// チャットからメッセージを削除してUIを更新
async function removeMessageFromChat(index) {
    const context = getContext();
    context.chat.splice(index, 1);
    await saveChat();
    printMessages();
}

// メッセージ受信時にフック
eventSource.on(event_types.MESSAGE_RECEIVED, async (index) => {
    const context = getContext();
    const message = context.chat[index];
    if (isImageGenerationMessage(message)) {
        await removeMessageFromChat(index);
    }
});
