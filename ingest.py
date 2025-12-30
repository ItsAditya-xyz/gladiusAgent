# ingest_arena.py
import os, re, json, hashlib
from datetime import datetime
from html import unescape
from typing import Dict, Any, List, Optional

from db import supabase  # your working client
from openai import OpenAI
from logging_utils import get_logger

logger = get_logger(__name__)

OPENAI_API_KEY = os.getenv("OPEN_AI_KEY")
assert OPENAI_API_KEY, "Set OPENAI_API_KEY"
oai = OpenAI(api_key=OPENAI_API_KEY)

# -------- helpers --------

TAG_RE = re.compile(r"<[^>]+>")

def strip_html_to_text(html: str) -> str:
    if not html:
        return ""
    # remove tags
    txt = TAG_RE.sub("", html)
    # unescape html entities
    return unescape(txt).strip()

def is_gif(url: str) -> bool:
    return bool(re.search(r"\.gif($|\?)", url, re.I) or re.search(r"(tenor|giphy)", url, re.I))

def sha256_of_url(url: str) -> str:
    # URL-only dedupe fingerprint (no bytes fetch)
    return hashlib.sha256(url.encode("utf-8")).hexdigest()

def embed_text(text: str) -> List[float]:
    if not text:
        # Return a zero vector to avoid failing inserts; pgvector accepts it.
        return [0.0] * 1536
    resp = oai.embeddings.create(
        model="text-embedding-3-small",
        input=text[:8000]  # guard
    )
    return resp.data[0].embedding

def analyze_image_url(image_url: str, hint_text: str = "", animated: bool = False) -> Dict[str, Any]:
    """
    Calls a vision model on a public image URL and returns structured JSON.
    """
    system = "You analyze social-media images. Output ONLY valid JSON."
    user_prompt = (
        'Return STRICT JSON with keys: '
        'caption (<=30 words), topics (1-5 strings), entities (array of {type,value}), '
        'safety_flags (subset of ["nsfw","violence","hate","self-harm","none"]), '
        'sentiment ("positive"|"neutral"|"negative"), meme_template (string|null), '
        'ocr_text (visible text if readable), meta (object). '
        'Do not identify private individuals. Be conservative if unsure.'
    )
    if animated:
        user_prompt += " If this is an animated GIF, summarize the overall scene; OCR only if readable."

    # OpenAI Python v1 vision via chat.completions
    resp = oai.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.2,
        max_tokens=400,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": [
                {"type": "text", "text": user_prompt + (f"\nHint text from post: {hint_text[:400]}" if hint_text else "")},
                {"type": "image_url", "image_url": {"url": image_url}},
            ]}
        ]
    )

    content = resp.choices[0].message.content or "{}"
    try:
        data = json.loads(content)
    except Exception:
        data = {}
    # defaults
    data.setdefault("safety_flags", ["none"])
    data.setdefault("topics", [])
    data.setdefault("entities", [])
    data.setdefault("sentiment", "neutral")
    data.setdefault("meme_template", None)
    data.setdefault("ocr_text", "")
    data.setdefault("caption", "")
    data.setdefault("meta", {})
    return data

# -------- upserts --------

def upsert_user(u: Dict[str, Any]):
    supabase.table("sa_users").upsert({
        "id": u["id"],
        "handle": u.get("twitterHandle") or u.get("userHandle"),
        "name": u.get("twitterName") or u.get("userName"),
        "picture": u.get("twitterPicture"),
        "address": u.get("address"),
    }).execute()

def upsert_community(c: Dict[str, Any]):
    supabase.table("sa_communities").upsert({
        "id": c["id"],
        "contract_address": c.get("contractAddress"),
        "name": c.get("name"),
        "kind": c.get("type"),
        "photo_url": c.get("photoURL"),
    }).execute()

def upsert_thread(t: Dict[str, Any], content_text: str):
    supabase.table("sa_threads").upsert({
        "id": t["id"],
        "user_id": t["user"]["id"],
        "community_id": t.get("community", {}).get("id") if t.get("community") else None,

        "content_html": t.get("content") or "",
        "content_text": content_text,
        "thread_type": t.get("threadType"),
        "language": t.get("language"),

        "display_status": t.get("displayStatus"),
        "created_at": t.get("createdDate"),
        "updated_at": t.get("updatedAt"),

        "answer_count": t.get("answerCount", 0),
        "like_count": t.get("likeCount", 0),
        "bookmark_count": t.get("bookmarkCount", 0),
        "repost_count": t.get("repostCount", 0),

        "is_edited": t.get("isEdited", False),
        "is_deleted": t.get("isDeleted", False),
        "is_pinned": t.get("isPinned", False),
        "pinned_in_community": t.get("pinnedInCommunity", False),

        "paywall": t.get("paywall", False),
        "price": t.get("price"),
        "currency": t.get("currency"),
        "currency_address": t.get("currencyAddress"),
        "currency_decimals": t.get("currencyDecimals"),
        "tip_amount": t.get("tipAmount"),
        "tip_count": t.get("tipCount"),
    }).execute()

def upsert_image(thread_id: str, img: Dict[str, Any]):
    url = img["url"]
    supabase.table("sa_images").upsert({
        "id": img["id"],
        "thread_id": thread_id,
        "source_url": url,
        "storage_path": None,          # URL-only flow
        "mime": None,                  # optional: fill if you HEAD the URL
        "is_gif": is_gif(url),
        "width": None,
        "height": None,
        "sha256": sha256_of_url(url),  # URL fingerprint (not bytes)
    }).execute()

def upsert_image_analysis(image_id: int, analysis: Dict[str, Any]):
    supabase.table("sa_image_analysis").upsert({
        "image_id": image_id,
        "ocr_text": analysis.get("ocr_text"),
        "caption": analysis.get("caption"),
        "topics": analysis.get("topics"),
        "entities": analysis.get("entities"),
        "safety_flags": analysis.get("safety_flags"),
        "sentiment": analysis.get("sentiment"),
        "meme_template": analysis.get("meme_template"),
        "meta": analysis.get("meta"),
    }).execute()

def upsert_thread_embedding(thread_id: str, vec: List[float]):
    supabase.table("sa_embeddings").upsert({
        "thread_id": thread_id,
        "image_id": None,
        "embedding": vec
    }).execute()

def upsert_image_embedding(thread_id: str, image_id: int, vec: List[float]):
    supabase.table("sa_embeddings").upsert({
        "thread_id": thread_id,
        "image_id": image_id,
        "embedding": vec
    }).execute()

# -------- main entry --------

def ingest_payload(payload: Dict[str, Any]):
    threads: List[Dict[str, Any]] = payload.get("threads", [])
    for t in threads:
        # 1) users & communities
        upsert_user(t["user"])
        if t.get("community"):
            upsert_community(t["community"])

        # 2) thread
        content_text = strip_html_to_text(t.get("content") or "")
        logger.debug("thread content | %s", content_text)
        upsert_thread(t, content_text)

        # 3) thread text embedding (once)
        if content_text:
            try:
                t_vec = embed_text(content_text)
                upsert_thread_embedding(t["id"], t_vec)
            except Exception as e:
                logger.exception("embed thread error | thread_id=%s", t.get("id"))

        # 4) images -> vision -> analysis -> image embedding
        images = t.get("images") or []
        for img in images:
            try:
                upsert_image(t["id"], img)

                # Analyze via VLM (URL only)
                # a = analyze_image_url(
                #     image_url=img["url"],
                #     hint_text=content_text,
                #     animated=is_gif(img["url"])
                # )
                # upsert_image_analysis(img["id"], a)

                # Build an index text blob for image vector
                # blob = " ".join([p for p in [content_text, a.get("caption",""), a.get("ocr_text","")] if p]).strip()
                # if blob:
                    # ivec = embed_text(blob)
                    # upsert_image_embedding(t["id"], img["id"], ivec)
            except Exception as e:
                logger.exception(
                    "image pipeline error | thread_id=%s | image_id=%s",
                    t.get("id"),
                    img.get("id"),
                )


# If you want a quick run hook:
if __name__ == "__main__":
    # Example:
    from Arena import get_recent_threads
    payload = get_recent_threads()
    ingest_payload(payload)
    pass
