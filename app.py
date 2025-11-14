import os
import json
import time
import base64
import tempfile
import asyncio
from io import BytesIO
from werkzeug.utils import secure_filename

from flask import Flask, render_template, request, jsonify, send_from_directory, url_for
import requests
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_fixed

# Optional TTS libs
try:
    import edge_tts
    EDGE_TTS_AVAILABLE = True
except Exception:
    EDGE_TTS_AVAILABLE = False

try:
    from gtts import gTTS
    GTTS_AVAILABLE = True
except Exception:
    GTTS_AVAILABLE = False

# --- Flask App Initialization ---
load_dotenv()
app = Flask(__name__, static_folder='static', template_folder='templates')

# --- Configuration ---
API_KEY = os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY")
MODEL_NAME = os.getenv("MODEL_NAME", "openai/gpt-4o-mini")
# NEW: multimodal model to use only when sending images — minimal change to original flow
MULTIMODAL_MODEL = os.getenv("MULTIMODAL_MODEL", "alibaba/tongyi-deepresearch-30b-a3b:free")
TRANSCRIPTION_MODEL = os.getenv("TRANSCRIPTION_MODEL", "openai/gpt-oss-20b:free")

SYSTEM_PERSONALITY = """You are ROME — a warm, intelligent assistant created by Mohammad from India for his friend.
Creator: Mohammad — software developer, graphic designer, social media manager, makeup artist.
Be helpful, friendly, and tailored to his friend's interests, keeping creator memory private unless asked.
"""

CHATS_FILE = "rome_chats.json"
MEMORY_FILE = "rome_memory.json"
UPLOAD_DIR = os.path.join(app.static_folder, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ---------------- Helpers ----------------
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

# ---------------- Correct multimodal prepare_content_array ----------------
def prepare_content_array(text_prompt, image_b64):
    """
    Prepare a content list suitable for OpenRouter multimodal models.
    - text_prompt: string
    - image_b64: raw base64 string (without data:... prefix) OR full data URL
    Returns list of content parts.
    """
    content = []

    if text_prompt:
        content.append({
            "type": "text",
            "text": text_prompt
        })

    if image_b64:
        # If the input is a data URL, strip the prefix
        clean_b64 = image_b64.split(",", 1)[1] if "," in image_b64 else image_b64
        content.append({
            "type": "input_image",
            "image": {
                "base64": clean_b64
            }
        })

    return content

# ---------------- Model Call ----------------
@retry(stop=stop_after_attempt(5), wait=wait_fixed(3))
def call_text_model(messages: list, max_tokens: int = 800, timeout: int = 60):
    if not API_KEY:
        return "[Error: No API key found. Set OPENROUTER_API_KEY or OPENAI_API_KEY in .env]"
    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    body = {
        "model": MODEL_NAME,
        "messages": messages,
        "max_tokens": max_tokens,
    }
    try:
        # Debug prints (appear in terminal) - useful while testing
        print("[call_text_model] -> POST", url)
        print("[call_text_model] model:", MODEL_NAME, "messages_count:", len(messages))
        r = requests.post(url, json=body, headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        # Debug short output
        print("[call_text_model] response keys:", list(data.keys()) if isinstance(data, dict) else type(data))
        if data.get("choices"):
            # Try to extract assistant content robustly
            choice = data["choices"][0]
            if isinstance(choice.get("message"), dict):
                return choice["message"].get("content", "")
            return choice.get("text", "")
        return str(data)
    except Exception as e:
        err = str(e)
        print("[call_text_model] ERROR:", err)
        # Specific helpful error for name resolution (DNS)
        if 'getaddrinfo failed' in err or 'Name or service not known' in err:
            return "[Error: NameResolutionError. Check DNS / network or try again later.]"
        return f"[Error: {err}]"

# ---------------- Transcription (file upload) ----------------
@retry(stop=stop_after_attempt(3), wait=wait_fixed(2))
def transcribe_audio(audio_file_bytes):
    if not API_KEY:
        return {"error": "API key missing."}
    url = "https://openrouter.ai/api/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {API_KEY}"}
    # Save to temp file
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_file_bytes)
        temp_path = tmp.name
    try:
        with open(temp_path, "rb") as f:
            files = {'file': ('audio.wav', f, 'audio/wav')}
            data = {'model': TRANSCRIPTION_MODEL}
            r = requests.post(url, headers=headers, files=files, data=data, timeout=60)
            r.raise_for_status()
            response_data = r.json()
            # OpenRouter/Whisper often return 'text' field
            return {"transcript": response_data.get("text", "")}
    except Exception as e:
        print("[transcribe_audio] ERROR:", e)
        return {"error": f"Transcription API failed: {str(e)}"}
    finally:
        try:
            os.remove(temp_path)
        except Exception:
            pass

# ---------------- TTS Helpers ----------------
def _save_bytes_to_static(data_bytes, filename_prefix="rome_tts"):
    ts = int(time.time()*1000)
    fname = f"{filename_prefix}_{ts}.mp3"
    path = os.path.join(UPLOAD_DIR, fname)
    with open(path, "wb") as f:
        f.write(data_bytes)
    # Return a URL path relative to server root
    return url_for('static', filename=f"uploads/{fname}", _external=False)

async def _edge_tts_generate(text, voice="en-US-AriaNeural"):
    """Generate TTS with edge-tts, return path (relative) or raise."""
    out_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
    out_name = out_tmp.name
    out_tmp.close()
    # Use edge_tts Communicate and save:
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(out_name)
    with open(out_name, "rb") as f:
        data = f.read()
    try:
        os.remove(out_name)
    except Exception:
        pass
    return data

def generate_tts_bytes(text, preferred_voice=None):
    """Try edge_tts (ARIA-like) then fallback to gTTS. Returns mp3 bytes or None."""
    # Try edge-tts first
    if EDGE_TTS_AVAILABLE:
        try:
            voice = preferred_voice or "en-US-AriaNeural"
            data = asyncio.run(_edge_tts_generate(text, voice=voice))
            return data
        except Exception as e:
            print("[generate_tts_bytes] edge-tts failed:", e)
    # Fallback to gTTS
    if GTTS_AVAILABLE:
        try:
            tts = gTTS(text=text, lang="en")
            fp = BytesIO()
            tts.write_to_fp(fp)
            fp.seek(0)
            return fp.read()
        except Exception as e:
            print("[generate_tts_bytes] gTTS failed:", e)
    # Nothing available
    return None

# ---------------- Memory & Chats ----------------
memory = load_json(MEMORY_FILE, {})
chats = load_json(CHATS_FILE, {"conversations": []})

def get_active_conv(chat_id):
    try:
        chat_id = int(chat_id)
        return next((c for c in chats["conversations"] if c["id"] == chat_id), None)
    except Exception:
        return None

# ---------------- Utility: save base64 image to uploads and return URL ---------------
def save_data_url_image(data_url):
    """
    Accepts a data URL like data:image/png;base64,AAAA...
    Saves to static/uploads and returns the relative URL path (e.g., /static/uploads/xxx.png)
    """
    try:
        header, b64 = data_url.split(',', 1)
        # infer extension
        if 'jpeg' in header or 'jpg' in header:
            ext = 'jpg'
        elif 'png' in header:
            ext = 'png'
        else:
            # default to jpg
            ext = 'jpg'
        binary = base64.b64decode(b64)
        filename = f"img_{int(time.time()*1000)}.{ext}"
        save_path = os.path.join(UPLOAD_DIR, secure_filename(filename))
        with open(save_path, "wb") as f:
            f.write(binary)
        return url_for('static', filename=f"uploads/{filename}", _external=False)
    except Exception as e:
        print("[save_data_url_image] failed:", e)
        return None

# ---------------- Flask Routes ----------------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/chats", methods=["GET"])
def get_chats():
    return jsonify(chats.get("conversations", []) if isinstance(chats, dict) else chats)

@app.route("/api/test_simple", methods=["GET"])
def test_simple():
    """Quick connectivity test (text-only)."""
    try:
        test_messages = [
            {"role": "system", "content": SYSTEM_PERSONALITY},
            {"role": "user", "content": "Say pong."}
        ]
        resp = call_text_model(test_messages, max_tokens=30, timeout=20)
        return jsonify({"ok": True, "reply": resp})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

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

@app.route("/api/upload_image", methods=["POST"])
def upload_image():
    """
    Accept multipart image upload and return the relative url.
    This endpoint is optional (frontend may still send base64).
    """
    if 'image' not in request.files:
        return jsonify({"error": "No image file provided"}), 400
    f = request.files['image']
    filename = secure_filename(f.filename)
    # avoid collisions
    filename = f"{int(time.time()*1000)}_{filename}"
    save_path = os.path.join(UPLOAD_DIR, filename)
    f.save(save_path)
    url = url_for('static', filename=f"uploads/{filename}", _external=False)
    return jsonify({"url": url})

@app.route("/api/chat", methods=["POST"])
def handle_chat():
    data = request.get_json()
    user_msg = data.get("message")
    chat_id = data.get("chat_id")
    image_b64 = data.get("image_b64") or data.get("image_url")  # accept either

    if not user_msg or not chat_id:
        return jsonify({"error": "Missing message or chat ID"}), 400

    active_conv = get_active_conv(chat_id)
    if not active_conv:
        new_id = int(time.time() * 1000)
        active_conv = {"id": new_id, "title": "New Chat", "messages": []}
        chats["conversations"].append(active_conv)
        save_json(CHATS_FILE, chats)

    # 1. Add User Message (store image data if present)
    user_message_object = {"role": "user", "content": user_msg}
    saved_image_url = None
    if image_b64:
        # If it already looks like a path ("/static/..") treat as url; else save base64
        if isinstance(image_b64, str) and (image_b64.startswith("/static/") or image_b64.startswith("http")):
            saved_image_url = image_b64
            user_message_object["image_b64"] = saved_image_url
        elif isinstance(image_b64, str) and image_b64.startswith("data:"):
            # Save to uploads and convert to URL
            saved_image_url = save_data_url_image(image_b64)
            if saved_image_url:
                user_message_object["image_b64"] = saved_image_url
            else:
                user_message_object["image_b64"] = None
        else:
            # unknown format: store raw (will likely fail server-side)
            user_message_object["image_b64"] = image_b64

    active_conv["messages"].append(user_message_object)

    # 2. Prepare API messages (text-first fallback)
    # We will first try a simple text-only call to verify connectivity.
    api_simple_messages = [
        {"role": "system", "content": SYSTEM_PERSONALITY},
        {"role": "user", "content": user_msg}
    ]

    rome_resp_content = call_text_model(api_simple_messages)

    # If we have a saved_image_url and text-only succeeded, attempt real multimodal call.
    if saved_image_url and isinstance(rome_resp_content, str) and not rome_resp_content.startswith("[Error:"):
        try:
            # Convert saved image file to raw base64
            # saved_image_url is like "/static/uploads/filename.ext" (relative). Strip prefix
            rel_path = saved_image_url
            if rel_path.startswith(request.host_url.rstrip('/')):
                # sometimes frontend gives full URL
                rel_path = rel_path.replace(request.host_url.rstrip('/'), '')
            # remove leading /static/uploads/ if present
            filename_part = rel_path.split('/')[-1]
            abs_path = os.path.join(Upload_DIR := UPLOAD_DIR, filename_part)

            with open(abs_path, "rb") as f:
                raw = f.read()
                img_b64 = base64.b64encode(raw).decode()

            # Prepare content array with text + image (image base64 raw)
            mm_content = prepare_content_array(user_msg, img_b64)

            # Build body for multimodal call exactly (content array as user content)
            # Use MULTIMODAL_MODEL here so we don't change user's default MODEL_NAME for text-only calls
            mm_body = {
                "model": MULTIMODAL_MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PERSONALITY},
                    {"role": "user", "content": mm_content}
                ],
                "max_tokens": 800
            }

            headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
            print(f"[MULTIMODAL] sending to model: {MULTIMODAL_MODEL}")
            r = requests.post("https://openrouter.ai/api/v1/chat/completions", json=mm_body, headers=headers, timeout=60)
            r.raise_for_status()
            mm_data = r.json()
            if mm_data.get("choices"):
                choice = mm_data["choices"][0]
                if isinstance(choice.get("message"), dict):
                    mm_text = choice["message"].get("content", "")
                else:
                    mm_text = choice.get("text", "")
                if mm_text:
                    rome_resp_content = mm_text
        except Exception as e:
            print("[MULTIMODAL] failed:", e)
            # keep rome_resp_content as text-only response (fallback)

    # 3. Add Assistant Message & Save
    rome_resp = {"role": "assistant", "content": rome_resp_content}
    active_conv["messages"].append(rome_resp)
    save_json(CHATS_FILE, chats)

    # 4. Generate TTS for response (try edge-tts -> gTTS). Return an audio_url if possible.
    audio_url = None
    try:
        tts_bytes = generate_tts_bytes(rome_resp_content, preferred_voice=os.getenv("TTS_VOICE"))
        if tts_bytes:
            audio_rel = _save_bytes_to_static(tts_bytes, filename_prefix="rome_reply")
            audio_url = audio_rel
    except Exception as e:
        print("[handle_chat] TTS generation failed:", e)
        audio_url = None

    # 5. Auto-Rename Logic (unchanged)
    if len(active_conv["messages"]) == 2 and active_conv["title"] == "New Chat":
        title_prompt = f"Generate a concise title (max 5 words) for this conversation: {user_msg}"
        generated_title = call_text_model([
            {"role": "system", "content": "You are a title generator."},
            {"role": "user", "content": title_prompt}
        ], max_tokens=15)
        try:
            active_conv["title"] = generated_title.replace('"', '').strip()
        except Exception:
            pass
        save_json(CHATS_FILE, chats)

    # 6. Return response (including audio_url if available)
    resp_obj = {"role": "assistant", "content": rome_resp_content}
    return jsonify({"response": resp_obj, "updated_chat": active_conv, "audio_url": audio_url})

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

# Serve uploaded files reliably (static already serves them, but this gives explicit route if needed)
@app.route('/uploads/<path:filename>')
def serve_uploads(filename):
    return send_from_directory(UPLOAD_DIR, filename, as_attachment=False)

if __name__ == '__main__':
    # Run in debug for local testing; in production use gunicorn
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=True)
