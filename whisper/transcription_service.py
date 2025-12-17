import asyncio
import time
import logging
from typing import Dict, Any, Optional
import torch
import whisper
from config import settings

logger = logging.getLogger(__name__)


class TranscriptionService:
    """Manages Whisper model and handles transcription requests"""

    def __init__(self):
        self.model = None
        self.device = None
        self.model_name = settings.model_name
        self.language = settings.language if settings.language.lower() != "auto" else None
        self.transcription_queue = asyncio.Queue()
        self.model_loaded = False

    async def initialize(self) -> None:
        """
        Load Whisper model on startup.
        This is an expensive operation (~1.5GB for medium model).
        """
        try:
            logger.info(f"Loading Whisper model: {self.model_name}")

            # Determine device
            if settings.device == "auto":
                self.device = "cuda" if torch.cuda.is_available() else "cpu"
            else:
                self.device = settings.device

            logger.info(f"Using device: {self.device}")

            # Load model in executor to avoid blocking
            loop = asyncio.get_event_loop()
            self.model = await loop.run_in_executor(
                None,
                whisper.load_model,
                self.model_name,
                self.device
            )

            self.model_loaded = True
            logger.info(f"Whisper model '{self.model_name}' loaded successfully")

        except Exception as e:
            logger.error(f"Failed to load Whisper model: {e}")
            self.model_loaded = False
            raise

    async def transcribe(self, audio_path: str) -> Dict[str, Any]:
        """
        Transcribe audio file using Whisper model.

        Args:
            audio_path: Path to WAV audio file

        Returns:
            Dictionary containing transcription result

        Raises:
            RuntimeError: If model is not loaded
            Exception: If transcription fails
        """
        if not self.model_loaded or self.model is None:
            raise RuntimeError("Whisper model not loaded")

        logger.info(f"Transcribing audio: {audio_path}")
        start_time = time.time()

        try:
            # Run transcription in executor to avoid blocking event loop
            loop = asyncio.get_event_loop()
            result = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    self._transcribe_sync,
                    audio_path
                ),
                timeout=settings.transcription_timeout
            )

            processing_time_ms = int((time.time() - start_time) * 1000)
            logger.info(
                f"Transcription complete in {processing_time_ms}ms: "
                f"{result['text'][:100]}..."
            )

            result['processing_time_ms'] = processing_time_ms
            return result

        except asyncio.TimeoutError:
            logger.error(f"Transcription timeout after {settings.transcription_timeout}s")
            raise TimeoutError(
                f"Transcription exceeded timeout of {settings.transcription_timeout}s"
            )
        except Exception as e:
            logger.error(f"Transcription failed: {e}")
            raise

    def _transcribe_sync(self, audio_path: str) -> Dict[str, Any]:
        """
        Synchronous transcription using Whisper model.
        Called via executor to avoid blocking.

        Args:
            audio_path: Path to WAV audio file

        Returns:
            Transcription result dictionary
        """
        try:
            # Configure transcription parameters
            transcribe_options = {
                "language": self.language,
                "task": "transcribe",
                "fp16": self.device == "cuda",
                "verbose": False,
                "temperature": 0.0,
                "best_of": 1,
                "beam_size": 5,
            }

            # Perform transcription
            result = self.model.transcribe(audio_path, **transcribe_options)

            return {
                "text": result["text"].strip(),
                "language": result.get("language", self.language or "unknown"),
                "segments": result.get("segments", []),
            }

        except torch.cuda.OutOfMemoryError:
            logger.error("GPU out of memory during transcription")
            raise RuntimeError("GPU out of memory. Try again or use CPU mode.")
        except Exception as e:
            logger.error(f"Transcription error: {e}")
            raise

    def get_available_languages(self) -> list[str]:
        """
        Get list of languages supported by Whisper.

        Returns:
            List of language codes
        """
        try:
            # Whisper supports 99 languages
            return list(whisper.tokenizer.LANGUAGES.keys())
        except Exception:
            return ["en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "zh", "ja", "ko"]

    def get_model_info(self) -> Dict[str, Any]:
        """
        Get information about loaded model.

        Returns:
            Dictionary with model information
        """
        return {
            "model_name": self.model_name,
            "device": self.device,
            "model_loaded": self.model_loaded,
            "language": self.language or "auto",
        }


transcription_service = TranscriptionService()
