# Site Tutor

A Chrome extension that teaches users how to use any website through interactive, AI-guided tutorials with real-time element highlighting and step-by-step walkthroughs.

## Architecture

```
site-tutor-extension/   # Chrome extension (React + TypeScript + Vite)
backend/                # FastAPI server with Gemini AI integration
```

## Key Features

### 1. Element Indexing (Accurate Overlays)

Instead of having Gemini guess CSS selectors from screenshots, the extension walks the DOM and assigns each interactive element a numeric index. Gemini picks an index number, and the frontend looks up the real element directly — no selector matching needed.

- **`elementIndexer.ts`** — `ElementIndexer` class that indexes up to 200 interactive/visible elements, traverses Shadow DOM, skips the extension's own UI
- Produces compact text representations sent to Gemini:
  ```
  [0] button "Sign in" id="login-btn"
  [1] a "Pricing" href="/pricing"
  [2] input[type="text"] placeholder="Search..."
  ```
- Overlay and action verifier use element index as primary lookup, CSS selectors as fallback

### 2. Persistent Tutorial Memory

Tutorial progress persists across tab closes using `chrome.storage.local`.

- **`tutorialMemory.ts`** — Fingerprints tutorials by origin + title + steps, stores up to 50 records with 30-day expiry
- Resumes from where the user left off on return
- Detects similar previously-completed tutorials so Gemini can skip basics
- Sends completion history to the backend so AI builds on prior knowledge

### 3. Seamless Step Detection (No Hard Timeout)

The watcher runs continuously instead of stopping after 20 seconds.

- **Hint system** — Shows a hint after 15s of inactivity, but watching never stops
- **MutationObserver** — Watches `document.body` for DOM changes matching the expected result (debounced at 200ms)
- **Page state polling** — Checks URL, title, and heading changes every 2s (zero API calls)
- **Element-based matching** — Click/input listeners resolve targets by element index first, then fall back to CSS selectors

## File Overview

| File | Purpose |
|------|---------|
| `site-tutor-extension/src/utils/elementIndexer.ts` | DOM element indexing for accurate targeting |
| `site-tutor-extension/src/utils/tutorialMemory.ts` | Persistent tutorial progress via chrome.storage |
| `site-tutor-extension/src/utils/actionVerifier.ts` | Continuous step completion detection |
| `site-tutor-extension/src/utils/domSanitizer.ts` | DOM traversal utilities (shared) |
| `site-tutor-extension/src/types/tutorial.ts` | TypeScript types for tutorial steps |
| `site-tutor-extension/src/content/index.tsx` | Content script entry, exposes shared indexer |
| `site-tutor-extension/src/components/Chatbot.tsx` | Main chat UI, orchestrates indexer + memory |
| `site-tutor-extension/src/components/Overlay.tsx` | Element highlight overlay rendering |
| `site-tutor-extension/src/components/TutorialController.tsx` | Step-by-step tutorial UI and watcher |
| `backend/main.py` | FastAPI server, Gemini prompt, element index API |

## Setup

### Extension

```bash
cd site-tutor-extension
npm install
npm run build
```

Then load the `dist/` folder as an unpacked extension in Chrome (`chrome://extensions` > Developer mode > Load unpacked).

### Backend

```bash
cd backend
pip install -r requirements.txt
```

Create a `backend/.env` file:

```
CLAUDE_API_KEY=your_key_here
```

Start the server:

```bash
python main.py
```

The backend runs on `http://localhost:8000`.

## Usage

1. Navigate to any website (e.g. GitHub)
2. Click the Site Tutor chat bubble in the bottom-right corner
3. Ask a question or request a tutorial (e.g. "How do I create a new repository?")
4. The AI generates step-by-step instructions with highlighted elements on the page
5. Follow each step — the watcher detects completion and auto-advances
6. Close the tab and return later — your progress is saved

## Verification

1. Build the extension and load it in Chrome
2. Start the backend server
3. Navigate to a test site and ask the chatbot a question
4. Verify the overlay highlights the correct element (not a random one)
5. Start a tutorial, complete a step, close the tab, reopen — verify it remembers progress
6. Let a step sit for >20s without acting — verify the watcher is still active (hint shows but clicking still works)
