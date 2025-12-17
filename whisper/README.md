# Whisper Speech-to-Text Service

A standalone FastAPI service that provides real-time speech-to-text transcription using OpenAI Whisper.

## Features

- Real-time speech-to-text transcription
- Supports .webm audio chunks from web frontends
- Streaming results via Server-Sent Events (SSE)
- Multiple Whisper model support (base, small, medium, large, turbo)
- Automatic audio format conversion
- Session-based tracking
- CORS-enabled for web integration

## Installation

### Prerequisites

- Python 3.10+
- ffmpeg (already installed at `/usr/bin/ffmpeg`)
- Conda environment `scale-mvp`

### Setup

1. Activate the conda environment:
```bash
conda activate scale-mvp
```

2. Navigate to the whisper directory:
```bash
cd /home/vkommera/Documents/hackathon/git-hack/whisper
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Configure environment (optional):
```bash
cp .env.example .env
# Edit .env to customize settings
```

## Usage

### Start the Service

```bash
python main.py
```

The service will start on `http://localhost:8001` by default.

### API Endpoints

#### Health Check
```bash
GET /health
```

Returns service status and model information.

#### Transcribe Chunk (Simple)
```bash
POST /transcribe/chunk
```

Accepts multipart form data with:
- `audio`: .webm audio file (required)
- `session_id`: Session identifier (optional)
- `chunk_index`: Chunk number (optional)

Returns JSON:
```json
{
  "session_id": "uuid",
  "chunk_index": 0,
  "text": "transcribed text",
  "language": "en",
  "processing_time_ms": 250
}
```

#### Transcribe Stream (SSE)
```bash
POST /transcribe/stream
```

Same parameters as `/transcribe/chunk`, but streams progress via SSE:

Events:
- `progress`: Processing status updates
- `final`: Final transcription result
- `error`: Error details
- `done`: Stream complete

### Testing

#### Health Check
```bash
curl http://localhost:8001/health
```

#### Transcribe Audio
```bash
curl -X POST http://localhost:8001/transcribe/chunk \
  -F "audio=@test.webm" \
  -F "session_id=test-123" \
  -F "chunk_index=0"
```

#### Stream Transcription
```bash
curl -X POST http://localhost:8001/transcribe/stream \
  -F "audio=@test.webm" \
  --no-buffer
```

## Frontend Integration

### JavaScript Example

```javascript
// Simple transcription
async function transcribeChunk(audioBlob, sessionId, chunkIndex) {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'chunk.webm');
  formData.append('session_id', sessionId);
  formData.append('chunk_index', chunkIndex);

  const response = await fetch('http://localhost:8001/transcribe/chunk', {
    method: 'POST',
    body: formData
  });

  const result = await response.json();
  return result.text;
}

// Streaming transcription with MediaRecorder
const mediaRecorder = new MediaRecorder(stream, {
  mimeType: 'audio/webm;codecs=opus'
});

let chunkIndex = 0;
const sessionId = crypto.randomUUID();

mediaRecorder.ondataavailable = async (event) => {
  if (event.data.size > 0) {
    const text = await transcribeChunk(event.data, sessionId, chunkIndex++);
    console.log('Transcription:', text);
  }
};

// Emit chunks every 5 seconds
mediaRecorder.start(5000);
```

## Configuration

Environment variables (see `.env.example`):

- `WHISPER_MODEL_NAME`: Model to use (tiny, base, small, medium, large, turbo) - default: `medium`
- `WHISPER_DEVICE`: Device (auto, cuda, cpu) - default: `auto`
- `WHISPER_LANGUAGE`: Language code (en, es, fr, etc.) or `auto` - default: `en`
- `WHISPER_PORT`: Service port - default: `8001`
- `WHISPER_MAX_CHUNK_DURATION`: Max audio duration in seconds - default: `30`

## Architecture

```
whisper/
├── main.py                    # FastAPI app, endpoints
├── transcription_service.py   # Whisper model management
├── audio_processor.py         # Audio conversion (ffmpeg)
├── models.py                  # Pydantic schemas
├── config.py                  # Configuration
├── requirements.txt           # Dependencies
└── temp/                      # Temporary audio files
```

## Audio Processing Pipeline

1. Receive .webm audio chunk
2. Save to temp directory
3. Convert to WAV (16kHz mono) using ffmpeg
4. Transcribe with Whisper
5. Return result
6. Cleanup temporary files

## Performance Notes

- **Medium model**: ~1.5GB RAM, ~0.5-2s per 5s audio (CPU), ~0.1-0.5s (GPU)
- **First request**: May take longer due to model loading
- **Concurrent requests**: Serialized to prevent GPU memory issues
- **Temp files**: Auto-cleanup every 30 minutes

## Troubleshooting

### Service won't start
- Check that conda environment is activated
- Verify all dependencies are installed
- Check port 8001 is not in use

### Model loading fails
- Ensure sufficient RAM (2GB+ for medium model)
- Check internet connection (first run downloads model)
- Try smaller model: `WHISPER_MODEL_NAME=small`

### Transcription errors
- Verify audio format is .webm
- Check audio duration < 30 seconds
- Ensure ffmpeg is installed and accessible

### GPU not detected
- Check CUDA installation
- Set `WHISPER_DEVICE=cpu` to force CPU mode

## License

See project root license file.
