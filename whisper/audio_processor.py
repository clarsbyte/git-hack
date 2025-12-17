import os
import subprocess
import uuid
import asyncio
from pathlib import Path
from typing import Tuple
import logging
from config import settings

logger = logging.getLogger(__name__)


class AudioProcessor:
    """Handles audio file conversion and processing"""

    def __init__(self):
        self.temp_dir = Path(settings.temp_dir)
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.conversion_timeout = settings.conversion_timeout
        self.max_chunk_duration = settings.max_chunk_duration

    async def convert_webm_to_wav(self, webm_path: str) -> str:
        """
        Convert .webm audio file to .wav format suitable for Whisper.

        Args:
            webm_path: Path to input .webm file

        Returns:
            Path to converted .wav file

        Raises:
            subprocess.TimeoutExpired: If conversion takes too long
            subprocess.CalledProcessError: If ffmpeg conversion fails
        """
        wav_path = webm_path.replace('.webm', '.wav')

        ffmpeg_cmd = [
            'ffmpeg',
            '-i', webm_path,
            '-ar', '16000',  # 16kHz sample rate (Whisper requirement)
            '-ac', '1',      # Mono audio
            '-f', 'wav',     # WAV format
            '-y',            # Overwrite output file
            wav_path
        ]

        logger.info(f"Converting {webm_path} to WAV format")

        try:
            # Run ffmpeg asynchronously
            process = await asyncio.create_subprocess_exec(
                *ffmpeg_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=self.conversion_timeout
            )

            if process.returncode != 0:
                error_msg = stderr.decode() if stderr else "Unknown error"
                logger.error(f"FFmpeg conversion failed: {error_msg}")
                raise subprocess.CalledProcessError(
                    process.returncode,
                    ffmpeg_cmd,
                    stderr=stderr
                )

            logger.info(f"Successfully converted to {wav_path}")
            return wav_path

        except asyncio.TimeoutError:
            logger.error(f"Audio conversion timeout after {self.conversion_timeout}s")
            raise subprocess.TimeoutExpired(ffmpeg_cmd, self.conversion_timeout)

    def validate_audio_duration(self, audio_path: str) -> float:
        """
        Validate audio file duration.

        Args:
            audio_path: Path to audio file

        Returns:
            Duration in seconds

        Raises:
            ValueError: If audio is too long or invalid
        """
        try:
            cmd = [
                'ffprobe',
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                audio_path
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=5
            )

            if result.returncode != 0:
                raise ValueError("Failed to read audio file metadata")

            duration = float(result.stdout.strip())

            if duration > self.max_chunk_duration:
                raise ValueError(
                    f"Audio duration ({duration}s) exceeds maximum "
                    f"({self.max_chunk_duration}s)"
                )

            return duration

        except Exception as e:
            logger.error(f"Audio validation failed: {e}")
            raise

    async def save_upload_file(self, file_content: bytes, session_id: str, chunk_index: int) -> str:
        """
        Save uploaded audio file to temporary directory.

        Args:
            file_content: Raw file bytes
            session_id: Session identifier
            chunk_index: Chunk index number

        Returns:
            Path to saved file
        """
        filename = f"{session_id}_{chunk_index}_{uuid.uuid4().hex[:8]}.webm"
        file_path = self.temp_dir / filename

        logger.info(f"Saving upload to {file_path}")

        async with asyncio.Lock():
            with open(file_path, 'wb') as f:
                f.write(file_content)

        return str(file_path)

    async def cleanup_files(self, *file_paths: str) -> None:
        """
        Delete temporary audio files.

        Args:
            file_paths: Paths to files to delete
        """
        for file_path in file_paths:
            try:
                if file_path and os.path.exists(file_path):
                    os.remove(file_path)
                    logger.info(f"Deleted temporary file: {file_path}")
            except Exception as e:
                logger.error(f"Failed to delete {file_path}: {e}")

    async def cleanup_old_files(self) -> None:
        """
        Remove temporary files older than TTL.
        Called periodically by background task.
        """
        import time

        logger.info("Running cleanup of old temporary files")

        current_time = time.time()
        ttl = settings.temp_file_ttl
        deleted_count = 0

        for file_path in self.temp_dir.iterdir():
            if file_path.is_file():
                file_age = current_time - file_path.stat().st_mtime
                if file_age > ttl:
                    try:
                        file_path.unlink()
                        deleted_count += 1
                        logger.debug(f"Deleted old file: {file_path}")
                    except Exception as e:
                        logger.error(f"Failed to delete old file {file_path}: {e}")

        if deleted_count > 0:
            logger.info(f"Cleanup complete: deleted {deleted_count} old files")


audio_processor = AudioProcessor()
