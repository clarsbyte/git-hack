import asyncio
import logging
import sys
import uuid
import json
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

from config import settings
from models import (
    TranscriptionResponse,
    HealthCheckResponse,
    ErrorResponse,
    StreamingProgressEvent,
    StreamingFinalEvent
)
from audio_processor import audio_processor
from transcription_service import transcription_service

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)

app = FastAPI(title="Whisper Speech-to-Text Service", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Streaming queues for SSE
streaming_queues = {}


@app.on_event("startup")
async def startup_event():
    """Initialize services on startup"""
    logger.info("Starting Whisper service...")

    try:
        # Load Whisper model
        await transcription_service.initialize()
        logger.info("Whisper model loaded successfully")
    except Exception as e:
        logger.error(f"Failed to load Whisper model: {e}")
        logger.warning("Service will start but transcription endpoints will return errors")

    # Start background cleanup task
    asyncio.create_task(cleanup_task())
    logger.info(f"Whisper service started on port {settings.port}")


async def cleanup_task():
    """Periodic cleanup of old temporary files"""
    while True:
        await asyncio.sleep(settings.cleanup_interval)
        try:
            await audio_processor.cleanup_old_files()
        except Exception as e:
            logger.error(f"Cleanup task error: {e}")


@app.get("/health", response_model=HealthCheckResponse)
async def health_check():
    """
    Health check endpoint.
    Returns service status and model information.
    """
    model_info = transcription_service.get_model_info()

    return HealthCheckResponse(
        status="healthy" if transcription_service.model_loaded else "degraded",
        model_loaded=transcription_service.model_loaded,
        model_name=model_info["model_name"],
        device=model_info["device"],
        available_languages=transcription_service.get_available_languages()[:10]
    )


@app.post("/transcribe/chunk", response_model=TranscriptionResponse)
async def transcribe_chunk(
    audio: UploadFile = File(...),
    session_id: Optional[str] = Form(None),
    chunk_index: Optional[int] = Form(0)
):
    """
    Transcribe a single audio chunk.

    Args:
        audio: .webm audio file
        session_id: Optional session identifier
        chunk_index: Optional chunk index number

    Returns:
        TranscriptionResponse with text and metadata
    """
    if not transcription_service.model_loaded:
        raise HTTPException(
            status_code=503,
            detail="Whisper model not loaded. Service is starting up or degraded."
        )

    # Generate session ID if not provided
    if not session_id:
        session_id = str(uuid.uuid4())

    webm_path = None
    wav_path = None

    try:
        # Read and save uploaded file
        file_content = await audio.read()
        logger.info(f"Received audio chunk: {len(file_content)} bytes")

        webm_path = await audio_processor.save_upload_file(
            file_content, session_id, chunk_index
        )

        # Validate audio duration
        try:
            duration = audio_processor.validate_audio_duration(webm_path)
            logger.info(f"Audio duration: {duration:.2f}s")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # Convert to WAV
        try:
            wav_path = await audio_processor.convert_webm_to_wav(webm_path)
        except Exception as e:
            logger.error(f"Audio conversion failed: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Audio conversion failed: {str(e)}"
            )

        # Transcribe
        try:
            result = await transcription_service.transcribe(wav_path)
        except TimeoutError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except Exception as e:
            logger.error(f"Transcription failed: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Transcription failed: {str(e)}"
            )

        # Return response
        return TranscriptionResponse(
            session_id=session_id,
            chunk_index=chunk_index,
            text=result["text"],
            language=result["language"],
            processing_time_ms=result["processing_time_ms"]
        )

    finally:
        # Cleanup temporary files
        await audio_processor.cleanup_files(webm_path, wav_path)


@app.post("/transcribe/stream")
async def transcribe_stream(
    audio: UploadFile = File(...),
    session_id: Optional[str] = Form(None),
    chunk_index: Optional[int] = Form(0)
):
    """
    Transcribe audio chunk with streaming progress via SSE.

    Args:
        audio: .webm audio file
        session_id: Optional session identifier
        chunk_index: Optional chunk index number

    Returns:
        StreamingResponse with SSE events
    """
    if not transcription_service.model_loaded:
        raise HTTPException(
            status_code=503,
            detail="Whisper model not loaded. Service is starting up or degraded."
        )

    # Generate session ID if not provided
    if not session_id:
        session_id = str(uuid.uuid4())

    # Create unique stream ID
    stream_id = f"{session_id}_{chunk_index}_{uuid.uuid4().hex[:8]}"

    # Create queue for this stream
    queue = asyncio.Queue()
    streaming_queues[stream_id] = queue

    # Start background processing
    asyncio.create_task(
        process_audio_stream(audio, session_id, chunk_index, queue)
    )

    # Return SSE stream
    return StreamingResponse(
        stream_events(stream_id, queue),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


async def process_audio_stream(
    audio: UploadFile,
    session_id: str,
    chunk_index: int,
    queue: asyncio.Queue
):
    """
    Background task to process audio and send progress updates via queue.
    """
    webm_path = None
    wav_path = None

    try:
        # Read uploaded file
        file_content = await audio.read()
        logger.info(f"Processing stream: {len(file_content)} bytes")

        # Progress: Saving
        await queue.put({
            "event_type": "progress",
            "data": StreamingProgressEvent(
                status="saving",
                progress=0.1,
                message="Saving audio file"
            ).dict()
        })

        # Save file
        webm_path = await audio_processor.save_upload_file(
            file_content, session_id, chunk_index
        )

        # Validate duration
        try:
            duration = audio_processor.validate_audio_duration(webm_path)
        except ValueError as e:
            await queue.put({
                "event_type": "error",
                "data": {"error": "invalid_audio", "message": str(e)}
            })
            await queue.put(None)
            return

        # Progress: Converting
        await queue.put({
            "event_type": "progress",
            "data": StreamingProgressEvent(
                status="converting",
                progress=0.3,
                message="Converting audio format"
            ).dict()
        })

        # Convert to WAV
        wav_path = await audio_processor.convert_webm_to_wav(webm_path)

        # Progress: Transcribing
        await queue.put({
            "event_type": "progress",
            "data": StreamingProgressEvent(
                status="transcribing",
                progress=0.6,
                message="Transcribing audio"
            ).dict()
        })

        # Transcribe
        result = await transcription_service.transcribe(wav_path)

        # Send final result
        await queue.put({
            "event_type": "final",
            "data": StreamingFinalEvent(
                text=result["text"],
                language=result["language"],
                processing_time_ms=result["processing_time_ms"]
            ).dict()
        })

    except Exception as e:
        logger.error(f"Stream processing error: {e}")
        await queue.put({
            "event_type": "error",
            "data": {"error": "processing_failed", "message": str(e)}
        })

    finally:
        # Cleanup
        await audio_processor.cleanup_files(webm_path, wav_path)
        # Signal end of stream
        await queue.put(None)


async def stream_events(stream_id: str, queue: asyncio.Queue):
    """
    Async generator that yields SSE-formatted events.
    """
    logger.info(f"Starting SSE stream: {stream_id}")

    try:
        while True:
            event = await queue.get()

            if event is None:
                # Stream complete
                logger.info(f"Stream complete: {stream_id}")
                yield "event: done\ndata: null\n\n"
                break

            # Format as SSE event
            event_type = event.get("event_type", "message")
            event_data = event.get("data", {})

            yield f"event: {event_type}\ndata: {json.dumps(event_data)}\n\n"

    except Exception as e:
        logger.error(f"Stream error: {e}")
        yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    finally:
        # Cleanup queue
        if stream_id in streaming_queues:
            del streaming_queues[stream_id]


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    """Global exception handler"""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(
            error="internal_error",
            message="An unexpected error occurred"
        ).dict()
    )


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info"
    )
