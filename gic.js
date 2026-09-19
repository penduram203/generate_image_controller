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

        // chat_metadata.hidden_messages を初期化
        if (!Array.isArray(context.chat_metadata.hidden_messages)) {
            context.chat_metadata.hidden_messages = [];
        }

        // インデックスを文字列として追加（SillyTavernの内部仕様に合わせる）
        const indexStr = String(index);
        if (!context.chat_metadata.hidden_messages.includes(indexStr)) {
            context.chat_metadata.hidden_messages.push(indexStr);
        }

        await saveChat();
        printMessages();
    });
}
