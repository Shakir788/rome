document.addEventListener('DOMContentLoaded', () => {
    // --- 1. Global State & Initialization ---
    let currentChatId = null; 
    let chats = []; 
    let isRecording = false; 
    let mediaRecorder = null; 
    let audioChunks = []; 

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
    const toolsBtnIcon = toolsBtn.querySelector('.material-symbols-outlined'); 

    const ROME_AVATAR = '/static/assets/rome_logo.png';
    const USER_AVATAR = 'https://cdn-icons-png.flaticon.com/512/149/149071.png';

    // --- NEW: Context Menu (For Delete) ---
    const contextMenuId = 'history-context-menu';
    const body = document.body;

    // --- 3. Utility Functions ---
    
    function scrollToBottom() {
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    function renderMessage(role, content, shouldScroll = true) {
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
        const formattedContent = content
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
        contentDiv.innerHTML = formattedContent; 

        messageContainer.appendChild(avatarImg);
        messageContainer.appendChild(contentDiv);
        
        chatWindow.appendChild(messageContainer);
        
        if (shouldScroll) {
            scrollToBottom(); 
        }
    }

    /** Clears chat window and loads messages for the given chat ID. */
    function loadChat(chatId) {
        const selectedChat = chats.find(c => c.id === chatId);
        if (!selectedChat) {
            // After deletion, if active chat is deleted, load the latest chat
            if (chats.length > 0) {
                 loadChat(chats[chats.length - 1].id);
            } else {
                 // If no chats remain, start a new one (click the New Chat button)
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
        chatHeaderTitle.textContent = selectedChat.title;
        chatWindow.innerHTML = ''; 

        document.querySelectorAll('.history-item').forEach(item => {
            item.classList.remove('active');
        });

        const activeItem = document.querySelector(`.history-item[data-chat-id="${chatId}"]`);
        if (activeItem) {
            activeItem.classList.add('active');
        }

        selectedChat.messages.forEach(msg => {
            renderMessage(msg.role, msg.content, false); 
        });

        scrollToBottom(); 
    }

    /** Fetches and renders the list of chats in the sidebar. */
    function renderChatHistory() {
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
            
            // --- NEW: Add Context Menu Listener ---
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

    // --- NEW: Context Menu Functions ---

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
        
        // Prevent menu from going off-screen (basic check)
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        menu.style.left = `${x > screenWidth - 200 ? screenWidth - 200 : x}px`;
        menu.style.top = `${y > screenHeight - 100 ? screenHeight - 100 : y}px`;
        
        // Add Delete Option
        menu.innerHTML = `
            <div class="menu-item delete-option" data-chat-id="${chatId}">
                <span class="material-symbols-outlined">delete</span>
                Delete Chat
            </div>
        `;
        
        body.appendChild(menu);

        // Add Listener to Delete Option
        document.querySelector('.delete-option').addEventListener('click', async (e) => {
            e.stopPropagation(); // Stop propagation to prevent context menu close click
            removeContextMenu();
            const confirmed = confirm(`Are you sure you want to delete "${chats.find(c => c.id === chatId)?.title || 'this chat'}" permanently?`);
            if (confirmed) {
                await deleteChat(chatId);
            }
        });
    }

    document.addEventListener('click', removeContextMenu);
    document.addEventListener('scroll', removeContextMenu);

    // --- NEW: Delete Chat Logic ---
    async function deleteChat(chatId) {
        try {
            const response = await fetch('/api/chat/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId })
            });

            const data = await response.json();

            if (data.success) {
                // Remove chat from local array
                chats = chats.filter(c => c.id !== chatId);
                
                // Re-render history
                renderChatHistory();
                
                // If the deleted chat was the active one, load the latest chat
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


    // --- 4. Core Chat Logic (Remains the same) ---

    async function sendMessage(messageFromAudio = null) {
        const message = messageFromAudio || userInput.value.trim();
        if (message === "" || currentChatId === null) return;
        
        if (!messageFromAudio) {
            renderMessage('user', message);
            userInput.value = ''; 
        } else if (!messageFromAudio.startsWith('🎤 (Voice):')) {
            renderMessage('user', `🎤 (Voice): ${messageFromAudio}`);
        }

        const messageToSend = message;
        sendBtn.disabled = true;

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: messageToSend, chat_id: currentChatId })
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
                    chatHeaderTitle.textContent = updatedChat.title;
                    renderChatHistory(); 
                }
            }
        } catch (error) {
            renderMessage('assistant', `[Network Error]: **Failed to connect to backend.**`);
            console.error('Fetch error:', error);
        } finally {
            sendBtn.disabled = false;
        }
    }

    // --- 5. Core Voice Logic (Remains the same) ---
    async function toggleRecording() {
        toolsPopover.classList.add('hidden'); 
        
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
                    
                    toolsBtnIcon.textContent = 'add'; 
                    voiceChatOption.innerHTML = '<span class="material-symbols-outlined">mic</span> Voice Chat (Record)';
                };

                mediaRecorder.start();
                isRecording = true;
                
                toolsBtnIcon.textContent = 'stop_circle'; 
                voiceChatOption.innerHTML = '<span class="material-symbols-outlined" style="color: red;">stop_circle</span> Stop Recording';
                renderMessage('assistant', "🎙️ **Recording started.** Speak now...");
            
            } catch (err) {
                console.error("Microphone access failed:", err);
                renderMessage('assistant', "🚫 **Microphone Error:** Could not access microphone. Check browser permissions.");
                isRecording = false;
                toolsBtnIcon.textContent = 'add';
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

    // --- 6. Event Listeners (Added Context Menu Listeners) ---
    sendBtn.addEventListener('click', () => sendMessage());

    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); 
            sendMessage();
        }
    });

    toolsBtn.addEventListener('click', (e) => {
        e.stopPropagation(); 
        toolsPopover.classList.toggle('hidden'); 
    });

    document.addEventListener('click', (e) => {
        if (!toolsPopover.contains(e.target) && !toolsBtn.contains(e.target)) {
            toolsPopover.classList.add('hidden');
        }
    });

    newChatBtn.addEventListener('click', () => {
        const newId = Date.now();
        const newChat = { id: newId, title: "New Chat", messages: [] }; 
        chats.push(newChat);
        renderChatHistory();
        loadChat(newId);
        userInput.focus(); 
    });

    voiceChatOption.addEventListener('click', toggleRecording);
    
    // --- 7. Initialization ---
    async function init() {
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
            userInput.focus(); 
        } catch (error) {
            console.error("Initialization failed:", error);
            chatHeaderTitle.textContent = "Initialization Error";
            renderMessage('assistant', "**Could not load chat history from the backend API.** Please check if `app.py` is running.");
        }
    }

    init();
});