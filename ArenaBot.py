import os
import re
import time
import json
from datetime import datetime, timedelta, timezone
from bs4 import BeautifulSoup

from db import supabase
from function import getNotifications, getNested, replyToPost, store_bot_reply, clean_html, _extract_reply_meta, _build_post_url
from terminalAI import ask
from logging_utils import get_logger

logger = get_logger(__name__)

# --- Config ---
POLL_INTERVAL_SEC = int(os.getenv("POLL_INTERVAL_SEC", "10"))
MAX_NOTIFS_PER_POLL = int(os.getenv("MAX_NOTIFS_PER_POLL", "50"))
MENTION_PHRASE = "mentioned you in a"
COMMENT_PHRASE = "replied:"
DAILY_REFRESH_HOURS = 24
MAX_REPLY_CHARS = 480  # keep replies tight
ALLOW_QUOTE_ANALYSIS = True  # we pass IDs so model can run analyze_post if it wants

# --- Helpers ---

def _excerpt(s: str, max_len: int = 280) -> str:
    s = (s or "").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 3] + "..."

def clean_html_to_text(html: str) -> str:
    txt = BeautifulSoup(html or "", "html.parser").get_text(separator=" ")
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt

def is_post_within_6_hours(iso_timestamp: str) -> bool:
    post_time = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    return datetime.now(timezone.utc) - post_time <= timedelta(hours=6)

def load_seen_notifications():
    try:
        cutoff = (datetime.utcnow() - timedelta(hours=48)).isoformat()
        res = (
            supabase.table("seen_notifications")
            .select("id")
            .gte("created_at", cutoff)
            .order("created_at", desc=True)
            .limit(1000)
            .execute()
        )
        return set(row["id"] for row in (res.data or []))
    except Exception as e:
        logger.exception("load_seen_notifications failed")
        return set()

def store_seen_notification(notif_id: str):
    try:
        supabase.table("seen_notifications").insert({
            "id": notif_id,
            "created_at": datetime.utcnow().isoformat()
        }).execute()
    except Exception as e:
        logger.exception("store_seen_notification failed")

def extract_nested_post_id(link: str):
    m = re.search(r"/nested/([0-9a-fA-F-]{36})", link or "")
    return m.group(1) if m else None


def extract_arena_post_id(link: str):
    m = re.search(r"/(status|nested)/([0-9a-fA-F-]{36})", link or "")
    return m.group(2) if m else None

def truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"

def build_agent_question(commented_post: dict) -> str:
    """
    We hand the model a short brief. It can call tools (get_user_stats, analyze_post, etc.)
    thanks to your GLADIUS_SYSTEM. We include IDs so analyze_post can trigger if needed.
    """
    c_txt = clean_html_to_text(commented_post.get("content") or "")
    c_id = commented_post.get("id")  # UUID accessible to `analyze_post`
 
    c_user = commented_post.get("userHandle") or commented_post.get("user", {}).get("handle") or "unknown"
   

    # Keep the instruction compact—your system prompt already enforces style.
    # We include the original post UUID so the tools can analyze if relevant.
    lines = [
  
        f"@{c_user}:  {truncate(c_txt, 1000)}",
      
       
    ]
    return "\n".join(lines)

def safe_html_wrap(s: str) -> str:
    s = (s or "").strip()
    # escape first, then convert newlines to <br>
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = s.replace("\n", "<br>")
    return f"<p>{s}</p>"

# --- Core ---

def handle_single_mention(notif: dict) -> bool:
    """
    Returns True if processed (and should be marked seen), False to skip.
    """
    title = notif.get("title", "")
    link  = notif.get("link", "")
    logger.info("notification | title=%s | link=%s", title, link)
    if not (MENTION_PHRASE in title or title.strip().endswith(COMMENT_PHRASE)):
        return False

    comment_post_id = extract_arena_post_id(link)
    if not comment_post_id:
        logger.warning("could not extract comment post_id from link")
        # return True  # mark seen to avoid spinning

 
    logger.info("fetch thread data | post_id=%s", comment_post_id)
    thread_data = getNested(comment_post_id)

    commentContent = thread_data.get("content")



    if not commentContent:
        logger.warning("getNested returned empty content | post_id=%s", comment_post_id)
        return True

   
   

  
    question = build_agent_question(thread_data)
    logger.info("question | text=%s", _excerpt(question, 600))

    try:
        logger.info(
            "thread data | id=%s | author=@%s | text=%s",
            thread_data.get("id"),
            (thread_data.get("userHandle") or (thread_data.get("user") or {}).get("handle") or "unknown").lstrip("@"),
            _excerpt(clean_html_to_text(thread_data.get("content") or ""), 300),
        )
        answer = ask(question, event=thread_data) # your gladius_chat.ask() returns printed answer; ensure it returns text too.
        if not answer or not answer.strip():
            logger.info("image queued; worker will reply. skipping immediate reply")
            return True
        
   
        
    except Exception as e:
        logger.exception("ask() failed")
        answer = "Too many warriros in the Arena battling with me. Try again later."

    # Post reply
    participant = thread_data.get("user", {}) or {}

    resp = replyToPost(
        postID=comment_post_id,
        userID=participant.get("id"),
        content=safe_html_wrap(answer),
    )
    logger.info("replied | post_id=%s | user_id=%s", comment_post_id, participant.get("id"))

    try:
        parent_handle = thread_data.get("userHandle") or (thread_data.get("user") or {}).get("handle")
        parent_user_id = participant.get("id")
        parent_post_content_text = clean_html(thread_data.get("content"))

        meta = _extract_reply_meta(resp)

        # If the API response didn't include our handle, fetch via getSinglePost as a fallback

      
        store_bot_reply(
            parent_post_id=comment_post_id,
            parent_post_url=_build_post_url(parent_handle, comment_post_id),
            parent_user_id=parent_user_id,
            parent_user_handle=parent_handle,
            parent_post_content_text=parent_post_content_text,

            reply_post_id=meta.get("reply_post_id"),
            reply_post_url=_build_post_url("arenagladius", meta.get("reply_post_id")),
            reply_user_id=meta.get("bd39a8ec-ad04-4a4c-8bd4-bb0698a2e64b"),
            reply_user_handle="arenagladius",
            reply_content_html=safe_html_wrap(answer),
            reply_image_url="",
            response_json=resp if isinstance(resp, dict) else {},
        )
    except Exception as e:
        logger.exception("logging bot reply failed")
    return True

def run_loop():
    logger.info("gladius mention agent running")
    seen_ids = load_seen_notifications()
    last_refresh = datetime.utcnow()
    backoff = 1

    while True:
        try:
            # refresh daily
            if datetime.utcnow() - last_refresh > timedelta(hours=DAILY_REFRESH_HOURS):
                logger.info("daily refresh of seen notifications")
                seen_ids = load_seen_notifications()
                last_refresh = datetime.utcnow()

            notifs = getNotifications(page=1, pageSize=MAX_NOTIFS_PER_POLL)
            items = (notifs or {}).get("notifications", [])
            logger.info("fetched notifications | count=%s", len(items))

            for n in items:
                nid = n.get("id")
                if not nid or nid in seen_ids:
                    continue

                processed = False
                try:
                    processed = handle_single_mention(n)
                    # time.sleep(1000)
                except Exception as e:
                    logger.exception("error handling mention")
                finally:
                    # mark seen regardless, to avoid infinite retries
                    seen_ids.add(nid)
                    store_seen_notification(nid)

            backoff = 1  # success → reset backoff
            time.sleep(POLL_INTERVAL_SEC)

        except KeyboardInterrupt:
            logger.info("exiting")
            break
        except Exception as e:
            logger.exception("loop error")
            time.sleep(min(60, backoff))
            backoff = min(60, backoff * 2)

if __name__ == "__main__":
    run_loop()
