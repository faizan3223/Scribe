const workerURL = "https://scribe-backend.mworkspace123.workers.dev";

const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');

// Change send button color on typing
userInput.addEventListener('input', () => {
    if (userInput.value.trim() !== '') {
        sendBtn.classList.remove('bg-gray-100', 'text-gray-300');
        sendBtn.classList.add('bg-[#cc6b49]', 'text-white');
    } else {
        sendBtn.classList.add('bg-gray-100', 'text-gray-300');
        sendBtn.classList.remove('bg-[#cc6b49]', 'text-white');
    }
});

function showError(message) {
    const errorHtml = `
        <div class="flex items-center gap-2 text-red-600 text-sm p-2">
            <span>⚠️</span>
            <span>${message}</span>
        </div>
    `;
    chatContainer.insertAdjacentHTML('beforeend', errorHtml);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    // 1. Append User Message
    const userHtml = `
        <div class="flex gap-4 max-w-2xl ml-auto bg-[#f0ede4] p-4 rounded-2xl">
            <div class="text-[15px] leading-relaxed text-[#191919]">${text}</div>
        </div>
    `;
    chatContainer.insertAdjacentHTML('beforeend', userHtml);
    userInput.value = '';
    sendBtn.classList.add('bg-gray-100', 'text-gray-300');
    sendBtn.classList.remove('bg-[#cc6b49]', 'text-white');
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // 2. Fetch Response from Backend (streamed via Cloudflare Worker)
    try {
        const response = await fetch(`${workerURL}/api/ask-question`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: text })
        });

        if (!response.ok) throw new Error("Server rejected request");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aiResponseText = "";

        // Ek khaali AI bubble create karo jise hum live update karenge
        const aiWrapperId = `ai-msg-${Date.now()}`;
        const aiHtml = `
            <div class="flex gap-4 max-w-2xl">
                <div class="w-8 h-8 rounded-full bg-[#cc6b49] flex items-center justify-center text-white text-xs shrink-0 font-bold">S</div>
                <div id="${aiWrapperId}" class="text-[15px] leading-relaxed text-[#191919]"></div>
            </div>
        `;
        chatContainer.insertAdjacentHTML('beforeend', aiHtml);
        const aiTextEl = document.getElementById(aiWrapperId);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const dataStr = line.slice(6).trim();
                    if (dataStr === "[DONE]") break;

                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.text) {
                            aiResponseText += parsed.text;
                            aiTextEl.textContent = aiResponseText;
                            chatContainer.scrollTop = chatContainer.scrollHeight;
                        }
                    } catch (e) {
                        console.error("Chunk parse error:", e);
                    }
                }
            }
        }
    } catch (error) {
        console.error("Fetch Connection Error:", error);
        showError("Connection lost with Groq background server.");
    }
}

sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
