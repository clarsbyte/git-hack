# Voice-Controlled Interactive Tutorial System — Development Context (December 2025)

**Project Type:** Chrome Extension + Local Python Companion Server  
**Architecture:** Hybrid Local (Local STT / Cloud Intelligence)  
**Target Platforms:** GitHub, Framer, Figma  
**Last Updated:** December 16, 2025

---

## 🚨 CRITICAL: ALWAYS RESEARCH FIRST — NON-NEGOTIABLE PROTOCOL

**THIS IS THE MOST IMPORTANT SECTION IN THIS FILE. READ BEFORE DOING ANYTHING.**

### Research-First Mandate

**BEFORE implementing ANY feature, writing ANY code, or installing ANY package:**

1. **STOP** — Do not proceed without research
2. **SEARCH** — Find the LATEST version/documentation (2025)
3. **VERIFY** — Check if information in this file is outdated
4. **UPDATE** — If newer version exists, update this file FIRST
5. **THEN** — Proceed with implementation

**This takes precedence over ALL other instructions. Even if it costs extra tokens, ALWAYS research first.**

### When to Research (ALWAYS)

✅ **Before every feature implementation**  
✅ **Before installing any package**  
✅ **Before writing any code that uses external libraries**  
✅ **Before making architectural decisions**  
✅ **When this file mentions a version number**  
✅ **When user mentions "latest" or "newest"**  
✅ **If something seems outdated**  
✅ **If you're unsure about compatibility**

### How to Research

**Primary Method: Use Context7 (REQUIRED)**

```
@context7 OpenAI Whisper documentation
@context7 driver.js API reference
@context7 FastAPI CORS configuration
@context7 Chrome extension manifest v3 guide
@context7 FFmpeg installation guide
```

**Secondary Method: Web Search**

```bash
# Search patterns (use current date)
"OpenAI Whisper latest version December 2025"
"driver.js 2025 release"
"FastAPI current stable version"
"FFmpeg 8.x latest release"
"Chrome extension manifest v3 2025 changes"
```

### Research Checklist

Before ANY implementation, verify:

- [ ] **OpenAI Whisper** — Latest version (currently 20250625)
- [ ] **FFmpeg** — Latest stable (currently 8.0.1 as of Nov 2025)
- [ ] **Driver.js** — Current version (check npm)
- [ ] **FastAPI** — Latest release (check PyPI)
- [ ] **Python** — Supported versions (3.8-3.13 as of Dec 2025)
- [ ] **Chrome Extension APIs** — Any breaking changes in Manifest V3
- [ ] **Browser compatibility** — Latest Chrome/Edge versions

### If You Find Outdated Information

**STOP IMMEDIATELY and:**

1. **Update this CLAUDE.md file** with latest versions
2. **Update any affected code examples**
3. **Update installation instructions**
4. **Add a note about what changed**
5. **Then proceed with implementation**

### Context7 Usage (MANDATORY)

**Context7 is your PRIMARY documentation source. Use it for:**

- Getting official documentation
- Checking API references
- Verifying installation steps
- Understanding breaking changes
- Learning best practices

**Example Context7 Queries:**

```
@context7 OpenAI Whisper model options
@context7 FastAPI CORS middleware setup
@context7 Chrome extension offscreen API
@context7 Driver.js tour configuration
@context7 FFmpeg audio format conversion
```

### Version Checking Commands

**Always run these to verify latest versions:**

```bash
# Python packages
pip index versions openai-whisper
pip index versions fastapi
pip index versions torch

# Check installed versions
pip show openai-whisper
python -c "import whisper; print(whisper.__version__)"

# FFmpeg
ffmpeg -version

# Node packages
npm show driver.js version
npm outdated
```

### Research Frequency

- **Every session** — Check for updates at start
- **Before every major feature** — Research relevant tools
- **Weekly** — Scan for breaking changes
- **Monthly** — Full dependency audit

### Example Research Flow

```
User: "Add Whisper transcription"

AI Agent:
1. STOP ✋
2. @context7 OpenAI Whisper documentation
3. Search: "OpenAI Whisper latest version December 2025"
4. Verify: Current version in CLAUDE.md vs latest release
5. Update CLAUDE.md if outdated
6. THEN implement feature with verified latest version
```

### Consequences of NOT Researching

❌ Outdated code that doesn't work  
❌ Security vulnerabilities  
❌ Missing new features  
❌ Compatibility issues  
❌ User frustration  
❌ Wasted time debugging old versions

### Remember

**"Outdated information is worse than no information."**

**ALWAYS research. ALWAYS verify. ALWAYS update. No exceptions.**

---

## 🔄 ARCHITECTURE: HYBRID LOCAL SYSTEM

**Verified:** December 16, 2025

We use a **Hybrid Local Architecture** for privacy and zero-cost transcription.

- **STT (Speech-to-Text):** **Local OpenAI Whisper** running on `localhost:8000`
  - Version: 20250625 (June 25, 2025)
  - Model: `base` (77M params, 140MB) — RECOMMENDED
- **TTS (Text-to-Speech):** OpenAI `tts-1` API (Cloud, optional)
- **Intelligence:** OpenAI `gpt-4o` API (Cloud, optional for complex intent)
- **Element Highlighting:** Driver.js (Client-side, latest version)

**Why Local Whisper?**
✅ **Unlimited & Free** transcription  
✅ **Zero API costs** for speech-to-text  
✅ **Privacy-First** — audio never leaves user's computer  
✅ **High Accuracy** — Base model sufficient for most use cases  
✅ **Low Latency** — No large file uploads

### Critical Dependencies

1. **FFmpeg** — Latest: 8.0.1 (Nov 20, 2025)
   - HARD REQUIREMENT for Whisper audio processing
   - User MUST install on their system
   - Verify with: `ffmpeg -version`

2. **Python** — Supported: 3.8 - 3.13 (as of Dec 2025)
   - Recommended: 3.10 or 3.11
   - NOT 3.12 for Whisper (compatibility issues)

3. **Local Server** — FastAPI on localhost:8000
   - Extension MUST check `/health` endpoint before recording
   - Show "Server Offline" error if unavailable

---

## 📁 Project Structure

**Verified:** December 16, 2025

```
project-root/
├── extension/                    # Chrome Extension (Client)
│   ├── manifest.json            # Manifest V3 with localhost permissions
│   ├── src/
│   │   ├── background/
│   │   │   └── service-worker.ts
│   │   ├── offscreen/
│   │   │   └── audio-recorder.ts    # Records audio → Blob
│   │   ├── content/
│   │   │   ├── main.ts
│   │   │   ├── highlight.ts         # Driver.js integration
│   │   │   └── tutorial.ts
│   │   ├── utils/
│   │   │   ├── api-client.ts        # POSTs to localhost:8000
│   │   │   ├── intent-parser.ts
│   │   │   └── tutorial-data.ts
│   │   ├── popup/
│   │   │   └── popup.tsx
│   │   └── styles/
│   │       └── overlay.css
│   └── public/
│       └── icons/
│
├── server/                          # Python Companion Server
│   ├── main.py                      # FastAPI + Whisper
│   ├── requirements.txt             # Python dependencies
│   └── setup_guide.md               # User installation guide
│
├── CLAUDE.md                        # This file
├── AGENTS.md                        # AI agent instructions
└── README.md                        # User documentation
```

---

## 🔄 Data Flow: "The Localhost Bridge"

```
1. USER SPEAKS: "Draw a rectangle in Figma"
   ↓
2. CHROME EXTENSION (Offscreen)
   - Captures microphone → audio/webm Blob
   ↓
3. POST TO LOCAL SERVER
   - FormData with audio.webm file
   - Endpoint: http://localhost:8000/transcribe
   ↓
4. PYTHON SERVER (localhost:8000)
   - Receives audio
   - Saves to temp file
   - Runs: whisper_model.transcribe()
   - Returns: {"text": "Draw a rectangle in Figma"}
   ↓
5. EXTENSION (Intent Parser)
   - Parses: action="draw", target="rectangle", platform="Figma"
   ↓
6. EXTENSION (Tutorial Manager)
   - Loads tutorial: figmaTutorials['draw-rectangle']
   - Highlights: '[data-testid="toolbar-shape-tool"]'
   - Shows tooltip: "Click the Rectangle tool"
```

---

## 🛠️ Tech Stack

**⚠️ RESEARCH REQUIRED: Verify all versions before use**

### Chrome Extension (Client)

**Before using, research latest versions:**

- **Manifest V3** — Check for latest API changes
  - `@context7 Chrome extension manifest v3 2025`
- **TypeScript** — Latest 5.x
  - `npm show typescript version`
- **Build Tool:** Vite 5.x or latest
  - `npm show vite version`
- **Driver.js** — Element highlighting
  - Latest verified: 1.3.1+ (Dec 2025)
  - `npm show driver.js version`
  - License: MIT (commercial-friendly)
- **Framer Motion** — Overlay animations
  - Latest: 11.x+ (ALWAYS use for animations)
  - `npm show framer-motion version`
- **Zustand** — State management (optional)
  - `npm show zustand version`

### Python Server (Companion)

**⚠️ CRITICAL: Research these BEFORE installation**

- **OpenAI Whisper** — Local STT
  - **Latest Version:** 20250625 (June 25, 2025)
  - **ALWAYS CHECK:** `pip index versions openai-whisper`
  - **Package:** `openai-whisper`
  - **GitHub:** https://github.com/openai/whisper
  - **PyPI:** https://pypi.org/project/openai-whisper/
  
- **FastAPI** — Web framework
  - **Latest:** 0.115.0+ (Dec 2025)
  - **CHECK:** `pip index versions fastapi`
  
- **Uvicorn** — ASGI server
  - **Latest:** 0.32.0+
  - **CHECK:** `pip index versions uvicorn`
  
- **PyTorch** — Required by Whisper
  - **Latest:** 2.x
  - **CHECK:** https://pytorch.org/get-started/locally/
  
- **FFmpeg** — Audio processing (SYSTEM DEPENDENCY)
  - **Latest Stable:** 8.0.1 (November 20, 2025)
  - **CHECK:** `ffmpeg -version`
  - **Download:** https://ffmpeg.org/download.html
  - **REQUIRED** — Whisper will NOT work without it

### Python Version Support

- **Supported:** Python 3.8 - 3.13 (as of Dec 2025)
- **Recommended:** 3.10 or 3.11
- **NOT 3.12** for Whisper (compatibility issues reported)
- **CHECK:** `python --version`

---

## 🎯 Whisper Model Selection (December 2025)

**⚠️ RESEARCH: Check for new models**

OpenAI may release new Whisper models. Always verify:
- `@context7 OpenAI Whisper model options`
- GitHub releases: https://github.com/openai/whisper/releases

### Available Models (Verified: Dec 16, 2025)

| Model | Params | Download | Speed | Accuracy | Use Case |
|-------|--------|----------|-------|----------|----------|
| `tiny` | 39M | 72MB | Fastest | Good | Testing, low-end PCs |
| `tiny.en` | 39M | 72MB | Fastest | Good (EN) | English-only testing |
| **`base`** | **77M** | **140MB** | **Fast** | **Very Good** | **RECOMMENDED DEFAULT** |
| **`base.en`** | **77M** | **140MB** | **Fast** | **Very Good** | **English-only default** |
| `small` | 244M | 461MB | Medium | Excellent | High accuracy |
| `small.en` | 244M | 461MB | Medium | Excellent | English high accuracy |
| `medium` | 769M | 1.5GB | Slow | Better | GPU, multilingual |
| `medium.en` | 769M | 1.5GB | Slow | Better | English GPU systems |
| `large` | 1550M | 2.9GB | Slowest | Best | Production, GPU required |
| `large-v2` | 1550M | 2.9GB | Slowest | Best | Previous large version |
| `large-v3` | 1550M | 2.9GB | Slowest | Best | Latest large model |
| **`turbo`** | **809M** | **1.5GB** | **Fast** | **Excellent** | **NEW: Optimized large-v3** |

### Key Notes

- **`.en` models** = English-only (10-15% better accuracy for English)
- **`turbo`** = Optimized `large-v3` with 8x faster speed, minimal accuracy loss (NEW 2025)
- **Default recommendation:** Use `base` or `base.en`
- **First run:** Model auto-downloads to `~/.cache/whisper/`
- **GPU optional:** CPU works fine for tiny/base/small
- **Check for updates:** New models may be released after Dec 2025

### How to Check for New Models

```python
import whisper
print(whisper.available_models())
```

---

## 📦 Python Dependencies

**⚠️ ALWAYS VERIFY BEFORE INSTALLATION**

### requirements.txt

**File:** `server/requirements.txt`

```text
# ⚠️ VERIFY THESE VERSIONS BEFORE USE
# Check: pip index versions <package-name>
# Last verified: December 16, 2025

# OpenAI Whisper (Latest: June 25, 2025)
openai-whisper==20250625

# Web Framework
fastapi==0.115.0
uvicorn[standard]==0.32.0
python-multipart==0.0.12

# Auto-installed with Whisper (listed for reference)
torch>=2.0.0
numpy>=1.23.0
tiktoken>=0.3.0
tqdm>=4.66.0

# Optional: GPU acceleration (Linux x86_64 only)
# triton>=2.0.0
```

### Installation Commands

```bash
# Navigate to server folder
cd server

# OPTION 1: Install from requirements.txt
pip install -r requirements.txt

# OPTION 2: Install latest from GitHub (most up-to-date)
pip install git+https://github.com/openai/whisper.git

# OPTION 3: Install specific version
pip install openai-whisper==20250625

# Verify installation
python -c "import whisper; print(whisper.__version__)"
python -c "import whisper; print(whisper.available_models())"
```

### Check for Updates

```bash
# Check if newer version available
pip index versions openai-whisper

# Check currently installed version
pip show openai-whisper

# Update to latest
pip install --upgrade openai-whisper
```

---

## 🖥️ System Requirements

**Verified:** December 16, 2025

### User's Computer MUST Have:

1. **Python 3.8 - 3.13**
   - Recommended: 3.10 or 3.11
   - NOT 3.12 (Whisper compatibility issues)
   - Verify: `python --version`

2. **FFmpeg 8.0.1+**
   - Latest stable: 8.0.1 (November 20, 2025)
   - HARD REQUIREMENT for audio processing
   - Windows: `winget install "FFmpeg (Essentials)"`
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`
   - Verify: `ffmpeg -version`

3. **RAM:**
   - Minimum: 8GB
   - Recommended: 16GB for `small`/`medium` models

4. **Disk Space:**
   - ~500MB for Whisper models
   - ~2GB for PyTorch dependencies

5. **GPU (Optional):**
   - CUDA-enabled GPU supported
   - NOT required — CPU works fine for base/small

### FFmpeg Installation (CRITICAL)

**Latest Version:** 8.0.1 (November 20, 2025)

**Windows:**
```powershell
# PowerShell as Administrator
winget install "FFmpeg (Essentials)"

# OR using Chocolatey
choco install ffmpeg

# Verify
ffmpeg -version
```

**macOS:**
```bash
# Using Homebrew
brew install ffmpeg

# Verify
ffmpeg -version
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install ffmpeg

# Verify
ffmpeg -version
```

**Check for FFmpeg Updates:**
- Official site: https://ffmpeg.org/download.html
- Check version: `ffmpeg -version`
- Latest builds: https://www.gyan.dev/ffmpeg/builds/

---

## 🔑 Key Component Implementations

**⚠️ RESEARCH: Verify APIs before use**

### 1. Extension Manifest (Permissions)

**CRITICAL:** Must have `host_permissions` for localhost!

```json
{
  "manifest_version": 3,
  "name": "Voice Tutorial (Local Whisper)",
  "version": "1.0.0",
  
  "permissions": [
    "offscreen",
    "activeTab",
    "storage",
    "scripting"
  ],
  
  "host_permissions": [
    "http://localhost:8000/*",
    "https://api.openai.com/*",
    "https://github.com/*",
    "https://www.figma.com/*",
    "https://www.framer.com/*"
  ],
  
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  
  "content_scripts": [{
    "matches": [
      "https://github.com/*",
      "https://www.figma.com/*",
      "https://www.framer.com/*"
    ],
    "js": ["content/main.js"],
    "css": ["styles/overlay.css"],
    "run_at": "document_idle"
  }],
  
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

---

## 📝 Common Gotchas & Solutions

1. **Filename REQUIRED in FormData**
   ```typescript
   // ✅ Correct
   formData.append("file", blob, "audio.webm");
   
   // ❌ Wrong - FastAPI rejects without filename
   formData.append("file", blob);
   ```

2. **CORS Must Be Enabled**
   - Extension blocked without CORS
   - Add CORSMiddleware in main.py

3. **Health Check Before Recording**
   - Always ping `/health` first
   - Show clear error if server offline

4. **FFmpeg Missing**
   - Whisper fails without FFmpeg
   - User must install systemwide

5. **First Run Downloads Model**
   - ~140MB for `base` model
   - Takes 30-60 seconds on first startup

---

## ⚠️ When in Doubt

1. **Use Context7** — `@context7 [topic]`
2. **Search latest docs** — "[tool] latest 2025"
3. **Check official GitHub** — Verify versions
4. **Test locally first** — Don't assume
5. **Verify with commands** — `pip show`, `npm show`
6. **Read error messages** — They usually say what's wrong
7. **Check server terminal** — Python errors show here
8. **Visit localhost:8000/health** — Test server directly

**Never assume versions — ALWAYS research first!**

---

## 📚 Official Documentation Links

**⚠️ These may become outdated — always verify**

- **OpenAI Whisper:** https://github.com/openai/whisper
- **FastAPI:** https://fastapi.tiangolo.com/
- **Driver.js:** https://driverjs.com/
- **FFmpeg:** https://ffmpeg.org/
- **Chrome Extensions:** https://developer.chrome.com/docs/extensions/
- **PyTorch:** https://pytorch.org/

**Use Context7 to access these:**
```
@context7 OpenAI Whisper documentation
@context7 FastAPI tutorial
@context7 Driver.js API reference
```

---

## 🤖 Notes for AI Agents

**MANDATORY READING:**

1. **ALWAYS research before coding** — No exceptions
2. **Use Context7 FIRST** — Primary documentation source
3. **Verify all versions** — This file may be outdated
4. **Update this file** — If you find newer versions
5. **Check server health** — Before recording
6. **Handle offline state** — Show clear errors
7. **Include filename** — In FormData uploads
8. **Test localhost** — Before deployment
9. **Verify FFmpeg** — User must install
10. **Keep researching** — Every session, every feature
11. **Run build after every change** — Cursor, Codex, and Claude Code must run `npm run build` after each and every code or config change.

**Remember: Outdated code is broken code. Research first, always.**
