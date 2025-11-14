document.addEventListener('DOMContentLoaded', () => {
    // --- 1. Global State & Initialization ---
    let currentChatId = null; 
    let chats = []; 
    let isRecording = false; 
    let mediaRecorder = null; 
    let audioChunks = []; 
    let uploadedImageBase64 = null; 

    // --- 2. Element Selectors ---
    const chatWindow = document.getElementById('chat-window');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const newChatBtn = document.getElementById('new-chat-btn');
    const chatHistoryContainer = document.getElementById('chat-history');
    const chatHeaderTitle = document.querySelector('#chat-header h1');
    
    // Tools Popover Selectors
    const toolsBtn = document.getElementById('tools-btn');
    const toolsPopover = document.getElementById('tools-popover');
    const voiceChatOption = document.getElementById('voice-chat-option'); 
    const toolsBtnIcon = toolsBtn ? toolsBtn.querySelector('.material-symbols-outlined') : null; 
    const imageUploadInput = document.getElementById('image-upload-input');

    const ROME_AVATAR = '/static/assets/rome_logo.png';
    const USER_AVATAR = 'https://cdn-icons-png.flaticon.com/512/149/149071.png';

    // --- Context Menu Setup ---
    const contextMenuId = 'history-context-menu';
    const body = document.body;

    // --- 3. Utility Functions ---
    
    function scrollToBottom() {
        if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    function renderMessage(role, content, shouldScroll = true, imageBase64 = null) {
        if (!chatWindow) return; // Basic check

        const avatarSrc = (role === 'assistant') ? ROME_AVATAR : USER_AVATAR;

        const messageContainer = document.createElement('div');
        messageContainer.classList.add('message');
        messageContainer.classList.add(`${role}-message`);

        const avatarImg = document.createElement('img');
        avatarImg.classList.add('avatar');
        avatarImg.src = avatarSrc;
        avatarImg.alt = role;

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('content');
        
        // Render Image if available
        if (imageBase64) {
            const imgEl = document.createElement('img');
            imgEl.src = imageBase64;
            imgEl.classList.add('uploaded-image-preview');
            imgEl.style.maxWidth = '200px'; 
            imgEl.style.borderRadius = '8px';
            imgEl.style.marginBottom = '10px';
            contentDiv.appendChild(imgEl);
            contentDiv.appendChild(document.createElement('br'));
        }

        const formattedContent = content
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
        
        contentDiv.innerHTML += formattedContent; 

        messageContainer.appendChild(avatarImg);
        messageContainer.appendChild(contentDiv);
        
        chatWindow.appendChild(messageContainer);
        
        if (shouldScroll) {
            scrollToBottom(); 
        }
    }

    // --- (loadChat, renderChatHistory, Context Menu Functions - Remainder of code) ---
    function loadChat(chatId) {
        const selectedChat = chats.find(c => c.id === chatId);
        if (!selectedChat) {
            if (chats.length > 0) {
                 loadChat(chats[chats.length - 1].id);
            } else {
                 const newId = Date.now();
                 const newChat = { id: newId, title: "New Chat", messages: [] }; 
                 chats.push(newChat);
                 renderChatHistory();
                 loadChat(newId);
                 return;
            }
            return;
        }

        currentChatId = chatId;
        if (chatHeaderTitle) chatHeaderTitle.textContent = selectedChat.title;
        if (chatWindow) chatWindow.innerHTML = ''; 

        document.querySelectorAll('.history-item').forEach(item => {
            item.classList.remove('active');
        });

        const activeItem = document.querySelector(`.history-item[data-chat-id="${chatId}"]`);
        if (activeItem) {
            activeItem.classList.add('active');
        }

        selectedChat.messages.forEach(msg => {
            renderMessage(msg.role, msg.content, false, msg.image_b64); 
        });

        scrollToBottom(); 
    }

    function renderChatHistory() {
        if (!chatHistoryContainer) return;

        const historyLabel = chatHistoryContainer.querySelector('.history-label');
        let nextSibling = historyLabel ? historyLabel.nextSibling : chatHistoryContainer.firstChild;
        while (nextSibling) {
            let temp = nextSibling.nextSibling;
            if (nextSibling.classList && nextSibling.classList.contains('history-item')) {
                nextSibling.remove();
            }
            nextSibling = temp;
        }

        const recentChats = chats.slice(-10).reverse(); 

        recentChats.forEach(chat => {
            const itemDiv = document.createElement('div');
            itemDiv.classList.add('history-item');
            itemDiv.setAttribute('data-chat-id', chat.id);
            itemDiv.textContent = chat.title;
            
            itemDiv.addEventListener('click', () => loadChat(chat.id));
            
            itemDiv.addEventListener('contextmenu', (e) => {
                e.preventDefault(); 
                showContextMenu(e.clientX, e.clientY, chat.id);
            });
            
            chatHistoryContainer.appendChild(itemDiv);
        });

        if (currentChatId) {
            const activeItem = document.querySelector(`.history-item[data-chat-id="${currentChatId}"]`);
            if (activeItem) {
                activeItem.classList.add('active');
            }
        }
    }

    function removeContextMenu() {
        const menu = document.getElementById(contextMenuId);
        if (menu) {
            menu.remove();
        }
    }

    function showContextMenu(x, y, chatId) {
        removeContextMenu(); 

        const menu = document.createElement('div');
        menu.id = contextMenuId;
        menu.classList.add('context-menu');
        
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        menu.style.left = `${x > screenWidth - 200 ? screenWidth - 200 : x}px`;
        menu.style.top = `${y > screenHeight - 100 ? screenHeight - 100 : y}px`;
        
        menu.innerHTML = `
            <div class="menu-item delete-option" data-chat-id="${chatId}">
                <span class="material-symbols-outlined">delete</span>
                Delete Chat
            </div>
        `;
        
        body.appendChild(menu);

        document.querySelector('.delete-option').addEventListener('click', async (e) => {
            e.stopPropagation(); 
            removeContextMenu();
            const confirmed = confirm(`Are you sure you want to delete "${chats.find(c => c.id === chatId)?.title || 'this chat'}" permanently?`);
            if (confirmed) {
                await deleteChat(chatId);
            }
        });
    }

    document.addEventListener('click', removeContextMenu);
    document.addEventListener('scroll', removeContextMenu);

    async function deleteChat(chatId) {
        try {
            const response = await fetch('/api/chat/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId })
            });

            const data = await response.json();

            if (data.success) {
                chats = chats.filter(c => c.id !== chatId);
                renderChatHistory();
                
                if (currentChatId === chatId) {
                    loadChat(chats.length > 0 ? chats[chats.length - 1].id : null);
                }
            } else {
                renderMessage('assistant', `[ERROR]: **Failed to delete chat: ${data.message}**`);
            }

        } catch (error) {
            renderMessage('assistant', `[Network Error]: **Failed to reach delete API.**`);
            console.error('Delete fetch error:', error);
        }
    }


    // --- 4. Core Chat Logic ---

    async function sendMessage(messageFromAudio = null) {
        let message = messageFromAudio || userInput.value.trim();
        let imageB64 = uploadedImageBase64; 

        if (message === "" && !imageB64 || currentChatId === null) return;
        
        // If image is uploaded but no text, use a default prompt
        if (message === "" && imageB64) {
             message = "Please analyze this image and provide a detailed description.";
        }
        
        // Render user message with image preview
        if (!messageFromAudio) {
            renderMessage('user', message, true, imageB64);
            if (userInput) userInput.value = ''; 
        } else if (!messageFromAudio.startsWith('🎤 (Voice):')) {
            renderMessage('user', `🎤 (Voice): ${messageFromAudio}`);
        }

        const messageToSend = message;
        if (sendBtn) sendBtn.disabled = true;
        
        // Clear state variables for next message
        uploadedImageBase64 = null;
        if (imageUploadInput) imageUploadInput.value = '';
        if (userInput && imageB64) {
            userInput.placeholder = "Type your message here...";
        }

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    message: messageToSend, 
                    chat_id: currentChatId,
                    image_b64: imageB64 
                })
            });

            const data = await response.json();

            if (!response.ok || data.error || data.response.content.startsWith('[Error:')) {
                const errorContent = data.error || data.response.content || `HTTP Error ${response.status}`;
                renderMessage('assistant', `[API Error]: **${errorContent}**`);
            } else {
                renderMessage('assistant', data.response.content);
                
                const updatedChat = data.updated_chat;
                const index = chats.findIndex(c => c.id === updatedChat.id);
                if (index !== -1) {
                    chats[index] = updatedChat;
                }
                
                if (updatedChat.title !== chatHeaderTitle.textContent) {
                    if (chatHeaderTitle) chatHeaderTitle.textContent = updatedChat.title;
                    renderChatHistory(); 
                }
            }
        } catch (error) {
            renderMessage('assistant', `[Network Error]: **Failed to connect to backend.**`);
            console.error('Fetch error:', error);
        } finally {
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    // --- NEW: Image Upload Handler ---
    if (imageUploadInput) {
        imageUploadInput.addEventListener('change', (event) => {
            if (toolsPopover) toolsPopover.classList.add('hidden'); 
            const file = event.target.files[0];

            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    uploadedImageBase64 = e.target.result;
                    if (userInput) userInput.placeholder = `Image uploaded (${file.name}). Add a message or press send.`;
                    if (userInput) userInput.focus();
                };
                reader.readAsDataURL(file);
            }
        });
    }

    // --- 5. Core Voice Logic (Same as previous step) ---
    async function toggleRecording() {
        if (toolsPopover) toolsPopover.classList.add('hidden'); 
        
        // ... (rest of the voice logic remains the same)
        if (!isRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/wav' });
                audioChunks = []; 

                mediaRecorder.ondataavailable = event => {
                    audioChunks.push(event.data);
                };

                mediaRecorder.onstop = async () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
                    stream.getTracks().forEach(track => track.stop());
                    await sendAudioForTranscription(audioBlob); 
                    
                    if (toolsBtnIcon) toolsBtnIcon.textContent = 'add'; 
                    if (voiceChatOption) voiceChatOption.innerHTML = '<span class="material-symbols-outlined">mic</span> Voice Chat (Record)';
                };

                mediaRecorder.start();
                isRecording = true;
                
                if (toolsBtnIcon) toolsBtnIcon.textContent = 'stop_circle'; 
                if (voiceChatOption) voiceChatOption.innerHTML = '<span class="material-symbols-outlined" style="color: red;">stop_circle</span> Stop Recording';
                renderMessage('assistant', "🎙️ **Recording started.** Speak now...");
            
            } catch (err) {
                console.error("Microphone access failed:", err);
                renderMessage('assistant', "🚫 **Microphone Error:** Could not access microphone. Check browser permissions.");
                isRecording = false;
                if (toolsBtnIcon) toolsBtnIcon.textContent = 'add';
            }

        } else {
            mediaRecorder.stop();
            isRecording = false;
            renderMessage('assistant', "🎧 **Recording stopped.** Transcribing audio...");
        }
    }

    async function sendAudioForTranscription(audioBlob) {
        const formData = new FormData();
        formData.append('audio_file', audioBlob, 'voice_message.wav');
        formData.append('chat_id', currentChatId);

        try {
            const response = await fetch('/api/transcribe', {
                method: 'POST',
                body: formData 
            });

            const data = await response.json();

            if (data.error || !data.transcript) {
                renderMessage('assistant', `🗣️ **Transcription Failed:** ${data.error || "Could not understand audio."}`);
            } else {
                await sendMessage(data.transcript); 
            }

        } catch (error) {
            renderMessage('assistant', `[Network Error]: **Failed to reach transcription API.**`);
            console.error('Transcription fetch error:', error);
        }
    }

    // --- 6. Event Listeners ---
    if (sendBtn) sendBtn.addEventListener('click', () => sendMessage());

    if (userInput) {
        userInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); 
                sendMessage();
            }
        });
    }

    if (toolsBtn) {
        toolsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); 
            if (toolsPopover) toolsPopover.classList.toggle('hidden'); 
        });
    }

    document.addEventListener('click', (e) => {
        if (toolsPopover && toolsBtn && !toolsPopover.contains(e.target) && !toolsBtn.contains(e.target)) {
            toolsPopover.classList.add('hidden');
        }
    });

    if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
            const newId = Date.now();
            const newChat = { id: newId, title: "New Chat", messages: [] }; 
            chats.push(newChat);
            renderChatHistory();
            loadChat(newId);
            if (userInput) userInput.focus(); 
        });
    }

    if (voiceChatOption) voiceChatOption.addEventListener('click', toggleRecording);
    
    // --- 7. Initialization ---
    async function init() {
        // ... (rest of the init logic remains the same)
        try {
            const response = await fetch('/api/chats');
            const data = await response.json();
            
            chats = data;

            if (chats.length > 0) {
                const latestChat = chats[chats.length - 1];
                currentChatId = latestChat.id;
                
                renderChatHistory();
                loadChat(currentChatId);
            } else {
                const welcomeId = Date.now();
                const welcomeChat = { 
                    id: welcomeId, 
                    title: "Welcome", 
                    messages: [{
                        role: "assistant", 
                        content: "Hello! I am ROME, an intelligent assistant created by Mohammad. How can I help you today?"
                    }] 
                };
                chats.push(welcomeChat);
                renderChatHistory();
                loadChat(welcomeId);
            }
            if (userInput) userInput.focus(); 
        } catch (error) {
            console.error("Initialization failed:", error);
            if (chatHeaderTitle) chatHeaderTitle.textContent = "Initialization Error";
            renderMessage('assistant', "**Could not load chat history from the backend API.** Please check if `app.py` is running.");
        }
    }

    init();
});