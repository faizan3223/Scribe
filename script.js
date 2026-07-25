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

    // 2. Fetch Response from Backend
    try {
        const response = await fetch('/api/chat', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });
        const data = await response.json();
        
        // 3. Append AI Response
        const aiHtml = `
            <div class="flex gap-4 max-w-2xl">
                <div class="w-8 h-8 rounded-full bg-[#cc6b49] flex items-center justify-center text-white text-xs shrink-0 font-bold">S</div>
                <div class="text-[15px] leading-relaxed text-[#191919]">${data.reply || data.message || "No response"}</div>
            </div>
        `;
        chatContainer.insertAdjacentHTML('beforeend', aiHtml);
        chatContainer.scrollTop = chatContainer.scrollHeight;

    } catch (error) {
        console.error("Error:", error);
    }
}
