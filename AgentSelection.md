
## DOM-Aware Screenshot Selection Code

### File: `lib/webview-injections/element-selector.js`

---

### 1. Element Detection

```javascript
// Lines 376-388: Pick the topmost DOM element at cursor position
const pickTarget = (x, y) => {
  const stack = document.elementsFromPoint(x, y) || [];
  for (const el of stack) {
    if (!el || el === overlay || el.id === '__inspector_selector_highlight') continue;
    if (el.id && el.id.startsWith('__inspector_')) continue;
    return el;
  }
  return null;
};
```

---

### 2. Border Radius Calculation

```javascript
// Lines 19-35: Dynamic border radius for screenshot highlight
const MAX_SCREENSHOT_RADIUS = 8;

const applyScreenshotRadius = (element, width, height) => {
  if (!ALLOW_MARQUEE || !element) return;
  const safeWidth = Math.max(0, Number.isFinite(width) ? width : 0);
  const safeHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  const minDimension = Math.min(safeWidth, safeHeight);
  if (minDimension <= 0) {
    element.style.borderRadius = '0px';
    return;
  }
  const maxAllowed = minDimension * 0.3;
  const radius = Math.min(MAX_SCREENSHOT_RADIUS, maxAllowed);
  element.style.borderRadius = radius + 'px';
};
```

---

### 3. Overlay Elements (Styling)

```javascript
// Lines 108-120: Main interaction overlay
const overlay = document.createElement('div');
overlay.id = '__inspector_selector_overlay';
overlay.style.position = 'fixed';
overlay.style.top = '0';
overlay.style.left = '0';
overlay.style.width = '100%';
overlay.style.height = '100%';
overlay.style.zIndex = '2147483646';
overlay.style.cursor = DEFAULT_CURSOR;
overlay.style.pointerEvents = 'auto';
overlay.style.background = 'rgba(0,0,0,0)';
document.body.appendChild(overlay);

// Lines 122-136: Gray darkening overlay
const grayOverlay = document.createElement('div');
grayOverlay.id = '__inspector_gray_overlay';
grayOverlay.style.position = 'fixed';
grayOverlay.style.top = '0';
grayOverlay.style.left = '0';
grayOverlay.style.width = '100%';
grayOverlay.style.height = '100%';
grayOverlay.style.pointerEvents = 'none';
grayOverlay.style.background = 'rgba(0, 0, 0, 0.35)';
grayOverlay.style.zIndex = '2147483645';
grayOverlay.style.display = 'block';
if (SHOW_OVERLAY) {
  document.body.appendChild(grayOverlay);
}

// Lines 138-158: Highlight box that snaps to elements
const highlight = document.createElement('div');
highlight.id = '__inspector_selector_highlight';
highlight.style.position = 'absolute';
highlight.style.pointerEvents = 'none';
highlight.style.boxSizing = 'border-box';
highlight.style.border = ALLOW_MARQUEE ? 'none' : '1px solid rgba(13, 153, 255, 0.9)';
highlight.style.background = ALLOW_MARQUEE ? 'transparent' : 'rgba(13, 153, 255, 0.2)';
highlight.style.boxShadow = SHOW_OVERLAY
  ? '0 0 0 9999px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.4)'
  : 'none';
highlight.style.borderRadius = ALLOW_MARQUEE ? MAX_SCREENSHOT_RADIUS + 'px' : '2px';
highlight.style.transition = 'left 0.15s ease-out, top 0.15s ease-out, width 0.15s ease-out, height 0.15s ease-out, border-radius 0.15s ease-out, box-shadow 0.15s ease-out';
highlight.style.display = 'none';
overlay.appendChild(highlight);

// Lines 160-176: Marquee for freehand selection
const marquee = document.createElement('div');
marquee.id = '__inspector_selector_marquee';
marquee.style.position = 'absolute';
marquee.style.pointerEvents = 'none';
marquee.style.boxSizing = 'border-box';
marquee.style.border = 'none';
marquee.style.background = 'transparent';
marquee.style.borderRadius = MAX_SCREENSHOT_RADIUS + 'px';
marquee.style.display = 'none';
marquee.style.boxShadow = SHOW_OVERLAY
  ? '0 0 0 9999px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.4)'
  : 'none';
if (ALLOW_MARQUEE) {
  overlay.appendChild(marquee);
}
```

---

### 4. Hover Behavior (Snap to Element)

```javascript
// Lines 453-503 (simplified, without React resolution)
const onMove = (event) => {
  if (isDragging) {
    handleDragMove(event);
    highlight.style.display = 'none';
    return;
  }
  
  const target = pickTarget(event.clientX, event.clientY);
  if (!target) {
    highlight.style.display = 'none';
    latestInfo = null;
    latestTarget = null;
    if (ALLOW_MARQUEE && SHOW_OVERLAY && grayOverlay && grayOverlay.parentElement) {
      grayOverlay.style.display = 'block';
    }
    return;
  }

  // SNAP TO ELEMENT BOUNDS
  const rect = target.getBoundingClientRect();
  highlight.style.left = rect.left + 'px';
  highlight.style.top = rect.top + 'px';
  highlight.style.width = rect.width + 'px';
  highlight.style.height = rect.height + 'px';
  highlight.style.display = 'block';
  
  if (ALLOW_MARQUEE) {
    applyScreenshotRadius(highlight, rect.width, rect.height);
  }
  if (ALLOW_MARQUEE && SHOW_OVERLAY && grayOverlay && grayOverlay.parentElement) {
    grayOverlay.style.display = 'none';
  }

  latestRect = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top,
  };

  const attributes = {};
  for (const attr of Array.from(target.attributes)) {
    attributes[attr.name] = attr.value;
  }

  latestInfo = {
    tagName: (target.tagName || '').toLowerCase(),
    id: target.id || undefined,
    className: (typeof target.className === 'string' ? target.className : '') || undefined,
    textContent: (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    attributes,
  };

  latestTarget = target;
};
```

---

### 5. Scroll Handling (Keep Highlight Snapped)

```javascript
// Lines 642-671: Update highlight position on scroll
const onScroll = () => {
  if (isDragging || !latestTarget) return;
  
  highlight.style.transition = 'none';
  
  const rect = latestTarget.getBoundingClientRect();
  highlight.style.left = rect.left + 'px';
  highlight.style.top = rect.top + 'px';
  highlight.style.width = rect.width + 'px';
  highlight.style.height = rect.height + 'px';
  
  latestRect = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top,
  };
  
  if (highlight._scrollTimeout) {
    clearTimeout(highlight._scrollTimeout);
  }
  highlight._scrollTimeout = setTimeout(() => {
    highlight.style.transition = 'left 0.15s ease-out, top 0.15s ease-out, width 0.15s ease-out, height 0.15s ease-out, border-radius 0.15s ease-out, box-shadow 0.15s ease-out';
  }, 100);
};
```

---

### 6. Marquee Drag Selection

```javascript
// Lines 231-271: Update marquee during drag
const updateMarquee = () => {
  if (!ALLOW_MARQUEE) return;
  if (!dragOrigin || !dragCurrent) {
    marquee.style.display = 'none';
    if (SHOW_OVERLAY && grayOverlay && grayOverlay.parentElement) {
      grayOverlay.style.display = 'block';
    }
    return;
  }

  const left = Math.min(dragOrigin.x, dragCurrent.x);
  const top = Math.min(dragOrigin.y, dragCurrent.y);
  const right = Math.max(dragOrigin.x, dragCurrent.x);
  const bottom = Math.max(dragOrigin.y, dragCurrent.y);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);

  marquee.style.left = `${left}px`;
  marquee.style.top = `${top}px`;
  marquee.style.width = `${width}px`;
  marquee.style.height = `${height}px`;
  marquee.style.display = 'block';
  
  applyScreenshotRadius(marquee, width, height);
  
  if (SHOW_OVERLAY && grayOverlay && grayOverlay.parentElement) {
    grayOverlay.style.display = 'none';
  }
};

// Lines 304-353: Finalize marquee selection
const finalizeMarqueeSelection = () => {
  if (!ALLOW_MARQUEE || !dragOrigin || !dragCurrent) return false;

  const left = Math.max(0, Math.min(dragOrigin.x, dragCurrent.x));
  const top = Math.max(0, Math.min(dragOrigin.y, dragCurrent.y));
  const right = Math.max(0, Math.max(dragOrigin.x, dragCurrent.x));
  const bottom = Math.max(0, Math.max(dragOrigin.y, dragCurrent.y));

  const width = Math.max(0, Math.round(right - left));
  const height = Math.max(0, Math.round(bottom - top));

  if (width < MIN_DRAG_DISTANCE && height < MIN_DRAG_DISTANCE) {
    return false;
  }

  const payload = {
    tagName: 'custom-selection',
    attributes: {},
    rect: {
      x: Math.max(0, Math.floor(left)),
      y: Math.max(0, Math.floor(top)),
      width,
      height,
    },
    devicePixelRatio: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1,
    scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    selectionType: 'custom',
  };

  // Hide overlays before capture
  if (grayOverlay && grayOverlay.parentElement) {
    grayOverlay.style.display = 'none';
  }
  overlay.style.display = 'none';
  marquee.style.display = 'none';
  dragOrigin = null;
  dragCurrent = null;

  window.requestAnimationFrame(() => {
    postToHost('INSPECTOR_ELEMENT_SELECTED', payload);
    cleanup();
  });

  return true;
};
```

---

### 7. Element Click Selection (without React)

```javascript
// Lines 561-607 (simplified, React resolution removed)
const onClick = (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  if (latestInfo) {
    const payload = {
      ...latestInfo,
      clickX: event.clientX,
      clickY: event.clientY,
      rect: latestRect ? {
        x: Math.max(0, Math.floor(latestRect.x)),
        y: Math.max(0, Math.floor(latestRect.y)),
        width: Math.max(0, Math.ceil(latestRect.width)),
        height: Math.max(0, Math.ceil(latestRect.height)),
      } : undefined,
      clickPosition: { x: event.clientX, y: event.clientY },
      devicePixelRatio: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1,
      scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      selectionType: 'element',
    };
    
    postToHost('INSPECTOR_ELEMENT_SELECTED', payload);
    cleanup();
    return;
  }
  cleanup();
};
```

---

### 8. Event Listeners

```javascript
// Lines 673-683: Register event handlers
overlay.addEventListener('mousemove', onMove, true);
overlay.addEventListener('click', onClick, true);
if (ALLOW_MARQUEE) {
  overlay.addEventListener('mousedown', handleDragStart, true);
  overlay.addEventListener('mouseup', handleDragEnd, true);
}
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('scroll', onScroll, true);
document.addEventListener('scroll', onScroll, true);
```

---

### File: `lib/conveyor/handlers/window-handler.ts`

### 9. Screenshot Capture (Electron Main Process)

```typescript
// Lines 205-229: Capture a region of the webview as PNG
handle('webview-capture-rect', async (
  contentId: number, 
  rect: { x: number; y: number; width: number; height: number; scaleFactor?: number }
) => {
  try {
    const contentWebContents = electronWebContents.fromId(contentId)
    if (!contentWebContents) {
      throw new Error(`Invalid webContents ID: ${contentId}`)
    }
    
    const safeRect = {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(0, Math.ceil(rect.width)),
      height: Math.max(0, Math.ceil(rect.height)),
    }
    
    const image = await contentWebContents.capturePage(safeRect as any)
    const size = image.getSize()
    const base64 = image.toPNG().toString('base64')
    
    return { base64, width: size.width, height: size.height }
  } catch (error) {
    console.error('[Window] Error capturing webview rect:', error)
    throw error
  }
})
```

---

### File: `app/components/ui/browser/utils/screenshot.ts`

### 10. Screenshot Utility

```typescript
// Lines 1-17: Convert base64 to File and capture element screenshot
import { base64ToImageFile, generateScreenshotFilename } from '@/app/utils/screenshotHelpers'

export async function captureElementScreenshot(
  windowApi: any,
  contentId: number,
  rect: { x: number; y: number; width: number; height: number },
  scaleFactor: number = 1,
): Promise<File> {
  const capture = await windowApi.webviewCaptureRect(contentId, {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    scaleFactor,
  })
  return base64ToImageFile(capture.base64, generateScreenshotFilename())
}
```

---

### File: `app/utils/screenshotHelpers.ts`

### 11. Base64 to File Conversion

```typescript
// Lines 1-27: Helper utilities
export function base64ToImageFile(base64: string, filename: string): File {
  const byteCharacters = atob(base64)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  const byteArray = new Uint8Array(byteNumbers)
  const blob = new Blob([byteArray], { type: 'image/png' })
  return new File([blob], filename, { type: 'image/png', lastModified: Date.now() })
}

export function generateScreenshotFilename(): string {
  const ts = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `screenshot-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.png`
}
```

