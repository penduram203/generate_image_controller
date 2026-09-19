import { eventSource, event_types, saveChat, printMessages } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

function isGeneratedImageMessage(message) {
    return Array.isArray(message?.extra?.media) &&
           message.extra.media.some(m => m.source === 'generated');
}

export async function activate() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async (index) => {
        const context = getContext();
        const message = context.chat[index];

        if (!isGeneratedImageMessage(message)) return;

        // このメッセージをAIから隠す（ghostアイコンが付く状態にする）
        message.is_system = true;

        // 変更を保存し、UIを更新
        await saveChat();
        printMessages();
    });
}
