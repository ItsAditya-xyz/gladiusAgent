import os, time
from db import supabase
from Arena import get_latest_post              # your function
from ingest import ingest_payload        # from earlier
from logging_utils import get_logger

logger = get_logger(__name__)

POLL_SECONDS = int(os.getenv("POLL_SECONDS", "10"))
BATCH_LIMIT  = int(os.getenv("BATCH_LIMIT", "100"))  # optional cap per poll

def fetch_existing_ids(ids):
    if not ids:
        return set()
    res = supabase.table("sa_threads").select("id").in_("id", ids).execute()
    rows = (res.data or []) if hasattr(res, "data") else []
    return {r["id"] for r in rows}

def run_once():
    data = get_latest_post()                    # hits StarsArena partners API
    threads = data.get("threads", [])
    if not threads:
        logger.info("poll | api returned 0 threads")
        return 0

    if BATCH_LIMIT and len(threads) > BATCH_LIMIT:
        threads = threads[:BATCH_LIMIT]

    ids = [t["id"] for t in threads]
    existing = fetch_existing_ids(ids)

    new_threads = [t for t in threads if t["id"] not in existing]
    if not new_threads:
        logger.info("poll | no new threads | seen=%s", len(existing))
        return 0


   
    ingest_payload({"threads": new_threads})
    logger.info("poll | ingested new threads | count=%s", len(new_threads))
    return len(new_threads)

def main():
    backoff = POLL_SECONDS
    while True:
        try:
            run_once()
            backoff = POLL_SECONDS  # reset on success
        except Exception as e:
            logger.exception("poll error")
            # gentle backoff to avoid hammering if API hiccups
            backoff = min(max(backoff * 2, POLL_SECONDS), 300)
        time.sleep(backoff)

if __name__ == "__main__":
    main()
