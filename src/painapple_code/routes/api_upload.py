"""
Upload API Routes - Image and file upload endpoints

These endpoints provide:
- Image upload with automatic resizing for Claude
- File upload to the project's uploads directory

Both land in ``projects/{hash}/uploads/`` (see uploads_store.py) and share one
size cap, configurable in Settings (``upload_max_mb``, default 128 MiB).
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

from painapple_code import uploads_store
from painapple_code.session_store import SessionStore
from painapple_code.paths import DATA_HOME
from painapple_code.utils.file_paths import is_reserved_dos_name

logger = logging.getLogger("painapple-code.uploads")

router = APIRouter(tags=["upload"])

# Image processing constants
IMAGE_TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}

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

# Streamed in chunks so a large upload is never held in memory whole.
_CHUNK = 1024 * 1024


def _too_large(size: int, limit: int, kind: str = "File") -> HTTPException:
    """413 with a human-readable message the client shows verbatim."""
    return HTTPException(
        status_code=413,
        detail=(f"{kind} too large: {size / 1048576:.1f} MB. "
                f"Max upload size is {limit // 1048576} MB (Settings → System)."),
    )


def _session_store(session: str | None):
    """The SessionStore owning ``session``, or None (no session yet)."""
    if not session:
        return None
    store, _ = SessionStore._find_session(session)
    return store


def _tmp_dir() -> Path:
    d = DATA_HOME / "uploads" / "tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


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

    limit = uploads_store.get_upload_max_bytes()
    content = await file.read(limit + 1)
    if len(content) > limit:
        raise _too_large(file.size or len(content), limit, "Image")

    try:
        processed_data, media_type, stats = resize_image_for_claude(content, content_type)
    except Exception as e:
        logger.error(f"Image processing failed: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to process image: {str(e)}")

    b64_data = base64.standard_b64encode(processed_data).decode('utf-8')

    # Save processed image to disk for persistence across page refresh
    ext = 'png' if media_type == 'image/png' else 'jpg'
    stored_name = f"img_{int(time.time())}_{secrets.token_hex(4)}.{ext}"

    store = _session_store(session)
    try:
        if store is not None:
            # Hash recorded so the chat handler can recognise these exact
            # bytes when the image comes back inline with the prompt, instead
            # of storing a second copy (uploads_store.find_by_hash).
            stored_name = uploads_store.write_bytes(
                store, session, stored_name, processed_data,
                original_name=file.filename, record_hash=True,
            ).name
        else:
            (_tmp_dir() / stored_name).write_bytes(processed_data)
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
    """Upload a file to the project's uploads directory (or a temp dir if
    there is no session yet). Streamed to disk; over the cap → 413."""
    limit = uploads_store.get_upload_max_bytes()
    # Starlette sets .size once the multipart part is fully received — reject
    # up front without touching the disk when it's known.
    if file.size is not None and file.size > limit:
        raise _too_large(file.size, limit)

    try:
        safe_name = sanitize_filename(file.filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    store = _session_store(session)
    if store is not None:
        target_path = uploads_store.reserve(store, session, safe_name, file.filename)
    else:
        target_path = _tmp_dir() / safe_name

    size = 0
    try:
        with open(target_path, "wb") as out:
            while chunk := await file.read(_CHUNK):
                size += len(chunk)
                if size > limit:
                    raise _too_large(file.size or size, limit)
                out.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Empty file")
    except HTTPException:
        _discard(store, target_path)
        raise
    except Exception as e:
        _discard(store, target_path)
        logger.error(f"Failed to write uploaded file: {e}")
        raise HTTPException(status_code=500, detail="Failed to save file")

    if store is not None:
        uploads_store.finalize(target_path, size)

    logger.info(f"Uploaded file: {file.filename} -> {target_path} ({size} bytes)")

    return {
        "success": True,
        "filename": file.filename,
        "stored_name": target_path.name,
        "path": str(target_path.resolve()),
        "size": size,
    }


def _discard(store, path: Path) -> None:
    if store is not None:
        uploads_store.discard(path)
    else:
        path.unlink(missing_ok=True)
