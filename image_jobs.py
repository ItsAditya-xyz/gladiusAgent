# image_jobs.py
import os
import uuid
import threading
import queue
import shutil
import pathlib
import requests
from typing import NamedTuple, Optional, List
import time
from db import supabase
from imageGen import createImage
from function import (
    uploadImage,
    replyToPost,
)
from logging_utils import get_logger

logger = get_logger(__name__)

# -------------------------
# Config / directories
# -------------------------
SAVE_DIR = os.getenv("AI_IMG_DIR", "./generated_images")
os.makedirs(SAVE_DIR, exist_ok=True)

TEMP_IMG_DIR = os.getenv("TEMP_IMG_DIR", "./temp_images")
pathlib.Path(TEMP_IMG_DIR).mkdir(parents=True, exist_ok=True)

# Optional: path to your GLADIUS base image for identity/style anchoring
GLADIUS_PATH = os.getenv("GLADIUS_IMAGE_PATH", "GLADIUS.jpg")

# Optional: bound the queue to avoid runaway memory under burst load
_Q_MAX = int(os.getenv("IMG_QUEUE_MAX", "200"))

# -------------------------
# Job structure / queue
# -------------------------
class ImageJob(NamedTuple):
    id: str
    prompt: str
    reply_to_post_id: str
    reply_to_user_id: str
    caption: Optional[str] = None
    context_image_urls: Optional[List[str]] = None

_q: "queue.Queue[ImageJob]" = queue.Queue(maxsize=_Q_MAX)
_started = False
_lock = threading.Lock()

# -------------------------
# Helpers
# -------------------------
def _safe_ext_from_content_type(ct: str) -> str:
    ct = (ct or "").lower()
    if "jpeg" in ct or "jpg" in ct:
        return ".jpg"
    if "png" in ct:
        return ".png"
    if "webp" in ct:
        return ".webp"
    return ".png"  # default

def _download_to_temp(url):
    """
    Download a remote image URL into TEMP_IMG_DIR and return its absolute path.
    Returns None on failure (kept quiet so the pipeline keeps flowing).
    """
    try:
        r = requests.get(url, timeout=25)
        r.raise_for_status()
        ext = _safe_ext_from_content_type(r.headers.get("Content-Type", ""))
        p = pathlib.Path(TEMP_IMG_DIR) / f"ctx_{os.urandom(3).hex()}{ext}"
        with open(p, "wb") as f:
            f.write(r.content)
        # basic sanity check
        if p.stat().st_size < 500:  # likely bad/empty
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass
            return None
        return str(p.resolve())
    except Exception:
        return None

# -------------------------
# Worker
# -------------------------
def _wants_gladius(prompt: str) -> bool:
    t = (prompt or "").lower()
    return ("gladius" in t) or ("@arenagladius" in t)

def _worker():
    def _safe_unlink(p, temp_root):
        try:
            if not p:
                return
            rp = str(pathlib.Path(p).resolve())
            if rp.startswith(temp_root) and os.path.isfile(rp):
                os.remove(rp)
        except Exception:
            pass

    temp_root = str(pathlib.Path(TEMP_IMG_DIR).resolve())

    while True:
        job = _q.get()
        to_delete: List[str] = []  # ctx downloads + generated temp files
        try:
            # 1) Context images → temp files
            context_paths: List[str] = []
            if job.context_image_urls:
                for u in job.context_image_urls[:3]:
                    # skip Arena profile/page URLs (HTML, not images)
                    if isinstance(u, str) and "arena.social/ArenaGladius" in u:
                        logger.info("skipping profile page url; using GLADIUS_PATH")
                        continue
                    p = _download_to_temp(u)
                    if p:
                        context_paths.append(p)
                        to_delete.append(p)

            # 2) Create image (retry on transient failure)
            max_attempts = int(os.getenv("IMG_CREATE_RETRY_ATTEMPTS", "2"))
            attempt, result, last_err = 0, None, None
            while attempt < max_attempts:
                attempt += 1
                try:
                    use_gladius = os.path.exists(GLADIUS_PATH) and _wants_gladius(job.prompt)
                    result = createImage(
                        prompt=job.prompt,
                        input_paths=context_paths or None,
                        gladius_path=GLADIUS_PATH if use_gladius else None,
                        max_images=1,
                    )
                    break
                except Exception as e:
                    last_err = e
                    time.sleep(min(2 ** attempt, 8))

            if result is None:
                replyToPost(job.reply_to_post_id, job.reply_to_user_id,
                            job.caption or f"Image forge stalled: {type(last_err).__name__}")
                # cleanup ctx temps
                for p in set(to_delete):
                    _safe_unlink(p, temp_root)
                _q.task_done()
                continue

            files = (result or {}).get("files") or []
            # mark generated temp files for cleanup
            for f in files:
                to_delete.append(f)

            if not files:
                msg = (result or {}).get("text") or (job.caption or "Image attempt failed.")
                replyToPost(job.reply_to_post_id, job.reply_to_user_id, msg)
                # cleanup temps
                for p in set(to_delete):
                    _safe_unlink(p, temp_root)
                _q.task_done()
                continue

            # 3) Persist a copy in SAVE_DIR
            src_path = files[0]
            ext = ".png"
            local_path = os.path.join(SAVE_DIR, f"{job.id}{ext}")
            try:
                shutil.copyfile(src_path, local_path)  # keep temp; we'll delete it below
            except Exception:
                try:
                    shutil.move(src_path, local_path)   # move removes temp; drop it from cleanup
                    if src_path in to_delete:
                        to_delete.remove(src_path)
                except Exception:
                    local_path = src_path  # lives in temp; we'll still clean after upload

            # 4) Upload + reply
            logger.info("uploading image")
            up = uploadImage(local_path)
            if not up.get("success"):
                resp = replyToPost(
                    job.reply_to_post_id,
                    job.reply_to_user_id,
                    f"{job.caption or 'Cooked an image'} but upload failed: {up.get('error') or 'unknown error'}",
                )
            else:
                resp = replyToPost(
                    job.reply_to_post_id,
                    job.reply_to_user_id,
                    job.caption or "Visual served.",
                    imageURL=up["url"],
                )

            # 5) Minimal DB log
            try:
                files_payload = resp.get("files")
                if not files_payload and up.get("url"):
                    files_payload = [{"url": up["url"], "fileType": "image"}]
                supabase.table("image_creations").insert({
                    "thread_id": resp.get("threadId") or job.reply_to_post_id,
                    "user_id":   resp.get("userId")   or job.reply_to_user_id,
                    "content":   resp.get("content")  or (job.caption or job.prompt),
                    "files":     files_payload or [],
                }).execute()
            except Exception as _e:
                logger.exception("logging image creation failed")

        except Exception as e:
            logger.exception("image job failed")
            replyToPost(job.reply_to_post_id, job.reply_to_user_id, f"Image job blew up: {e}")
        finally:
            # 6) cleanup temp files (ctx + generated)
            for p in set(to_delete):
                _safe_unlink(p, temp_root)
            _q.task_done()

# -------------------------
# Public API
# -------------------------
def start_worker():
    global _started
    with _lock:
        if _started:
            return
        t = threading.Thread(target=_worker, daemon=True)
        t.start()
        _started = True

def enqueue(
    prompt: str,
    reply_to_post_id: str,
    reply_to_user_id: str,
    caption,
    context_image_urls,
) -> str:
    """
    Queue an image generation job.
    Returns a job_id (used for local file naming and debugging).
    """
    start_worker()
    job_id = str(uuid.uuid4())
    _q.put(
        ImageJob(
            job_id,
            prompt,
            reply_to_post_id,
            reply_to_user_id,
            caption,
            context_image_urls or [],
        )
    )
    return job_id


def join_queue(timeout):
    # blocks until all queued tasks call task_done()
    _q.join()
