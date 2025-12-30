# imageGen.py
import os, io, tempfile, pathlib, time
from typing import List, Optional, Dict, Any
from PIL import Image
from google import genai
from google.genai import types
from google.genai import errors as genai_errors

_API_KEY = os.getenv("GENAI_API_KEY") or os.getenv("GOOGLE_API_KEY") or os.getenv("GOOGLE_GENAI_API_KEY")
if not _API_KEY:
    raise RuntimeError("Set GENAI_API_KEY (or GOOGLE_API_KEY) in environment.")

_CLIENT = genai.Client(api_key=_API_KEY)

# Primary and fallback models (tweak via env if you want)
_MODEL_PRIMARY  = os.getenv("GENAI_IMAGE_MODEL", "gemini-2.5-flash-image")
_MODEL_FALLBACK = os.getenv("GENAI_IMAGE_MODEL_FALLBACK", "gemini-2.0-flash-exp")  # safe-ish fallback
_MAX_ATTEMPTS   = int(os.getenv("GENAI_RETRY_ATTEMPTS", "3"))
_BASE_SLEEP     = float(os.getenv("GENAI_RETRY_BASE_SLEEP", "1.5"))

_TEMP_DIR = pathlib.Path(os.getenv("TEMP_IMG_DIR", "./temp_images"))
_TEMP_DIR.mkdir(parents=True, exist_ok=True)

def _load_image_as_pil(path: str) -> Image.Image:
    img = Image.open(path).convert("RGB")  # normalize
    img.load()
    return img

def _save_inline_image(data: bytes) -> str:
    b = io.BytesIO(data)
    img = Image.open(b).convert("RGB")
    img.load()
    out_path = _TEMP_DIR / f"genai_{os.urandom(4).hex()}.png"
    img.save(out_path, format="PNG")
    return str(out_path.resolve())

def _gen_once(model: str, contents: list) -> Dict[str, Any]:
    resp = _CLIENT.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(max_output_tokens=2048),
    )
    # Extract any returned image parts; save as PNG
    files: List[str] = []
    text_parts: List[str] = []
    cand = (resp.candidates or [None])[0]
    if not cand:
        return {"files": [], "text": "no candidates"}
    for part in cand.content.parts:
        if getattr(part, "inline_data", None) and part.inline_data.data:
            try:
                path = _save_inline_image(part.inline_data.data)
                files.append(path)
            except Exception:
                # ignore malformed
                pass
        elif getattr(part, "text", None):
            text_parts.append(part.text)
    return {"files": files, "text": "\n".join(text_parts) if text_parts else ""}

def createImage(
    prompt: str,
    input_paths: Optional[List[str]] = None,
    gladius_path: Optional[str] = None,
    max_images: int = 1,
) -> Dict[str, Any]:
    """
    Returns: {"files": [<absolute_path_to_png>, ...]}  (or {"files": [], "text": "..."} on text-only)
    Retries transient 5xx errors and falls back to a secondary model if needed.
    """
    if not prompt or not isinstance(prompt, str):
        return {"error": "empty prompt"}

    contents: list = [prompt]

    # Collect input images
    paths: List[str] = []
    if gladius_path and os.path.exists(gladius_path):
        paths.append(gladius_path)
    if input_paths:
        for p in input_paths:
            if p and os.path.exists(p):
                paths.append(p)

    # Load up to 3 refs
    for p in paths[:3]:
        try:
            contents.append(_load_image_as_pil(p))
        except Exception:
            pass

    # Try primary with retries
    last_err = None
    model_used = _MODEL_PRIMARY
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            result = _gen_once(model_used, contents)
            if result.get("files"):
                # cap #images
                result["files"] = result["files"][:max_images]
                return result
            # If no image but text, return as-is (policy block or harmless text-only)
            if result.get("text"):
                return result
            # else treat as retryable empty
            raise RuntimeError("Empty response (no files, no text)")
        except genai_errors.ServerError as e:
            # Retry only on 5xx
            last_err = e
            sleep_s = min(_BASE_SLEEP * (2 ** (attempt - 1)), 10.0)
            time.sleep(sleep_s)
        except Exception as e:
            # Non-server errors (validation, etc.)—don't spin forever
            last_err = e
            break

    # Fallback model once if primary failed
    if _MODEL_FALLBACK and _MODEL_FALLBACK != model_used:
        model_used = _MODEL_FALLBACK
        try:
            result = _gen_once(model_used, contents)
            if result.get("files"):
                result["files"] = result["files"][:max_images]
                return result
            if result.get("text"):
                return result
        except Exception as e:
            last_err = e

    return {"files": [], "text": f"gen error: {type(last_err).__name__}: {last_err}"}
