/**
 * VLM Detector - Vision-Language Model integration for UI element detection
 *
 * Uses local VLM backend to visually identify elements when DOM-based methods
 * are ambiguous or insufficient. Maps VLM bounding boxes to DOM elements via IoU.
 */

import { ElementIndexer } from './elementIndexer'

// VLM backend configuration
const VLM_BACKEND_URL = 'http://localhost:8000'
const VLM_CACHE_TIMEOUT = 5000 // 5 seconds

// Normalized bounding box (0-1 coordinates)
interface NormalizedBBox {
    x: number
    y: number
    width: number
    height: number
}

// Absolute bounding box (pixel coordinates)
interface AbsoluteBBox {
    x: number
    y: number
    width: number
    height: number
}

// VLM detection result
interface VLMDetection {
    label: string
    confidence: number
    bbox: NormalizedBBox
    bbox_absolute: AbsoluteBBox
}

// VLM API response
interface VLMResponse {
    detections: VLMDetection[]
    model_latency_ms: number
    reasoning: string
    error?: string
}

// Element detection result with DOM mapping
export interface VLMElementResult {
    element: HTMLElement
    index: number
    confidence: number
    detection: VLMDetection
}

// Simple cache for VLM results
interface CacheEntry {
    result: VLMResponse
    timestamp: number
}

const vlmCache = new Map<string, CacheEntry>()

/**
 * Capture screenshot of current viewport (with Site Tutor UI hidden)
 */
async function captureScreenshot(): Promise<string> {
    // Import the screenshot helper (dynamic import to avoid circular deps)
    const { hideSiteTutorUI, restoreSiteTutorUI } = await import('./screenshotHelper')

    // Hide Site Tutor UI before capture
    const hiddenState = hideSiteTutorUI()

    try {
        // Wait a frame to ensure UI is hidden
        await new Promise(resolve => requestAnimationFrame(resolve))

        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { type: 'CAPTURE_SCREENSHOT' },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError)
                        return
                    }
                    if (response && response.screenshot) {
                        resolve(response.screenshot)
                    } else {
                        reject(new Error('Failed to capture screenshot'))
                    }
                }
            )
        })
    } finally {
        // Always restore UI
        restoreSiteTutorUI(hiddenState)
    }
}

/**
 * Compress screenshot to reduce VLM API payload size
 */
async function compressScreenshot(
    base64Image: string,
    maxWidth: number = 1920,
    maxHeight: number = 1080,
    quality: number = 0.75
): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            // Calculate new dimensions maintaining aspect ratio
            let width = img.width
            let height = img.height

            if (width > maxWidth || height > maxHeight) {
                const ratio = Math.min(maxWidth / width, maxHeight / height)
                width = Math.round(width * ratio)
                height = Math.round(height * ratio)
            }

            // Create canvas and compress
            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height

            const ctx = canvas.getContext('2d')
            if (!ctx) {
                reject(new Error('Failed to get canvas context'))
                return
            }

            ctx.drawImage(img, 0, 0, width, height)

            // Convert to JPEG with quality setting
            const compressed = canvas.toDataURL('image/jpeg', quality)
            resolve(compressed)
        }

        img.onerror = () => reject(new Error('Failed to load image'))
        img.src = base64Image
    })
}

/**
 * Call VLM backend to detect elements
 */
async function callVLMBackend(
    screenshot: string,
    query: string,
    viewportWidth: number,
    viewportHeight: number
): Promise<VLMResponse> {
    const response = await fetch(`${VLM_BACKEND_URL}/vlm-detect`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            screenshot,
            query,
            viewport_width: viewportWidth,
            viewport_height: viewportHeight,
        }),
    })

    if (!response.ok) {
        throw new Error(`VLM backend error: ${response.status} ${response.statusText}`)
    }

    return response.json()
}

/**
 * Calculate Intersection over Union (IoU) between two bounding boxes
 */
function calculateIoU(bbox1: AbsoluteBBox, bbox2: DOMRect): number {
    // Convert DOMRect to AbsoluteBBox format
    const box2: AbsoluteBBox = {
        x: bbox2.x,
        y: bbox2.y,
        width: bbox2.width,
        height: bbox2.height,
    }

    // Calculate intersection
    const x1 = Math.max(bbox1.x, box2.x)
    const y1 = Math.max(bbox1.y, box2.y)
    const x2 = Math.min(bbox1.x + bbox1.width, box2.x + box2.width)
    const y2 = Math.min(bbox1.y + bbox1.height, box2.y + box2.height)

    if (x2 < x1 || y2 < y1) return 0

    const intersection = (x2 - x1) * (y2 - y1)

    // Calculate union
    const area1 = bbox1.width * bbox1.height
    const area2 = box2.width * box2.height
    const union = area1 + area2 - intersection

    return intersection / union
}

/**
 * Map VLM bounding box to DOM element via IoU
 */
function mapBBoxToElement(
    detection: VLMDetection,
    indexer: ElementIndexer,
    iouThreshold: number = 0.5
): VLMElementResult | null {
    const bbox = detection.bbox_absolute

    let bestMatch: VLMElementResult | null = null
    let bestIoU = iouThreshold

    // First try visible elements only (faster, more accurate)
    const visibleElements = indexer.getVisibleElements()

    for (const { index, element, rect } of visibleElements) {
        const iou = calculateIoU(bbox, rect)

        if (iou > bestIoU) {
            bestIoU = iou
            bestMatch = {
                element,
                index,
                confidence: iou,
                detection,
            }
        }
    }

    // If no good match found in visible elements, try all elements
    if (!bestMatch && iouThreshold > 0.3) {
        console.log('🔍 [VLM] No visible match, trying all elements with lower threshold...')

        const allElements = indexer.getAllElements()
        for (const { index, element, rect } of allElements) {
            const iou = calculateIoU(bbox, rect)

            if (iou > 0.3) {
                bestIoU = iou
                bestMatch = {
                    element,
                    index,
                    confidence: iou,
                    detection,
                }
            }
        }
    }

    return bestMatch
}

/**
 * Detect element using VLM
 */
export async function detectElementWithVLM(
    query: string,
    indexer: ElementIndexer,
    options: {
        useCache?: boolean
        iouThreshold?: number
        compressScreenshot?: boolean
    } = {}
): Promise<VLMElementResult | null> {
    const {
        useCache = true,
        iouThreshold = 0.5,
        compressScreenshot: shouldCompress = true,
    } = options

    try {
        // Check cache
        const cacheKey = `${window.location.href}-${query}`
        if (useCache) {
            const cached = vlmCache.get(cacheKey)
            if (cached && Date.now() - cached.timestamp < VLM_CACHE_TIMEOUT) {
                console.log('🎯 [VLM] Using cached result')
                const detection = cached.result.detections[0]
                if (detection) {
                    return mapBBoxToElement(detection, indexer, iouThreshold)
                }
            }
        }

        // Capture screenshot
        console.log('📸 [VLM] Capturing screenshot...')
        let screenshot = await captureScreenshot()

        // Compress if needed
        if (shouldCompress) {
            console.log('🗜️ [VLM] Compressing screenshot...')
            screenshot = await compressScreenshot(screenshot)
        }

        // Get viewport dimensions
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight

        // Call VLM backend
        console.log('🔍 [VLM] Calling backend...')
        const startTime = Date.now()
        const result = await callVLMBackend(screenshot, query, viewportWidth, viewportHeight)
        const totalLatency = Date.now() - startTime

        console.log(`✅ [VLM] Detection complete (${totalLatency}ms total, ${result.model_latency_ms}ms model)`)
        console.log(`   Detections: ${result.detections.length}`)
        console.log(`   Reasoning: ${result.reasoning}`)

        if (result.error) {
            console.warn(`⚠️ [VLM] Error: ${result.error}`)
            return null
        }

        // Cache result
        if (useCache) {
            vlmCache.set(cacheKey, {
                result,
                timestamp: Date.now(),
            })
        }

        // Map first detection to DOM element
        if (result.detections.length === 0) {
            console.warn('⚠️ [VLM] No detections found')
            return null
        }

        const detection = result.detections[0]
        const mapped = mapBBoxToElement(detection, indexer, iouThreshold)

        if (mapped) {
            console.log(`✅ [VLM] Mapped to element index ${mapped.index} (IoU: ${mapped.confidence.toFixed(2)})`)
        } else {
            console.warn('⚠️ [VLM] Could not map bbox to DOM element (IoU too low)')
        }

        return mapped

    } catch (error) {
        console.error('❌ [VLM] Detection failed:', error)
        return null
    }
}

/**
 * Check if VLM backend is available
 */
export async function isVLMAvailable(): Promise<boolean> {
    try {
        const response = await fetch(`${VLM_BACKEND_URL}/vlm-health`, {
            method: 'GET',
        })

        if (!response.ok) return false

        const data = await response.json()
        return data.vlm_available && data.model_loaded

    } catch (error) {
        console.warn('⚠️ [VLM] Backend not available:', error)
        return false
    }
}

/**
 * Clear VLM result cache
 */
export function clearVLMCache(): void {
    vlmCache.clear()
    console.log('🗑️ [VLM] Cache cleared')
}

/**
 * Get VLM cache statistics
 */
export function getVLMCacheStats(): { size: number; entries: string[] } {
    return {
        size: vlmCache.size,
        entries: Array.from(vlmCache.keys()),
    }
}
