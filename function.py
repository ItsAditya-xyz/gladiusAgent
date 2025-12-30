import requests
from dotenv import load_dotenv
import os
import re
import urllib.parse
load_dotenv()
from datetime import datetime, timezone, timedelta
from db import supabase
import json
POST_UUID_RE = re.compile(r"[0-9a-fA-F-]{36}")
from typing import Dict, Any
from logging_utils import get_logger

logger = get_logger(__name__)

def _excerpt(s: str, max_len: int = 400) -> str:
    s = (s or "").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 3] + "..."

JWT = os.getenv("JWT")
def post_to_starsarena(content, imageURL = None):
    url = "https://api.starsarena.com/threads"
    headersVal = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Authorization": f'Bearer {JWT}',
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Origin": "https://arena.social"
        
    }
    payload = {
        "content": content,
        "privacyType": 0,
    }

    if imageURL is not None:
        payload["files"] = [
           { "previewURL": imageURL,
            "url": imageURL,
            "fileType": "image"}
        ]
    

    
    try:
        response = requests.post(url, json=payload, headers=headersVal)
        logger.info("post_to_starsarena | status=%s | body=%s", response.status_code, _excerpt(response.text, 600))
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.exception("post_to_starsarena failed")
        return {"error": str(e)}
def _get_thread_images(thread_id: str, mediaList = None):
    """Return images for a thread (minimal columns)."""

    if mediaList is not None:
        return mediaList
    res = supabase.table("sa_images") \
        .select("id, source_url, storage_path, mime, width, height, is_gif") \
        .eq("thread_id", thread_id) \
        .order("id", desc=False) \
        .execute()
    return res.data or []


def _strip_at(s):
    return s.lstrip("@") if isinstance(s, str) else s

def _build_post_url(handle, post_id) :
    if handle and post_id:
        return f"https://arena.social/{_strip_at(handle)}/status/{post_id}"
    return None

def _extract_reply_meta(resp):
    """
    Be tolerant to API shapes. Try to pull id/handle/user from common places.
    """
    if not isinstance(resp, dict):
        return {}
    root = resp.get("thread") or resp.get("data") or resp
    user   = root.get("user") or {}
    return {
        "reply_post_id": root.get("id") or root.get("threadId") or root.get("createdThreadId"),
        "reply_user_handle": root.get("userHandle") or user.get("handle") or user.get("ixHandle"),
        "reply_user_id": user.get("id") or root.get("userId"),
    }

def store_bot_reply(
    *,
    parent_post_id,
    parent_post_url ,
    parent_user_id,
    parent_user_handle,
    parent_post_content_text,
    reply_post_id,
    reply_post_url,
    reply_user_id,
    reply_user_handle,
    reply_content_html,
    reply_image_url,
    response_json
):
    row = {
        "parent_post_id": parent_post_id,
        "parent_post_url": parent_post_url,
        "parent_user_id": parent_user_id,
        "parent_user_handle": _strip_at(parent_user_handle) if parent_user_handle else None,
        "parent_post_content_text": parent_post_content_text,

        "reply_post_id": reply_post_id,
        "reply_post_url": reply_post_url,
        "reply_user_id": reply_user_id,
        "reply_user_handle": _strip_at(reply_user_handle) if reply_user_handle else None,
        "reply_content_html": reply_content_html,
        "reply_image_url": reply_image_url,

        "response_json": response_json or {},
    }
    try:
        supabase.table("bot_replies").insert(row).execute()
        logger.info("logged bot reply | parent_post_id=%s", parent_post_id)
    except Exception as e:
        logger.exception("store_bot_reply failed")

def getNested(comment_post_id):
    """
    Builds a minimal 'threads' payload containing the comment and its root
    by calling getSinglePost twice. Safe drop-in for current usage.
    """
    comment = getSinglePost(comment_post_id)["threads"]  # must include 'answerId'

    if not comment or not comment.get("id"):
        return {"threads": []}
    
    return comment
 

    

def _get_existing_analyses(image_ids):
    """Return a set of image_ids that already have analysis."""
    if not image_ids:
        return set()
    res = supabase.table("sa_image_analysis") \
        .select("image_id") \
        .in_("image_id", image_ids) \
        .execute()
    return {r["image_id"] for r in (res.data or [])}



def analyze_and_persist_images_for_thread(
    oai_client: "OpenAI",
    thread_id: str,
    model: str = "gpt-4o-mini",
    mediaList = None,
):
    """
    For a thread, analyze only images without analysis and upsert results.
    Returns list of {image_id, analysis}.
    """
    imgs = _get_thread_images(thread_id)
    if not imgs:
        return []

    ids = [i["id"] for i in imgs if "id" in i]
    already = _get_existing_analyses(ids)
    todo = [i for i in imgs if i["id"] not in already]

    out = []
    for i in todo:
        url = i.get("storage_path") or i.get("source_url") or i.get("url")
        if not url:
            continue
        analysis = analyze_image_with_oai_structured(oai_client, url, model=model)
        # enrich meta
        meta = analysis.get("meta") or {}
        meta.update({"model": model, "image_url": url})
        analysis["meta"] = meta

        upsert_image_analysis(i["id"], analysis)
        out.append({"image_id": i["id"], "analysis": analysis})
    return out


def get_media_json_for_thread(thread_id):
    """
    Returns a list[json] like your SQL function would:
    [
      {
        "image_id": 123,
        "url": "https://.../img.png",
        "source_url": "...",
        "storage_path": "...",
        "mime": "image/png",
        "width": 1080,
        "height": 1350,
        "is_gif": false,
        "caption": "...",
        "ocr_text": "...",
        "topics": [...],
        "entities": {...},
        "safety_flags": [...],
        "sentiment": "neutral",
        "meme_template": null,
        "meta": {...}
      },
      ...
    ]
    """
    imgs = _get_thread_images(thread_id)
    if not imgs:
        return []

    ids = [i["id"] for i in imgs]
    # fetch all analyses in one go
    analyses = {}
    if ids:
        res = supabase.table("sa_image_analysis") \
            .select("image_id, caption, ocr_text, topics, entities, safety_flags, sentiment, meme_template, meta") \
            .in_("image_id", ids).execute()
        for r in (res.data or []):
            analyses[r["image_id"]] = r

    media = []
    for i in imgs:
        ia = analyses.get(i["id"], {})
        media.append({
            "image_id": i["id"],
            "url": i.get("storage_path") or i.get("source_url"),
            "source_url": i.get("source_url"),
            "storage_path": i.get("storage_path"),
            "mime": i.get("mime"),
            "width": i.get("width"),
            "height": i.get("height"),
            "is_gif": bool(i.get("is_gif")),
            "caption": ia.get("caption"),
            "ocr_text": ia.get("ocr_text"),
            "topics": ia.get("topics") or [],
            "entities": ia.get("entities") or {},
            "safety_flags": ia.get("safety_flags") or [],
            "sentiment": ia.get("sentiment"),
            "meme_template": ia.get("meme_template"),
            "meta": ia.get("meta") or {},
        })
    return media


def ensure_analysis_and_media_for_post(oai_client: "OpenAI", url_or_id: str):
    """
    Extract post_id, run analysis for any missing images, and return:
    {
      "post_id": "...",
      "author": {"handle": "...", "user_id": "..."},
      "content_text": "...",
      "media": [ ... rich media json ... ]
    }
    """
    post_id = extract_post_id_from_url(url_or_id)
    info = getSinglePost(post_id)

    try:
        logger.info("ensuring threads | user_id=%s", info.get("userID"))
        _upsert_threads_from_api_payload(info.get("userID"), {"threads": [info.get("threads")] })
    except Exception as e:
        logger.exception("upsert threads from api payload failed | user_id=%s", info.get("userID"))
    if not info or not info.get("post") and info.get('post') != "":
        return {"success": False, "post_id": post_id, "error": "Post not found or private."}

    # analyze only images stored in DB for this thread
    try:
        logger.debug("post info | %s", _excerpt(json.dumps(info, ensure_ascii=True), 800))
        if not info.get('image'):  # covers [] and None
            logger.info("no images to analyze | post_id=%s", post_id)
            

        else:
            logger.info("analyzing images | post_id=%s", post_id)
            analyze_and_persist_images_for_thread(oai_client, post_id, mediaList=info.get("image"))
    except Exception as e:
        # don't fail; we can still return existing media
        logger.exception("vision/upsert error | post_id=%s", post_id)

    return {
        "success": True,
        "post_id": post_id,
        "author": {
            "handle": info.get("username"),
            "user_id": info.get("userID"),
            "display": f"@{info.get('username')}" if info.get("username") else None,
           
        },
        "content_text": info.get("post") or "",
          "answerId": (info.get("threads") or {}).get("answerId"),  # ⬅️ add this
         'repostId': info.get("repostId"),
         "threadType": info.get("threadType"),
            "tipAmount": info.get("tipAmount"),
        "media": get_media_json_for_thread(post_id)
    }

def upsert_image_analysis(image_id, analysis):
    row = {
        "image_id": image_id,
        "caption": analysis.get("caption"),
        "ocr_text": analysis.get("ocr_text"),
        "topics": analysis.get("topics") or [],
        "entities": analysis.get("entities") or {},
        "safety_flags": analysis.get("safety_flags") or [],
        "sentiment": analysis.get("sentiment"),
        "meme_template": analysis.get("meme_template"),
        "meta": {
            **(analysis.get("meta") or {}),
        },
    }
    # upsert on PK image_id
    supabase.table("sa_image_analysis").upsert(row, on_conflict="image_id").execute()


def analyze_image_with_oai_structured(
    oai_client: "OpenAI",
    image_url,
    model = "gpt-4o-mini",
    max_tokens = 300,
    temperature = 0.0,
):
    """
    Returns a dict like:
    {
      "caption": str|null,
      "ocr_text": str|null,
      "topics": [str],
      "entities": {...},        # free-form JSON
      "safety_flags": [str],
      "sentiment": "bullish|bearish|neutral|positive|negative|mixed|unknown",
      "meme_template": str|null,
      "meta": {"model": "...", "ts": "...", "image_url": "..."}
    }
    """
    sys = (
        "You are a vision analyzer. "
        "Return a SINGLE JSON object with keys: caption, ocr_text, topics (array of short keywords), "
        "entities (JSON), safety_flags (array), sentiment (one of: bullish, bearish, neutral, positive, negative, mixed, unknown), "
        "meme_template (string or null). "
        "Be concise. If a field is unknown, use null (or [] for arrays, {} for objects)."
    )
    user_payload = [
        {"type": "text", "text": "Analyze this image and output ONLY the JSON object."},
        {"type": "image_url", "image_url": {"url": image_url}},
    ]

    resp = oai_client.chat.completions.create(
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": sys},
            {"role": "user", "content": user_payload},
        ],
    )
    raw = resp.choices[0].message.content or "{}"

    # Try strict JSON parse; if the model added prose, trim to outermost braces
    try:
        return json.loads(raw)
    except Exception:
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(raw[start : end + 1])
            except Exception:
                pass
    # Fallback minimal object
    return {
        "caption": None,
        "ocr_text": None,
        "topics": [],
        "entities": {},
        "safety_flags": [],
        "sentiment": "unknown",
        "meme_template": None,
        "meta": {},
    }

def analyze_image_with_oai(oai_client: "OpenAI", image_url, max_tokens = 150):
    """
    Lightweight vision pass: describe subject, vibe, any visible on-image text.
    Keep output short to conserve tokens.
    """
    try:
        resp = oai_client.chat.completions.create(
            model="gpt-4o-mini",
            temperature=0,
            messages=[
                {"role": "system", "content": "Return structured JSON with fields caption, ocr_text, topics (array), sentiment, meme_template."},
                {"role": "user", "content": [
                    {"type":"text","text":"Analyze this image."},
                    {"type":"image_url","image_url":{"url": image_url}}
                ]}
            ],
            response_format={ "type": "json_object" }
        )
        analysis = json.loads(resp.choices[0].message.content)
        txt = resp.choices[0].message.content or ""
        return {"ok": True, "summary": txt}
    except Exception as e:
        return {"ok": False, "error": str(e)}
def clean_html(raw_html):
    if raw_html is None:
        return ""
    """
    Removes HTML tags from the input string and returns a clean, readable string.

    Args:
        raw_html (str): The raw HTML string to clean.

    Returns:
        str: The cleaned string without HTML tags.
    """
    # Remove HTML tags
    clean_text = re.sub(r'<[^>]+>', '', raw_html)
    # Replace unnecessary whitespace and newlines
    clean_text = re.sub(r'\s+', ' ', clean_text).strip()
    return clean_text
def clean_text(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"https?://\S+", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()

def follow(userID):
    url = "https://api.starsarena.com/follow/follow"
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Authorization": f'Bearer {JWT}',
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Origin": "https://arena.social"
    }
    payload = {
        "userId": userID
    }

    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        res = response.json()
        return res
    except requests.exceptions.RequestException as e:
        logger.exception("follow failed | user_id=%s", userID)
        return {"error": str(e)}
    



def getNotifications(page=1, pageSize= 50):
    url = f"https://api.starsarena.com/notifications?page={1}&pageSize={pageSize}"
    headers = {
        "Authorization": f"Bearer {JWT}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
    }
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.exception("getNotifications failed")
        return {"error": str(e)}
    

def searchUser(username):
    url = f"https://api.starsarena.com/user/search?searchString={username}"
    headers = {
        "Authorization": f"Bearer {JWT}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
    }
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.exception("searchUser failed | username=%s", username)
        return {"error": str(e)}


def getUserPosts(userID, page=1, pageSize= 50):
    url = f"https://api.starsarena.com/threads/feed/user?userId={userID}&page={page}&pageSize={pageSize}"
    headers = {
        "Authorization": f"Bearer {JWT}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
    }
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.exception("getUserPosts failed | user_id=%s", userID)
        return {"error": str(e)}
    
def extract_post_id_from_url(url_or_id):
    s = (url_or_id or "").strip()
    # If already a UUID, return as-is
    if POST_UUID_RE.fullmatch(s):
        return s
    # Try to pull UUID from URL path
    try:
        path = urllib.parse.urlparse(s).path or ""
        m = POST_UUID_RE.search(path)
        if m:
            return m.group(0)
    except Exception:
        pass
    # Last fallback: return original, let API fail loudly
    return s
def getSinglePost(postID):
    url = f"https://api.starsarena.com/threads?threadId={postID}"
    headers = {
        "Authorization": f"Bearer {JWT}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
    }
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)

        resJson = response.json()

        username = resJson["thread"]["userHandle"]
        userID = resJson["thread"]["user"]["id"]
        return {
            "post": clean_html(resJson["thread"]["content"]),
            "username": username,
            "userID": userID,
            "image": resJson["thread"]["images"],
            "repostId": resJson["thread"].get("repostId"),
            "tipAmount": resJson["thread"].get("tipAmount"),
            "threadType": resJson["thread"].get("threadType"),
            "threads": resJson.get("thread") or [],

        }
    except requests.exceptions.RequestException as e:
        logger.exception("getSinglePost failed | post_id=%s", postID)
        return {
            "post": None,
            "username": None,
        }



def replyToPost(postID, userID, content, imageURL = None):
    url = "https://api.starsarena.com/threads/answer"
    payload = {"content":content,"threadId":postID,"files":[],
               "userId": userID
               }
    
    if imageURL is not None:
        payload["files"] = [
           { "previewURL": imageURL,
            "url": imageURL,
            "fileType": "image"}
        ]
    headers = {
        "Authorization": f"Bearer {JWT}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
    }

    try:
      
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.exception("replyToPost failed | post_id=%s | user_id=%s", postID, userID)
        return {"error": str(e)}
    

def _normalize_api_images(images):
    """
    StarsArena images sometimes arrive as list[str] or list[dict].
    Returns a list of dicts with a 'source_url' key.
    """
    out = []
    for im in (images or []):
        if isinstance(im, str):
            out.append({"source_url": im})
        elif isinstance(im, dict):
            url = im.get("url") or im.get("path") or im.get("src") or im.get("source_url")
            if url:
                out.append({
                    "source_url": url,
                    "mime": im.get("mime"),
                    "width": im.get("width"),
                    "height": im.get("height"),
                    "is_gif": bool(im.get("is_gif")) if im.get("is_gif") is not None else (url.lower().endswith(".gif")),
                })
    return out


def _existing_image_source_urls(thread_id):
    res = supabase.table("sa_images") \
        .select("source_url") \
        .eq("thread_id", thread_id) \
        .execute()
    return {r["source_url"] for r in (res.data or []) if r.get("source_url")}


def _upsert_images_for_thread(thread_id, images_payload):
    """
    Insert any missing images for a thread into sa_images (no analysis here).
    Dedup by (thread_id, source_url).
    """
    imgs = _normalize_api_images(images_payload)
    if not imgs:
        return 0

    existing = _existing_image_source_urls(thread_id)
    rows = []
    for im in imgs:
        src = im.get("source_url")
        if not src or src in existing:
            continue
        rows.append({
            # id is identity; omit it so the DB assigns one
            "thread_id": thread_id,
            "source_url": src,
            "storage_path": None,               # fill later if you mirror to GCS
            "mime": im.get("mime"),
            "width": im.get("width"),
            "height": im.get("height"),
            "is_gif": im.get("is_gif", False),
        })

    if not rows:
        logger.info("no new images to insert | thread_id=%s", thread_id)
        return 0

    resp = supabase.table("sa_images").insert(rows).execute()
    # optional debug
    inserted = len(rows) if getattr(resp, "data", None) is not None else 0
    if inserted:
        logger.info("inserted images | count=%s | thread_id=%s", inserted, thread_id)
    return inserted

def getTrendingFeed():
    url = "https://api.starsarena.com/threads/feed/trendingPosts?page=1&pageSize=20"
    headers = {
        "Authorization": f"Bearer {JWT}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
    }
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.exception("getTrendingFeed failed")
        return {"error": str(e)}
    

def getFollowingFeed():
    url = "https://api.starsarena.com/threads/feed/my?page=1&pageSize=20"
    headers = {
        "Authorization": f"Bearer {JWT}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        "Referrer": "https://arena.social",
        "Content-Type": "application/json",
    }
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.exception("getFollowingFeed failed")
        return {"error": str(e)}
    




def _max_created_at_for_user(user_id):
    res = supabase.table("sa_threads") \
        .select("created_at", count="exact") \
        .eq("user_id", user_id) \
        .order("created_at", desc=True) \
        .limit(1).execute()
    rows = (res.data or []) if hasattr(res, "data") else []
    ts = rows[0]["created_at"] if rows else None
    count = res.count or 0
    return ts, count

def _upsert_threads_from_api_payload(user_id, payload):
    threads = payload.get("threads") or []
    logger.info("upsert threads payload | user_id=%s | threads=%s", user_id, len(threads))
    rows = []
    for t in threads:
        tid = t.get("id")
        if not tid:
            continue

        # Make sure FK parents exist
        # StarsArena feed shape typically has these fields:
        user_handle = (t.get("userHandle") or "").lstrip("@")
        user_name   = (t.get("user") or {}).get("name")
        user_pic    = (t.get("user") or {}).get("profileImage") or (t.get("user") or {}).get("picture")
        user_addr   = (t.get("user") or {}).get("address")
        _ensure_user_row(user_id, handle=user_handle, name=user_name, picture=user_pic, address=user_addr)

        comm_id   = t.get("communityId")
        comm_name = t.get("communityName")
        if comm_id:
            _ensure_community_row(comm_id, name=comm_name)


        
        rows.append({
            "id": tid,
            "user_id": user_id,
            "community_id": comm_id,
            "content_html": t.get("content") or None,
            "content_text": clean_text(t.get("content") or ""),
            "thread_type": t.get("threadType"),
            "language": t.get("language"),
            "display_status": t.get("displayStatus"),
            "created_at": t.get("createdAt"),
            "updated_at": t.get("updatedAt"),
            "answer_count": t.get("answerCount") or 0,
            "like_count": t.get("likeCount") or 0,
            "bookmark_count": t.get("bookmarkCount") or 0,
            "repost_count": t.get("repostCount") or 0,
            "is_edited": bool(t.get("isEdited")),
            "is_deleted": bool(t.get("isDeleted")),
            "is_pinned": bool(t.get("isPinned")),
            "pinned_in_community": bool(t.get("pinnedInCommunity")),
            "paywall": bool(t.get("paywall")),
            "price": t.get("price"),
            "currency": t.get("currency"),
            "currency_address": t.get("currencyAddress"),
            "currency_decimals": t.get("currencyDecimals"),
            "tip_amount": t.get("tipAmount"),
            "tip_count": t.get("tipCount"),
        })

    if not rows:
        return 0

    resp = supabase.table("sa_threads").upsert(rows, on_conflict="id").execute()




    for t in threads:
        tid = t.get("id")
        images_payload = t.get("images") or t.get("image") or t.get("media") or []
        try:
            _upsert_images_for_thread(tid, images_payload)
        except Exception as e:
            logger.exception("image upsert failed | thread_id=%s", tid)
    
    # Debug surface: some clients don’t raise on error; print data back
    if hasattr(resp, "error") and resp.error:
        logger.error("upsert sa_threads error | %s", resp.error)
    else:
        # Optionally print how many we tried
        logger.info("upserted thread rows | count=%s", len(rows))
    return len(rows)

def ensure_threads_for_user(user_id, freshness_minutes = 10, max_fetch = 200):
    max_ts, count = _max_created_at_for_user(user_id)
    needs_refresh = True
    if max_ts:
        if isinstance(max_ts, str):
            max_ts = datetime.fromisoformat(max_ts.replace("Z","")).replace(tzinfo=timezone.utc)
        age = datetime.now(timezone.utc) - max_ts
        needs_refresh = age.total_seconds()/60.0 > freshness_minutes

    # During debugging, consider disabling this early-exit:
    # if not needs_refresh and count >= 40:
    #     return 0

    page, pageSize, inserted = 1, 50, 0
    while inserted < max_fetch:
        logger.info(
            "fetching user posts | user_id=%s | page=%s | max_ts=%s | inserted=%s",
            user_id,
            page,
            max_ts,
            inserted,
        )
        payload = getUserPosts(userID=user_id, page=page, pageSize=pageSize)
        threads = (payload or {}).get("threads") or []
        if not threads:
            break

        if max_ts:
            newer = [t for t in threads if t.get("createdAt") and
                     datetime.fromisoformat(t["createdAt"].replace("Z","")).replace(tzinfo=timezone.utc) > max_ts]
            if not newer and page > 1:
                break
            count_added = _upsert_threads_from_api_payload(user_id, {"threads": newer or threads})
        else:
            count_added = _upsert_threads_from_api_payload(user_id, {"threads": threads})

        inserted += count_added
        if len(threads) < pageSize:
            break
        page += 1

    # Verify rows exist:
    check = supabase.table("sa_threads").select("id", count="exact").eq("user_id", user_id).limit(1).execute()
    total = getattr(check, "count", None) or 0
    if total == 0:
        logger.warning("no rows in sa_threads after sync | user_id=%s", user_id)
    else:
        logger.info("sa_threads rows | user_id=%s | count=%s", user_id, total)
    return inserted

def _ensure_user_row(user_id, handle = None, name = None, picture = None, address = None):
    if not user_id:
        return
    row = {"id": user_id}
    if handle:
        row["handle"] = handle.lstrip("@")
    if name is not None:
        row["name"] = name
    if picture is not None:
        row["picture"] = picture
    if address is not None:
        row["address"] = address
    supabase.table("sa_users").upsert(row, on_conflict="id").execute()

def _ensure_community_row(comm_id, name = None):
    if not comm_id:
        return
    supabase.table("sa_communities").upsert(
        {"id": comm_id, "name": name},
        on_conflict="id"
    ).execute()


def uploadImage(imageFileDirectory):
    try:
        file_name = imageFileDirectory.split("/")[-1]
        file_type = "image/png"
        encoded_file_type = urllib.parse.quote(file_type, safe='')
        encoded_file_name = urllib.parse.quote(file_name, safe='')

        headers = {
            "Authorization": f"Bearer {JWT}",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
            "Referrer": "https://arena.social",
            "Content-Type": "application/json",
        }

        url = f"https://api.starsarena.com/uploads/getUploadPolicy?fileType={encoded_file_type}&fileName={encoded_file_name}"
        response = requests.get(url, headers=headers)

        if response.status_code != 200:
            return {"error": f"Failed to fetch upload policy: {response.status_code}"}
        upload_policy = response.json()["uploadPolicy"]


        upload_url = "https://storage.googleapis.com/starsarena-s3-01/"

        headers2 = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
            "Referrer": "https://arena.social",
        }

        # Open the file once and reuse it
        with open(imageFileDirectory, "rb") as file:
            files = {"file": file}
            upload_policy["Content-Type"] = file_type
            #remove enctype from the policy
            upload_policy.pop("enctype")
            upload_policy.pop("url")
        
            upload_response = requests.post(upload_url, files=files, data=upload_policy, headers=headers2)

        if upload_response.status_code == 204:
            return {
                "success": True,
                "url": f"https://static.starsarena.com/{upload_policy['key']}",
                "error": None
            }
        else:
            return {
                "success": False,
                "error": f"Failed to upload image: {upload_response.status_code}",
                'url': None,
                "response": upload_response.text
            }
    except requests.exceptions.RequestException as e:
        logger.exception("uploadImage failed")
        return {
            "success": False,
            "error": str(e),
            'url': None
        }
    


def getStatsOfArena_structured(username,
                               sync_posts=True,
                               freshness_minutes= 10,
                               min_rows = 40,
                               max_fetch = 100):
    """
    Fetch profile + share stats from StarsArena for `username` and (optionally) ensure
    their posts are synced into sa_threads so later tools can read from DB.

    Returns:
      {
        "success": True,
        "profile": {..., "user_id": "...", "handle": "...", "display": "@handle"},
        "shares": {...},
        "sync": {"attempted": True/False, "inserted": int}   # only when sync_posts=True
      }
    """
    try:
        handle = (username or "").lstrip("@").strip()

        # --- Profile ---
        userInfoURL = f"https://api.starsarena.com/user/handle?handle={handle}"
        headers = {
            "Authorization": f"Bearer {JWT}",
            "User-Agent": "Mozilla/5.0",
            "Referrer": "https://arena.social",
            "Content-Type": "application/json",
        }
        r = requests.get(userInfoURL, headers=headers, timeout=15)
        r.raise_for_status()
        u = r.json()["user"]

        def f(x): return float(x) if x is not None else 0.0

        profile = {
            "handle": u.get("twitterHandle") or u.get("handle"),
            "name": u.get("twitterName") or u.get("name"),
            "user_id": u.get("id"),
            "followers": u.get("followerCount"),
            "followings": u.get("followingsCount"),
            "thread_count": u.get("threadCount"),
            "description": clean_text(u.get("twitterDescription") or ""),
            "created_on": u.get("createdOn"),
            "address": u.get("address"),  # remove if you prefer not to expose by default
            "key_price_avax": round(f(u.get("lastKeyPrice")) / 1e18, 3),
            "display": None,  # filled below
            "twitterPicture": u.get("twitterPicture"),
        }
        if profile.get("handle"):
            profile["display"] = f"@{profile['handle']}"

        # --- Shares / trading stats ---
        statURL = f"https://api.starsarena.com/shares/stats?userId={profile['user_id']}"
        s = requests.get(statURL, headers=headers, timeout=15)
        s.raise_for_status()
        sj = s.json()
        shares = {
            "total_holdings": sj.get("totalHoldings"),
            "total_holders": sj.get("totalHolders"),
            "buys": (sj.get("stats") or {}).get("buys"),
            "sells": (sj.get("stats") or {}).get("sells"),
            "fees_paid_avax": round(f((sj.get("stats") or {}).get("feesPaid")) / 1e18, 3),
            "fees_earned_avax": round(f((sj.get("stats") or {}).get("feesEarned")) / 1e18, 3),
            "portfolio_value_avax": round(f(sj.get("portfolioValue")) / 1e18, 3),
            "referrals_earned_avax": round(f((sj.get("stats") or {}).get("referralsEarned")) / 1e18, 3),
        }

        # --- Optional: incremental sync of posts into sa_threads ---
        sync_info = {"attempted": False, "inserted": 0}
        if sync_posts:
            sync_info["attempted"] = True
            try:
                # You already have ensure_threads_for_user(...) from earlier step
                inserted = ensure_threads_for_user(
                    user_id=profile["user_id"],
                    freshness_minutes=freshness_minutes,
                    max_fetch=max_fetch
                )
                sync_info["inserted"] = int(inserted or 0)
            except Exception:
                # Don't fail stats if sync hiccups; the caller can still use existing DB rows
                pass

        return {
            "success": True,
            "profile": profile,
            "shares": shares,
            "sync": sync_info if sync_posts else {"attempted": False, "inserted": 0},
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e) ,
            "profile": {},
            "shares": {},
            "sync": {"attempted": False, "inserted": 0},
        }
