# Cloud VLM Setup - Claude API

## ✅ Using Claude 3.5 Sonnet (No Model Download!)

**Benefits:**
- ✅ No 8GB model download
- ✅ Fast setup (2 minutes)
- ✅ 1-2 second latency
- ✅ High accuracy
- ✅ Cost: ~$0.008/image (~120 images per $1)

---

## 🚀 Quick Setup (3 Steps)

### Step 1: Get Anthropic API Key

1. Go to: https://console.anthropic.com/
2. Sign up or log in
3. Go to **API Keys** section
4. Click **Create Key**
5. Copy your API key (starts with `sk-ant-...`)

### Step 2: Install Dependencies

```bash
cd /Users/nikhi/git-hack/backend
pip install anthropic
```

That's it! No torch, transformers, or 8GB model download needed.

### Step 3: Configure API Key

```bash
# Edit .env file
nano .env
```

Add your API key:
```env
CLAUDE_API_KEY=sk-ant-your-api-key-here
CLAUDE_MODEL=claude-3-5-sonnet-20241022
CLAUDE_MAX_TOKENS=1024
```

---

## ✅ Test It Works

### 1. Start Server
```bash
cd /Users/nikhi/git-hack/backend
python main.py
```

Expected output:
```
✅ Using Cloud VLM (Claude API)
INFO:     Started server on http://0.0.0.0:8000
```

### 2. Check Health
```bash
curl http://localhost:8000/vlm-health
```

Expected response:
```json
{
  "vlm_available": true,
  "provider": "claude-api",
  "model_name": "claude-3-5-sonnet-20241022",
  "api_key_configured": true,
  "error": null
}
```

### 3. Test Detection

Capture a screenshot:
```bash
curl http://localhost:8000/capture-desktop > screenshot.json
```

Extract base64 data:
```bash
cat screenshot.json | python3 -c "import sys, json; print(json.load(sys.stdin)['screenshot'])" > screenshot.txt
```

Test VLM detection:
```bash
curl -X POST http://localhost:8000/vlm-detect \
  -H "Content-Type: application/json" \
  -d "{
    \"screenshot\": \"$(cat screenshot.txt)\",
    \"query\": \"find the browser address bar\",
    \"viewport_width\": 1920,
    \"viewport_height\": 1080
  }"
```

Expected response (within 1-2 seconds):
```json
{
  "detections": [
    {
      "label": "address bar",
      "confidence": 0.92,
      "bbox": {"x": 0.15, "y": 0.02, "width": 0.7, "height": 0.03},
      "bbox_absolute": {"x": 288, "y": 22, "width": 1344, "height": 32}
    }
  ],
  "model_latency_ms": 1456,
  "reasoning": "Located the browser address bar..."
}
```

---

## 💰 Pricing

**Claude 3.5 Sonnet:**
- Input: $3 per million tokens
- Images: ~$0.008 per image (1600x1200)
- **Effective cost:** ~120 images per $1

**Monthly estimates:**
- Light use (10 images/day): $2.40/month
- Medium use (50 images/day): $12/month
- Heavy use (200 images/day): $48/month

**Free tier:** Anthropic provides credits for testing

---

## 🔄 Usage in Extension

Once configured, the extension automatically uses Claude VLM:

```typescript
// In your extension code
const element = await findBestElementByInstruction(
    'Click the submit button',
    indexer,
    true  // Enable VLM fallback
)

// Flow:
// 1. Try DOM first (free, fast)
// 2. If confidence < 70% → Use Claude VLM (costs $0.008)
// 3. Return best result
```

---

## 🔧 Configuration Options

Edit `backend/.env`:

```env
# Use latest Sonnet model
CLAUDE_MODEL=claude-3-5-sonnet-20241022

# Increase for complex queries
CLAUDE_MAX_TOKENS=1024

# For production (optional)
# ANTHROPIC_BASE_URL=https://api.anthropic.com
```

---

## 🐛 Troubleshooting

### "CLAUDE_API_KEY not configured"

**Solution:**
```bash
# Check if .env exists
cat backend/.env | grep CLAUDE_API_KEY

# If not, create it
cp backend/.env.example backend/.env
nano backend/.env  # Add your key
```

### "anthropic package not installed"

**Solution:**
```bash
pip install anthropic
```

### "Detections empty"

**Possible causes:**
1. Query too vague ("button" → try "blue submit button")
2. Element not in screenshot
3. API rate limit

**Solutions:**
- Make query more specific
- Check screenshot contains element
- Wait 1 minute and retry

### "API rate limit exceeded"

**Solution:**
- Wait 1 minute
- Upgrade to paid plan on console.anthropic.com
- Contact Anthropic support for higher limits

---

## 🔐 Security

**Best practices:**
- Never commit `.env` file to git (already in `.gitignore`)
- Use environment variables in production
- Rotate API keys periodically
- Monitor usage in Anthropic console

---

## 📊 Performance Comparison

| Method | Download | Latency | Cost | Accuracy |
|--------|----------|---------|------|----------|
| **Claude API** ✅ | None | 1-2s | $0.008/img | Excellent |
| Local Qwen | 8GB | 1-2s (GPU) | Free | Very Good |
| Local Qwen (CPU) | 8GB | 3-5s | Free | Very Good |

**Recommendation:** Use Claude API unless you need offline processing.

---

## 🎯 Next Steps

1. ✅ Test VLM health endpoint
2. ✅ Test detection with real screenshot
3. ✅ Try in extension with actual websites
4. Monitor usage in Anthropic console
5. Tune confidence thresholds if needed

---

## 📚 Resources

- **Anthropic Console:** https://console.anthropic.com/
- **Claude API Docs:** https://docs.anthropic.com/
- **Pricing:** https://www.anthropic.com/pricing
- **Support:** https://support.anthropic.com/

---

**Status:** ✅ Ready to use! No model download required.
