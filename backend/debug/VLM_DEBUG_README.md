# VLM Detection Debug Viewer

This directory contains debug output from the Visual Language Model (VLM) detection system.

## 🗂️ Session-Based Output (NEW)

Debug files are now grouped by backend session ID:

- **`backend/debug/vlm_detections/<session-id>/`** for `/chat`, `/next-step`, and `/continue-tutorial`
- **`backend/debug/vlm_detections/`** (root) for non-session calls like `/vlm-detect`

## 📁 Files Generated

For each VLM detection run, the following files are created inside that session folder:

- **`vlm_YYYYMMDD_HHMMSS_MMM.html`** - Interactive HTML viewer (OPEN THIS!)
- **`vlm_YYYYMMDD_HHMMSS_MMM_original.png`** - Original screenshot
- **`vlm_YYYYMMDD_HHMMSS_MMM_annotated.png`** - Screenshot with bounding boxes
- **`vlm_YYYYMMDD_HHMMSS_MMM_data.json`** - Raw detection data

## 🎯 How to Use

### 1. Open the HTML Viewer

Double-click any `.html` file to open it in your browser. The HTML viewer shows:

- **Query** - What the VLM was asked to find
- **Statistics** - How many detections were found and filtered
- **Side-by-side images**:
  - **Original**: The screenshot as sent to VLM
  - **Annotated**: Bounding boxes overlaid on screenshot
- **Detections list**:
  - ✅ **Green boxes** = Kept detections (passed all filters)
  - ❌ **Red boxes** = Rejected detections (filtered out)

### 2. Understanding the Annotations

**Green Boxes (Kept)**
- These elements passed all quality filters
- Will be used for DOM matching
- Label shows: `✓ description (confidence)`

**Red Boxes (Rejected)**
- These were detected but filtered out
- Common rejection reasons:
  - Low confidence (< 0.55)
  - Too small (< 0.0002 of screen area)
  - Too large (> 0.80 of screen area)
  - Generic label ("element", "container")
  - UI artifact ("chat", "site tutor", "overlay")

### 3. Inspecting Detection Data

Each HTML file shows:
- **Bounding box coordinates** `[x1, y1, x2, y2]` in pixels
- **Confidence score** (0.0 to 1.0)
- **Relative area** (proportion of screen)
- **Filter diagnostics** (why detections were kept/rejected)
- **VLM raw response** (what Claude Vision actually returned)

## 🔧 Configuration

Control debug output via environment variables in `backend/.env`:

```bash
# Enable/disable debug image saving (default: enabled)
VLM_SAVE_DEBUG_IMAGES=1

# Debug output directory (default: debug/vlm_detections)
VLM_DEBUG_DIR=debug/vlm_detections

# Enable verbose console logging (default: enabled)
VLM_DEBUG_VERBOSE=1

# Show rejection details in console (default: enabled)
VLM_DEBUG_REJECT_DETAILS=1
```

## 📊 Analyzing Results

### If you see NO green boxes:
1. Check the red boxes - what was detected but rejected?
2. Look at rejection reasons in the HTML
3. Adjust thresholds if needed:
   ```bash
   VLM_MIN_CONFIDENCE=0.45  # Lower to accept less confident detections
   VLM_MIN_RELATIVE_AREA=0.0001  # Lower to accept smaller elements
   ```

### If you see green boxes on WRONG elements:
1. The VLM is detecting correctly, but:
   - Your query might be too vague
   - DOM mapping might be selecting the wrong element
   - Multiple similar elements exist on page
2. Refine your query to be more specific

### If you see NO boxes at all (red or green):
1. VLM didn't detect anything
2. Check the VLM raw response in HTML
3. Possible causes:
   - Element not visible in screenshot
   - Query too vague or confusing
   - Screenshot quality issues
   - VLM API error

## 🛠️ Troubleshooting

**Problem: No HTML files generated**
- Check `VLM_SAVE_DEBUG_IMAGES=1` in `.env`
- Check write permissions on `backend/debug/` directory
- Look for error messages in console

**Problem: Images not loading in HTML**
- Make sure you're opening the HTML file (not viewing raw HTML)
- Images are in the same directory as the HTML file
- Try opening HTML with `file://` protocol

**Problem: Too many debug files accumulating**
- Debug files are timestamped and won't overwrite
- Manually delete old files when done analyzing
- Consider creating a cleanup script if needed

## 📝 Example Workflow

1. **Run your tutorial** and notice VLM isn't detecting correctly
2. **Open latest HTML file** in `backend/debug/vlm_detections/<session-id>/`
3. **Look at annotated image**:
   - Are there green boxes? → VLM detected, check DOM mapping
   - Are there only red boxes? → VLM detected but filters rejected, check thresholds
   - Are there no boxes? → VLM didn't detect, refine query or check screenshot
4. **Read filter diagnostics** to understand why detections were rejected
5. **Adjust configuration** or **refine query** based on findings
6. **Test again** and compare new HTML output

## 🎨 Color Legend

- 🟢 **Green** = Detection kept (will be used)
- 🔴 **Red** = Detection rejected (filtered out)
- **Bold text** = Confidence score
- **Gray background** = Rejected detection card in list

---

**Tip:** Keep the HTML files for comparisons when tuning detection parameters!
