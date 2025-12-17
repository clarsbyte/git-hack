from pydantic import BaseModel
from typing import Optional, Dict, Any


class TranscriptionResponse(BaseModel):
    """Response model for single chunk transcription"""
    session_id: str
    chunk_index: int
    text: str
    language: str
    confidence: Optional[float] = None
    processing_time_ms: int


class StreamingProgressEvent(BaseModel):
    """Model for SSE progress events"""
    status: str
    progress: Optional[float] = None
    message: Optional[str] = None


class StreamingPartialEvent(BaseModel):
    """Model for SSE partial result events"""
    text: str
    confidence: Optional[float] = None


class StreamingFinalEvent(BaseModel):
    """Model for SSE final result events"""
    text: str
    language: str
    confidence: Optional[float] = None
    processing_time_ms: int


class HealthCheckResponse(BaseModel):
    """Response model for health check endpoint"""
    status: str
    model_loaded: bool
    model_name: str
    device: str
    available_languages: list[str]


class ErrorResponse(BaseModel):
    """Standard error response model"""
    error: str
    message: str
    details: Optional[Dict[str, Any]] = None
