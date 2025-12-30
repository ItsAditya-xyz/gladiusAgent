import httpx  # already a dep via openai
from dotenv import load_dotenv
import os
load_dotenv()
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")


def tool_search_web(query: str,
                    max_results: int = 6,
                    search_depth: str = "basic",   # "basic" | "advanced"
                    include_answer=True,
                    include_domains = None,
                    exclude_domains = None):
    """
    Tavily web search. Returns a compact, LLM-friendly payload.
    """
    if not TAVILY_API_KEY:
        return {"success": False, "error": "Missing TAVILY_API_KEY env var."}

    payload = {
        "api_key": TAVILY_API_KEY,
        "query": query,
        "max_results": max_results,
        "search_depth": search_depth,
        "include_answer": include_answer,
    }
    if include_domains: payload["include_domains"] = include_domains
    if exclude_domains: payload["exclude_domains"] = exclude_domains

    try:
        r = httpx.post("https://api.tavily.com/search", json=payload, timeout=20.0)
        r.raise_for_status()
        data = r.json() or {}

        # Normalize to a lean schema your model can reason over
        results = []
        for it in (data.get("results") or [])[:max_results]:
            results.append({
                "title": it.get("title") or "",
                "url": it.get("url") or "",
                "snippet": (it.get("content") or "")[:500],
                "score": it.get("score"),
            })

        return {
            "success": True,
            "query": data.get("query") or query,
            "answer": data.get("answer"),          # Tavily’s concise synthesis (optional)
            "results": results,                    # ranked list
        }
    except httpx.HTTPError as e:
        return {"success": False, "error": f"HTTP {e.__class__.__name__}: {str(e)}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
    


