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
import warnings
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, HTTPException, UploadFile, File
from PIL import Image

from painapple_code.session_store import SessionStore
from painapple_code.paths import DATA_HOME
from painapple_code.utils.file_paths import is_reserved_dos_name

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

# Decompression-bomb ceiling, in PIXELS — the byte cap above cannot bound this.
# PNG/WebP compress uniform data extremely well, so a ~100KB file can declare
# 30000x30000 and decode to gigabytes of RGBA. Pillow's default (~89M px) only
# *warns* and keeps decoding, and it raises only past 2x that, so relying on the
# default means the allocation happens first. 50M px (~200MB RGBA) is far above
# any real screenshot or photo and well under what hurts.
Image.MAX_IMAGE_PIXELS = 50_000_000

# Promote Pillow's DecompressionBombWarning to an exception so the guard is a
# refusal rather than a log line someone reads afterwards. The upload path
# already converts exceptions into a 400.
warnings.simplefilter('error', Image.DecompressionBombWarning)

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
        uploads_dir = DATA_HOME / "uploads" / "tmp"
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


# Longest filename we hand to the filesystem. NAME_MAX is 255 on ext4 and
# NTFS; 200 leaves room for the "-2", "-3" de-duplication suffixes callers
# append.
_MAX_NAME_LEN = 200


def _truncate_name(name: str) -> str:
    """Clamp to _MAX_NAME_LEN, keeping the extension when one can fit.

    PurePosixPath, not Path, for the same reason as the basename split
    below: nothing here should vary with the host OS. (No separators or
    colons survive to this point, so the two flavors agree — but pinning
    it keeps that true if the rules above ever change.)

    The old form was `name[:200 - len(ext)] + ext`, which for any suffix
    longer than 200 made the slice bound negative — `name[:-51]` chops the
    WRONG end and still returns an over-limit name (a 256-char input came
    back 251 chars). A suffix that alone busts the budget isn't an
    extension in any useful sense, so it gets clamped like any other text.
    """
    if len(name) <= _MAX_NAME_LEN:
        return name
    ext = PurePosixPath(name).suffix
    if len(ext) > _MAX_NAME_LEN:
        return name[:_MAX_NAME_LEN]
    return PurePosixPath(name).stem[:_MAX_NAME_LEN - len(ext)] + ext


def sanitize_filename(filename: str) -> str:
    """Sanitize a filename to prevent path traversal and other issues."""
    if not filename:
        raise ValueError("Empty filename")

    # Basename under BOTH path flavors, not whichever one the host happens to
    # be. `Path(filename).name` was platform-dependent in a way that changed
    # the result: WindowsPath("a:b.txt").name is "b.txt" — it reads "a:" as a
    # drive — while PosixPath's is "a:b.txt". So the same upload landed under
    # a different name depending on the server's OS, and the colon rule below
    # only ran on one of them. Splitting on both separators here makes every
    # platform agree (and "a:b.txt" reaches the ':' rule everywhere).
    filename = filename.replace('\\', '/').rsplit('/', 1)[-1]
    filename = "".join(c for c in filename if c.isprintable() and c not in '\x00')

    # NTFS forbids these outright; without stripping them the write fails
    # with an opaque OSError instead of a clean rejection.
    filename = "".join('_' if c in ':*?"<>|' else c for c in filename)

    # NTFS silently strips trailing dots and spaces, so "report." and
    # "report" become the same file — a quiet overwrite of someone else's
    # upload, and a way to smuggle a second name past a uniqueness check.
    filename = filename.rstrip(". ")

    # Length first, reserved-device check AFTER it. The other order is what
    # the comment here used to claim was safe ("before length truncation so
    # that truncating can't create one") and it was exactly backwards:
    # truncation is the step that CAN create one. `con` + 10 filler chars +
    # a 197-char extension passed the guard on stem "conxxxxxxxxxx", then
    # truncated to "con.yyy…" — a name Windows resolves to the CON console
    # device, so the upload's write_bytes went to the console.
    filename = _truncate_name(filename)
    filename = filename.rstrip(". ")

    # An alternate-data-stream suffix is gone with ':' above; device names
    # need their own check. Shared with the read-path screen in
    # utils.file_paths so the two can't disagree about what a device is —
    # this file's private copy had already drifted, accepting "nul .txt"
    # (Windows strips the trailing space and opens the device) that
    # is_path_allowed_for_read denies.
    #
    # Applied on EVERY platform, not just win32: uploads are shared (synced
    # dirs, a repo later cloned on Windows), and a Linux-hosted server
    # shouldn't be able to mint a file its Windows users can't open.
    if is_reserved_dos_name(filename):
        # The prefix can push a just-at-limit name one over, so re-clamp.
        # This can't loop: every truncation of "_…" still starts with "_",
        # which is not a device name.
        filename = _truncate_name("_" + filename).rstrip(". ")

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
        uploads_dir = DATA_HOME / "uploads" / "tmp"
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
