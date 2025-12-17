from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional
import uuid
from PIL import Image


@dataclass
class Message:
    """Represents a single message in the conversation"""
    role: str  # 'user' or 'bot'
    text: str
    timestamp: datetime
    screenshot: Optional[Image.Image] = None


@dataclass
class Session:
    """Represents a conversation session with history"""
    id: str
    messages: List[Message] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    last_activity: datetime = field(default_factory=datetime.now)

    def add_message(self, role: str, text: str, screenshot: Optional[Image.Image] = None):
        """Add a message to the session history"""
        self.messages.append(Message(role, text, datetime.now(), screenshot))
        self.last_activity = datetime.now()

        # Keep only last 10 messages to prevent memory bloat
        if len(self.messages) > 10:
            self.messages = self.messages[-10:]

    def is_expired(self, ttl_minutes: int = 60) -> bool:
        """Check if session has expired"""
        return datetime.now() - self.last_activity > timedelta(minutes=ttl_minutes)

    def get_conversation_history(self) -> str:
        """Get formatted conversation history for LUX task generation"""
        return "\n".join([
            f"{msg.role.upper()}: {msg.text}"
            for msg in self.messages
        ])

    def get_latest_screenshot(self) -> Optional[Image.Image]:
        """Get the most recent screenshot from conversation history"""
        for msg in reversed(self.messages):
            if msg.screenshot:
                return msg.screenshot
        return None


class SessionManager:
    """Manages conversation sessions across browser tabs"""

    def __init__(self):
        self.sessions: Dict[str, Session] = {}

    def create_session(self) -> Session:
        """Create a new session"""
        session_id = str(uuid.uuid4())
        session = Session(id=session_id)
        self.sessions[session_id] = session
        return session

    def get_session(self, session_id: str) -> Optional[Session]:
        """Get a session by ID, returns None if expired or not found"""
        session = self.sessions.get(session_id)
        if session and session.is_expired():
            del self.sessions[session_id]
            return None
        return session

    def get_or_create_session(self, session_id: Optional[str]) -> Session:
        """Get existing session or create new one"""
        if session_id:
            session = self.get_session(session_id)
            if session:
                return session
        return self.create_session()

    def cleanup_expired_sessions(self):
        """Remove all expired sessions"""
        expired = [sid for sid, s in self.sessions.items() if s.is_expired()]
        for sid in expired:
            del self.sessions[sid]

        if expired:
            print(f"Cleaned up {len(expired)} expired sessions")
