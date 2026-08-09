"""
Upload API Routes - Image and file upload endpoints

These endpoints provide:
- Image upload with automatic resizing for Claude
- File upload to session uploads directory
"""

import base64
import io
import logging
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File
from PIL import Image

from painapple_code.session_store import SessionStore
from painapple_code.bridge_paths import BRIDGE_HOME

logger = logging.getLogger(__name__)

router = APIRouter(tags=["upload"])

# Image processing constants
IMAGE_TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}

MAX_IMAGE_SIZE = 20 * 1024 * 1024  # 20MB upload limit
MAX_IMAGE_DIMENSION = 1568  # Claude's recommended max
TARGET_FILE_SIZE = 1 * 1024 * 1024  # Target ~1MB after processing

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB limit for file uploads


def resize_image_for_claude(image_data: bytes, content_type: str) -> tuple[bytes, str, dict]:
    """Resize image if needed for optimal Claude processing."""
    img = Image.open(io.BytesIO(image_data))
    original_size = len(image_data)
    original_dimensions = img.size

    if img.mode == 'RGBA':
        output_format = 'PNG'
        output_media_type = 'image/png'
    else:
        if img.mode != 'RGB':
            img = img.convert('RGB')
        output_format = 'JPEG'
        output_media_type = 'image/jpeg'

    width, height = img.size
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        ratio = min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height)
        new_size = (int(width * ratio), int(height * ratio))
        img = img.resize(new_size, Image.Resampling.LANCZOS)
        logger.info(f"Resized image from {original_dimensions} to {new_size}")

    output = io.BytesIO()
    if output_format == 'JPEG':
        img.save(output, format=output_format, quality=85, optimize=True)
    else:
        img.save(output, format=output_format, optimize=True)

    processed_data = output.getvalue()

    stats = {
        "original_size": original_size,
        "processed_size": len(processed_data),
        "original_dimensions": original_dimensions,
        "final_dimensions": img.size,
        "compression_ratio": round(original_size / len(processed_data), 2) if len(processed_data) > 0 else 1
    }

    return processed_data, output_media_type, stats


@router.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...), session: str = None):
    """Upload an image and return it as base64 for sending to Claude.
    Also saves the processed image to disk for persistence across page refresh."""
    content_type = file.content_type
    if content_type not in IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type: {content_type}. Supported: {list(IMAGE_TYPES.keys())}"
        )

    content = await file.read()

    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Image too large: {len(content)} bytes. Max: {MAX_IMAGE_SIZE} bytes"
        )

    try:
        processed_data, media_type, stats = resize_image_for_claude(content, content_type)
    except Exception as e:
        logger.error(f"Image processing failed: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to process image: {str(e)}")

    b64_data = base64.standard_b64encode(processed_data).decode('utf-8')

    # Save processed image to disk for persistence across page refresh
    ext = 'png' if media_type == 'image/png' else 'jpg'
    stored_name = f"img_{int(time.time())}_{secrets.token_hex(4)}.{ext}"

    if session and SessionStore.exists(session):
        uploads_dir = SessionStore.get_uploads_path(session)
    else:
        uploads_dir = BRIDGE_HOME / "uploads" / "tmp"
        uploads_dir.mkdir(parents=True, exist_ok=True)

    try:
        (uploads_dir / stored_name).write_bytes(processed_data)
    except Exception as e:
        logger.warning(f"Failed to persist uploaded image to disk: {e}")
        # Non-fatal — image still works in-memory, just won't survive refresh
        stored_name = None

    logger.info(f"Uploaded image: {file.filename}, "
                f"original={stats['original_size']/1024:.1f}KB {stats['original_dimensions']}, "
                f"processed={stats['processed_size']/1024:.1f}KB {stats['final_dimensions']}, "
                f"compression={stats['compression_ratio']}x"
                f"{f', stored={stored_name}' if stored_name else ''}")

    return {
        "success": True,
        "filename": file.filename,
        "stored_name": stored_name,
        "media_type": media_type,
        "original_size": stats["original_size"],
        "processed_size": stats["processed_size"],
        "dimensions": stats["final_dimensions"],
        "compression_ratio": stats["compression_ratio"],
        "image": {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": b64_data
            }
        }
    }


# Reserved DOS device names. Applied on EVERY platform, not just win32:
# uploads are shared (synced dirs, a repo later cloned on Windows), and a
# Linux-hosted bridge shouldn't be able to mint a file its Windows users
# can't open. `NUL.txt` addresses the device just like `NUL`, so the check
# is on the stem.
_WIN_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)


def sanitize_filename(filename: str) -> str:
    """Sanitize a filename to prevent path traversal and other issues."""
    if not filename:
        raise ValueError("Empty filename")

    filename = Path(filename).name
    filename = "".join(c for c in filename if c.isprintable() and c not in '\x00')
    filename = filename.replace('/', '_').replace('\\', '_')

    # NTFS forbids these outright; without stripping them the write fails
    # with an opaque OSError instead of a clean rejection.
    filename = "".join('_' if c in ':*?"<>|' else c for c in filename)

    # NTFS silently strips trailing dots and spaces, so "report." and
    # "report" become the same file — a quiet overwrite of someone else's
    # upload, and a way to smuggle a second name past a uniqueness check.
    filename = filename.rstrip(". ")

    # An alternate-data-stream suffix is gone with ':' above; the reserved
    # names still need their own check, before length truncation so that
    # truncating can't create one.
    if filename.split(".")[0].upper() in _WIN_RESERVED:
        filename = "_" + filename

    if len(filename) > 200:
        name, ext = Path(filename).stem, Path(filename).suffix
        filename = name[:200 - len(ext)] + ext
        filename = filename.rstrip(". ")

    if not filename or filename in ('.', '..'):
        raise ValueError("Invalid filename after sanitization")

    return filename


@router.post("/api/upload-file")
async def upload_file(file: UploadFile = File(...), session: str = None):
    """Upload a file to the session's uploads directory (or temp dir if no session yet)."""
    content = await file.read()

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large: {len(content)} bytes. Max: {MAX_FILE_SIZE} bytes (10MB)"
        )

    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        safe_name = sanitize_filename(file.filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Use session uploads dir if available, otherwise a shared temp dir
    if session and SessionStore.exists(session):
        uploads_dir = SessionStore.get_uploads_path(session)
    else:
        uploads_dir = BRIDGE_HOME / "uploads" / "tmp"
        uploads_dir.mkdir(parents=True, exist_ok=True)

    target_path = uploads_dir / safe_name

    try:
        target_path.write_bytes(content)
    except Exception as e:
        logger.error(f"Failed to write uploaded file: {e}")
        raise HTTPException(status_code=500, detail="Failed to save file")

    logger.info(f"Uploaded file: {file.filename} -> {target_path} ({len(content)} bytes)")

    return {
        "success": True,
        "filename": file.filename,
        "stored_name": safe_name,
        "path": str(target_path.resolve()),
        "size": len(content),
    }
