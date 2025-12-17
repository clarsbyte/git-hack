from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    """Configuration settings for Whisper service"""

    # Model settings
    model_name: str = "medium"
    device: str = "auto"
    language: str = "en"

    # Server settings
    host: str = "0.0.0.0"
    port: int = 8001

    # Processing settings
    max_chunk_duration: int = 30
    conversion_timeout: int = 10
    transcription_timeout: int = 60

    # Storage settings
    temp_dir: str = "./temp"
    cleanup_interval: int = 1800
    temp_file_ttl: int = 3600

    # CORS settings
    cors_origins: str = "*"

    class Config:
        env_file = ".env"
        env_prefix = "WHISPER_"

    @property
    def cors_origins_list(self) -> List[str]:
        """Parse CORS origins from comma-separated string"""
        if self.cors_origins == "*":
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",")]


settings = Settings()
