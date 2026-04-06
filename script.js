const config = window.APP_CONFIG || {
    WEBHOOK_URL: 'https://n8nwebhook.bukamdotcom.click/webhook/c751b7eb-8ee8-4b2a-9520-cc81319af756',
    REQUEST_TIMEOUT_MS: 0,
    STORAGE_KEY: 'chatHistoryDirectWebhook'
};

let currentChatId;
let isSending = false;

const RESPONSE_KEYS = [
    'output',
    'response',
    'reply',
    'answer',
    'text',
    'content',
    'message',
    'result',
    'data'
];

// DOM elements
const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const sendButton = document.getElementById('send-button');
const typingIndicator = document.querySelector('.typing-indicator');
const chatHistory = document.getElementById('chat-history');
const newChatButton = document.getElementById('new-chat-button');
const toggleSidebarButton = document.getElementById('toggle-sidebar');
const sidebar = document.querySelector('.sidebar');

function loadChatHistory() {
    try {
        const rawChatHistory = localStorage.getItem(config.STORAGE_KEY || 'chatHistoryDirectWebhook');

        if (!rawChatHistory) {
            return {};
        }

        const parsedChatHistory = JSON.parse(rawChatHistory);

        if (
            !parsedChatHistory ||
            typeof parsedChatHistory !== 'object' ||
            Array.isArray(parsedChatHistory)
        ) {
            return {};
        }

        const normalizedChatHistory = {};

        Object.entries(parsedChatHistory).forEach(([chatId, chat]) => {
            if (!chat || typeof chat !== 'object') {
                return;
            }

            const messages = Array.isArray(chat.messages)
                ? chat.messages
                    .filter(message => message && typeof message.content === 'string')
                    .map(message => ({
                        role: message.role === 'user' ? 'user' : 'bot',
                        content: message.content
                    }))
                : [];

            normalizedChatHistory[chatId] = {
                title: typeof chat.title === 'string' && chat.title.trim()
                    ? chat.title.trim()
                    : 'New Chat',
                messages
            };
        });

        return normalizedChatHistory;
    } catch (error) {
        console.warn('Unable to load chat history from localStorage:', error);
        return {};
    }
}

// Load chat history from localStorage
const chatHistoryData = loadChatHistory();

// Add sidebar toggle functionality
toggleSidebarButton.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
});

function isMobileViewport() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function closeSidebarOnMobile() {
    if (isMobileViewport()) {
        sidebar.classList.remove('collapsed');
    }
}

document.addEventListener('click', event => {
    if (!isMobileViewport() || !sidebar.classList.contains('collapsed')) {
        return;
    }

    if (sidebar.contains(event.target) || toggleSidebarButton.contains(event.target)) {
        return;
    }

    sidebar.classList.remove('collapsed');
});

function saveToLocalStorage() {
    localStorage.setItem(config.STORAGE_KEY || 'chatHistoryDirectWebhook', JSON.stringify(chatHistoryData));
}

function syncSendButtonState() {
    sendButton.disabled = isSending || userInput.value.trim() === '';
}

function normalizeHistory(messages) {
    return messages.map(message => ({
        role: message.role === 'bot' ? 'assistant' : 'user',
        content: message.content
    }));
}

function buildWebhookPayload(userMessage) {
    const history = normalizeHistory(chatHistoryData[currentChatId].messages);

    return {
        chatId: currentChatId,
        sessionId: currentChatId,
        message: userMessage,
        prompt: userMessage,
        text: userMessage,
        history,
        messages: history,
        timestamp: new Date().toISOString()
    };
}

function getWebhookUrl() {
    return String(config.WEBHOOK_URL || '').trim();
}

function extractTextFromPayload(payload, depth = 0) {
    if (payload == null || depth > 6) {
        return '';
    }

    if (typeof payload === 'string') {
        return payload.trim();
    }

    if (typeof payload === 'number' || typeof payload === 'boolean') {
        return String(payload);
    }

    if (Array.isArray(payload)) {
        for (const item of payload) {
            const text = extractTextFromPayload(item, depth + 1);
            if (text) {
                return text;
            }
        }

        return '';
    }

    if (typeof payload === 'object') {
        if (
            payload.message &&
            typeof payload.message === 'object' &&
            typeof payload.message.content === 'string'
        ) {
            return payload.message.content.trim();
        }

        if (
            Array.isArray(payload.choices) &&
            payload.choices[0]?.message?.content
        ) {
            return String(payload.choices[0].message.content).trim();
        }

        for (const key of RESPONSE_KEYS) {
            if (!(key in payload)) {
                continue;
            }

            const text = extractTextFromPayload(payload[key], depth + 1);
            if (text) {
                return text;
            }
        }

        for (const value of Object.values(payload)) {
            const text = extractTextFromPayload(value, depth + 1);
            if (text) {
                return text;
            }
        }
    }

    return '';
}

async function requestChatApi(userMessage) {
    const webhookUrl = getWebhookUrl();

    if (!webhookUrl) {
        throw new Error('No webhook URL is configured in `config.js`.');
    }

    const requestBody = JSON.stringify(buildWebhookPayload(userMessage));

    const controller = new AbortController();
    const timeoutId = Number(config.REQUEST_TIMEOUT_MS) > 0
        ? setTimeout(() => controller.abort(), Number(config.REQUEST_TIMEOUT_MS))
        : null;

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*'
            },
            body: requestBody,
            signal: controller.signal
        });

        const rawBody = await response.text();
        const trimmedBody = rawBody.trim();

        if (!response.ok) {
            const error = new Error(
                trimmedBody || `Webhook request failed with status ${response.status}`
            );
            error.status = response.status;
            error.responseBody = trimmedBody;
            throw error;
        }

        if (!trimmedBody) {
            throw new Error('The webhook returned 200 OK but no response body.');
        }

        const contentType = response.headers.get('content-type') || '';
        const looksLikeJson =
            contentType.includes('application/json') ||
            /^[\[{"]/.test(trimmedBody);

        if (looksLikeJson) {
            try {
                const payload = JSON.parse(trimmedBody);
                const extractedText = extractTextFromPayload(payload);

                if (extractedText) {
                    return extractedText;
                }
            } catch (error) {
                console.warn('Response was not valid JSON:', error);
            }
        }

        return trimmedBody;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('The webhook request timed out. Increase `REQUEST_TIMEOUT_MS` or set it to `0` to disable the timeout.');
        }

        if (error instanceof TypeError) {
            throw new Error('Unable to reach the n8n webhook. If this app is hosted on GitHub Pages, make sure your webhook allows CORS from that site.');
        }

        throw error;
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

async function sendMessageToWebhook(userMessage) {
    return requestChatApi(userMessage);
}

function generateChatTitle(firstMessage) {
    const cleanedMessage = firstMessage
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s-]/g, '')
        .trim();

    if (!cleanedMessage) {
        return 'New Chat';
    }

    return cleanedMessage
        .split(' ')
        .slice(0, 4)
        .join(' ')
        .slice(0, 30) || 'New Chat';
}

// Initialize chat
function initChat(chatId = null) {
    chatContainer.innerHTML = '';

    if (!chatId) {
        chatId = Date.now().toString();
        chatHistoryData[chatId] = {
            title: 'New Chat',
            messages: []
        };
        saveToLocalStorage();
        addChatToSidebar(chatId);
    }

    currentChatId = chatId;

    if (chatHistoryData[chatId].messages.length > 0) {
        chatHistoryData[chatId].messages.forEach(message => {
            appendMessage(message.role, message.content);
        });
    } else {
        appendMessage('bot', "Hello! I'm connected directly to your n8n webhook. How can I help?");
    }

    updateActiveChatInSidebar();
    closeSidebarOnMobile();
}

// Add chat to sidebar
function addChatToSidebar(chatId) {
    const chatItem = document.createElement('div');
    chatItem.className = 'chat-history-item';
    chatItem.dataset.chatId = chatId;
    chatItem.innerHTML = `
        <div class="chat-item-content">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z"/>
            </svg>
            <span>${chatHistoryData[chatId].title}</span>
        </div>
        <button class="delete-chat-button" aria-label="Delete chat">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
        </button>
    `;

    const chatContent = chatItem.querySelector('.chat-item-content');
    chatContent.addEventListener('click', () => {
        initChat(chatId);
    });

    const deleteButton = chatItem.querySelector('.delete-chat-button');
    deleteButton.addEventListener('click', event => {
        event.stopPropagation();
        deleteChat(chatId);
    });

    chatHistory.insertBefore(chatItem, chatHistory.firstChild);
}

function deleteChat(chatId) {
    if (confirm('Are you sure you want to delete this chat?')) {
        const chatItem = document.querySelector(`.chat-history-item[data-chat-id="${chatId}"]`);
        if (chatItem) {
            chatItem.remove();
        }

        delete chatHistoryData[chatId];
        saveToLocalStorage();

        if (chatId === currentChatId) {
            initChat();
        }
    }
}

function updateActiveChatInSidebar() {
    document.querySelectorAll('.chat-history-item').forEach(item => {
        item.classList.toggle('active', item.dataset.chatId === currentChatId);
    });
}

function updateChatTitle() {
    const chatItem = document.querySelector(`.chat-history-item[data-chat-id="${currentChatId}"]`);
    if (chatItem) {
        chatItem.querySelector('span').textContent = chatHistoryData[currentChatId].title;
    }
}

// New function to convert simple markdown to HTML
function convertMarkdownToHTML(text) {
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    const lines = text.split('\n');
    const output = [];
    let inList = false;

    lines.forEach(line => {
        if (/^\s*\*\s+/.test(line)) {
            if (!inList) {
                output.push('<ul>');
                inList = true;
            }
            output.push('<li>' + line.replace(/^\s*\*\s+/, '') + '</li>');
        } else {
            if (inList) {
                output.push('</ul>');
                inList = false;
            }
            output.push(line);
        }
    });

    if (inList) {
        output.push('</ul>');
    }

    return output.join('\n');
}

// Function to append messages to the conversation
function appendMessage(role, text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}-message`;

    const avatar = document.createElement('div');
    avatar.className = `avatar ${role}-avatar`;
    avatar.textContent = role === 'bot' ? 'AI' : 'You';

    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';

    if (role === 'bot') {
        const formattedText = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, language, code) => {
            if (!language) {
                if (code.trim().match(/<[^>]+>/)) {
                    language = 'html';
                } else if (
                    code.includes('function') ||
                    code.includes('const') ||
                    code.includes('let') ||
                    code.includes('var')
                ) {
                    language = 'javascript';
                } else if (
                    code.includes('def ') ||
                    code.includes('import ') ||
                    code.includes('print(')
                ) {
                    language = 'python';
                } else {
                    language = 'plaintext';
                }
            }

            const languageMap = {
                js: 'javascript',
                py: 'python',
                html: 'markup',
                css: 'css',
                'c++': 'cpp',
                'c#': 'csharp',
                cs: 'csharp',
                rb: 'ruby',
                ts: 'typescript',
                sh: 'bash',
                shell: 'bash',
                txt: 'text',
                plaintext: 'text'
            };

            language = languageMap[language] || language || 'text';
            code = code.trim();

            const escapedCode = code
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            return `<pre><code class="language-${language}">${escapedCode}</code></pre>`;
        });

        let finalText = formattedText.replace(/`([^`]+)`/g, (match, code) => {
            const escapedCode = code
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            return `<code class="language-text">${escapedCode}</code>`;
        });

        finalText = convertMarkdownToHTML(finalText);
        messageContent.innerHTML = finalText;

        setTimeout(() => {
            if (window.Prism) {
                messageContent.querySelectorAll('pre code').forEach(block => {
                    if (!block.className.includes('language-')) {
                        block.className = 'language-text';
                    }
                    Prism.highlightElement(block);
                });

                messageContent.querySelectorAll('code:not(pre code)').forEach(block => {
                    if (!block.className.includes('language-')) {
                        block.className = 'language-text';
                    }
                    Prism.highlightElement(block);
                });
            }
        }, 0);
    } else {
        messageContent.textContent = text;
    }

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(messageContent);
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Handle send button click
async function handleMessage() {
    const userMessage = userInput.value.trim();
    if (!userMessage || isSending) {
        return;
    }

    isSending = true;
    appendMessage('user', userMessage);
    userInput.value = '';
    syncSendButtonState();

    chatHistoryData[currentChatId].messages.push({
        role: 'user',
        content: userMessage
    });

    typingIndicator.style.display = 'flex';

    try {
        const botMessage = await sendMessageToWebhook(userMessage);

        appendMessage('bot', botMessage);

        chatHistoryData[currentChatId].messages.push({
            role: 'bot',
            content: botMessage
        });

        if (chatHistoryData[currentChatId].messages.length === 2) {
            chatHistoryData[currentChatId].title = generateChatTitle(userMessage);
            updateChatTitle();
        }

        saveToLocalStorage();
    } catch (error) {
        console.error('Error:', error);
        appendMessage('bot', `Sorry, something went wrong: ${error.message}`);
    } finally {
        isSending = false;
        typingIndicator.style.display = 'none';
        syncSendButtonState();
        userInput.focus();
    }
}

async function submitCurrentMessage() {
    if (isSending || userInput.value.trim() === '') {
        return;
    }

    if (!currentChatId) {
        initChat();
    }

    await handleMessage();
}

// Event listeners
userInput.addEventListener('input', () => {
    if (!currentChatId && userInput.value.trim() !== '') {
        initChat();
    }

    syncSendButtonState();
});

sendButton.addEventListener('click', () => {
    submitCurrentMessage();
});

userInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitCurrentMessage();
    }
});

newChatButton.addEventListener('click', () => {
    initChat();
});

Object.keys(chatHistoryData).forEach(chatId => {
    addChatToSidebar(chatId);
});

initChat(Object.keys(chatHistoryData)[0] || null);
syncSendButtonState();
