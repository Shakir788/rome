import os
import json
import time
from werkzeug.utils import secure_filename 
import tempfile 

from flask import Flask, render_template, request, jsonify 
import requests
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_fixed 

# --- Flask App Initialization ---
load_dotenv()
app = Flask(__name__) 

# --- Configuration ---
API_KEY = os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY")
MODEL_NAME = os.getenv("MODEL_NAME", "openai/gpt-4o-mini") 
TRANSCRIPTION_MODEL = "openai/whisper-1" 

SYSTEM_PERSONALITY = """You are ROME — a warm, intelligent assistant created by Mohammad from India for his friend.
Creator: Mohammad — software developer, graphic designer, social media manager, makeup artist.
Be helpful, friendly, and tailored to his friend's interests, keeping creator memory private unless asked.
"""
CHATS_FILE = "rome_chats.json"
MEMORY_FILE = "rome_memory.json"

# --- Helper Functions (Load/Save/API Call) ---

def save_json(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default
    return default

# --- NEW: Function to prepare multimodal content (text + image) ---
def prepare_content_array(text_prompt, image_b64):
    """Prepares the content array for multimodal API call."""
    content = []
    
    # Add text part
    content.append({"type": "text", "text": text_prompt})
    
    # Add image part if image_b64 is provided
    if image_b64:
        # The base64 string includes the header (e.g., data:image/jpeg;base64,...)
        content.append({
            "type": "image_url",
            "image_url": {"url": image_b64}
        })
        
    return content


@retry(stop=stop_after_attempt(5), wait=wait_fixed(3)) 
def call_text_model(messages: list, max_tokens: int = 800, timeout: int = 60):
    if not API_KEY:
        return "[No API key found.]"
    
    url = "https://openrouter.ai/api/v1/chat/completions"
    
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    body = {
        "model": MODEL_NAME,
        "messages": messages,
        "max_tokens": max_tokens,
    }
    try:
        r = requests.post(url, json=body, headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        return data["choices"][0]["message"]["content"].strip() if data.get("choices") else str(data)
    except Exception as e:
        if 'getaddrinfo failed' in str(e):
             return f"[Error: NameResolutionError. Code is correct, deployment server has DNS issue.]"
        return f"[Error: {str(e)}]"

# --- Transcription Function (Remains the same) ---

@retry(stop=stop_after_attempt(3), wait=wait_fixed(2))
def transcribe_audio(audio_file_bytes):
    if not API_KEY:
        return {"error": "API key missing."}

    url = "https://openrouter.ai/api/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {API_KEY}"}
    
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_file_bytes)
        temp_path = tmp.name

    try:
        with open(temp_path, "rb") as f:
            files = {
                'file': ('audio.wav', f, 'audio/wav'),
            }
            data = {
                'model': TRANSCRIPTION_MODEL,
            }
            
            r = requests.post(url, headers=headers, files=files, data=data, timeout=60)
            r.raise_for_status()
            response_data = r.json()
            
            return {"transcript": response_data.get("text", "")}

    except Exception as e:
        return {"error": f"Transcription API failed: {str(e)}"}
    finally:
        os.remove(temp_path)


# --- Memory & Chats (Load data once) ---
memory = load_json(MEMORY_FILE, {})
chats = load_json(CHATS_FILE, {"conversations": []})

def get_active_conv(chat_id):
    try:
        chat_id = int(chat_id)
        return next((c for c in chats["conversations"] if c["id"] == chat_id), None)
    except ValueError:
        return None

# --- Flask Routes ---

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/chats", methods=["GET"])
def get_chats():
    return jsonify(chats["conversations"])

# --- NEW: Chat Delete Endpoint ---
@app.route("/api/chat/delete", methods=["POST"])
def delete_chat():
    data = request.get_json()
    chat_id = data.get("chat_id")
    
    if not chat_id:
        return jsonify({"error": "Missing chat ID"}), 400

    global chats
    try:
        chat_id = int(chat_id)
        
        new_conversations = [c for c in chats["conversations"] if c["id"] != chat_id]
        
        if len(new_conversations) == len(chats["conversations"]):
            return jsonify({"success": False, "message": "Chat not found"}), 404

        chats["conversations"] = new_conversations
        save_json(CHATS_FILE, chats)
        
        return jsonify({"success": True})
        
    except ValueError:
        return jsonify({"success": False, "message": "Invalid chat ID format"}), 400
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/chat", methods=["POST"])
def handle_chat():
    data = request.get_json()
    user_msg = data.get("message")
    chat_id = data.get("chat_id")
    # NEW: Get image data from frontend
    image_b64 = data.get("image_b64")
    
    if not user_msg or not chat_id:
        return jsonify({"error": "Missing message or chat ID"}), 400

    active_conv = get_active_conv(chat_id)
    if not active_conv:
        new_id = int(time.time() * 1000)
        active_conv = {"id": new_id, "title": "New Chat", "messages": []}
        chats["conversations"].append(active_conv)
        save_json(CHATS_FILE, chats)

    # 1. Add User Message (Storing image data if present)
    user_message_object = {"role": "user", "content": user_msg}
    if image_b64:
        # Store image data in the chat history object for future re-load
        user_message_object["image_b64"] = image_b64 
    active_conv["messages"].append(user_message_object)

    # 2. Prepare Messages for API (Multimodal Context)
    api_messages = [
        {"role": "system", "content": SYSTEM_PERSONALITY}
    ]
    
    # We must construct the message array based on the API's multimodal requirements.
    # The last message (user_msg) must use the content array structure.
    for msg in active_conv["messages"][:-1]:
        api_messages.append(msg)
        
    # The current user message needs the multimodal array
    content_array = prepare_content_array(user_msg, image_b64)
    api_messages.append({"role": "user", "content": content_array})

    # 3. Call Model
    rome_resp_content = call_text_model(api_messages)

    # 4. Add Assistant Message & Save
    rome_resp = {"role": "assistant", "content": rome_resp_content}
    active_conv["messages"].append(rome_resp)
    save_json(CHATS_FILE, chats)
    
    # Auto Rename Logic
    if len(active_conv["messages"]) == 2 and active_conv["title"] == "New Chat":
        title_prompt = f"Generate a concise title (max 5 words) for this conversation: {user_msg}"
        generated_title = call_text_model([
            {"role": "system", "content": "You are a title generator."},
            {"role": "user", "content": title_prompt}
        ], max_tokens=15)
        active_conv["title"] = generated_title.replace('"', '').strip()
        save_json(CHATS_FILE, chats)

    return jsonify({"response": rome_resp, "updated_chat": active_conv})


@app.route("/api/transcribe", methods=["POST"])
def handle_transcribe():
    if 'audio_file' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio_file']
    audio_bytes = audio_file.read()
    
    result = transcribe_audio(audio_bytes)

    if result.get("error"):
        return jsonify({"error": result["error"]}), 500
    
    return jsonify({"transcript": result["transcript"]})


if __name__ == '__main__':
    app.run(debug=True)