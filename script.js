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

        // 2. Fetch Response from Backend (Updated for Stream & Cloudflare)
        try {
            // Note: '/api/chat' ki jagah sahi endpoint '/api/ask-question' use kiya hai aur workerURL lagaya hai
            const response = await fetch(`${workerURL}/api/ask-question`, { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: text }) // backend 'question' expect kar raha hai
            });
    
            if (!response.ok) throw new Error("Server rejected request");
    
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let aiResponseText = "";
    
            // Scribe container ya dynamic append ke liye pehle ek khali message element create karlein 
            // Agar aapke paas 'appendMessage' ya 'addChatBubble' ka function hai to use pehle call karein
            // Yeh line sirf placeholder hai, agar error aaye to ise mita dena:
            // let messageElement = createChatBubble('scribe', ''); 
    
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
                                
                                // ZAROORI NOTE: Apne screen par live text dikhane ke liye niche wala function update karein
                                // Agar aapke function ka naam alag hai (jaise updateChatBox), to woh naam likhein:
                                updateChatUI('scribe', aiResponseText); 
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
    
        // 3. Append AI Response
      
        // 2. Fetch Response from Backend (Sahi Bracket Structure)
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
    
            // Chat container clear/update logic
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
    
                                // Live text container build and render update
                                const aiHtml = `
                                    <div class="flex gap-4 max-w-2xl">
                                        <div class="w-8 h-8 rounded-full bg-[#cc6b49] flex items-center justify-center text-white text-xs shrink-0 font-bold">S</div>
                                        <div class="text-[15px] leading-relaxed text-[#191919]">${aiResponseText}</div>
                                    </div>
                                `;
                                
                                // Purana live-updated text mita kar naya show karne ke liye logic (ya directly render append)
                                chatContainer.insertAdjacentHTML('beforeend', aiHtml);
                                chatContainer.scrollTop = chatContainer.scrollHeight;
                            }
                        } catch (e) {
                            console.error("Chunk parse error:", e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error:", error);
        }
    }
    
