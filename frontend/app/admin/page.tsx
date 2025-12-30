"use client";

import { useEffect, useMemo, useState } from "react";

const samplePayloads: Record<string, Record<string, unknown>> = {
  get_top_communities: { since_days: 7, limit_n: 10 },
  get_community_timeseries: { community_id_or_contract: "", days_back: 14 },
  search_token_communities: { token_name_or_contract_address: "" },
  get_top_users: { since_days: 7, limit_n: 12 },
  get_user_recent_posts: { user_id: "" },
  get_user_stats: { handle: "" },
  get_user_top_posts: { user_id: "" },
  get_trending_feed: { limit_n: 12 },
  analyze_post: { url_or_id: "" },
  search_keywords_timewindow: {
    query: "",
    start_days_offset: 0,
    days_span: 1,
    limit_n: 50,
    mode: "OR",
  },
  tool_get_conversation_history: { limit_n: 20, handle: "" },
  tool_top_friends: { start_days_offset: 0, days_span: 7, limit_n: 20 },
  generate_image: { prompt: "", caption: "" },
  get_profile_image: { handle: "" },
  search_web: { query: "", max_results: 6, search_depth: "basic" },
};

export default function AdminPage() {
  const [tools, setTools] = useState<{ name: string; description?: string }[]>([]);
  const [selectedTool, setSelectedTool] = useState<string>("search_keywords_timewindow");
  const [payloadText, setPayloadText] = useState("{}");
  const [responseText, setResponseText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [loading, setLoading] = useState(false);

  const storageKey = useMemo(
    () => `arena_tool_payload_${selectedTool}`,
    [selectedTool]
  );

  useEffect(() => {
    fetch("/api/arena/tools")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.tools)) {
          setTools(data.tools);
          if (!data.tools.find((t: any) => t.name === selectedTool)) {
            setSelectedTool(data.tools[0]?.name || "");
          }
        }
      })
      .catch(() => {
        setTools([]);
      });
  }, [selectedTool]);

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      setPayloadText(saved);
      return;
    }
    const sample = samplePayloads[selectedTool] || {};
    setPayloadText(JSON.stringify(sample, null, 2));
  }, [selectedTool, storageKey]);

  const runTool = async () => {
    setErrorText("");
    setResponseText("");
    setLoading(true);
    try {
      const parsed = JSON.parse(payloadText || "{}");
      window.localStorage.setItem(storageKey, payloadText);
      const res = await fetch("/api/arena/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: selectedTool, arguments: parsed }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Tool error.");
      }
      setResponseText(JSON.stringify(data.result, null, 2));
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Invalid payload.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[color:var(--bg)] text-[color:var(--text)]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--muted)]">
              Admin Console
            </p>
            <h1 className="text-3xl font-semibold">Arena Tool Runner</h1>
          </div>
          <a
            href="/"
            className="rounded-xl border border-[color:var(--border)] px-4 py-2 text-xs text-[color:var(--muted)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--text)]"
          >
            Back to chat
          </a>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[260px_1fr]">
          <aside className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--panel)] p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Tools
            </p>
            <div className="mt-3 space-y-2">
              {tools.map((tool) => (
                <button
                  key={tool.name}
                  onClick={() => setSelectedTool(tool.name)}
                  className={`w-full rounded-xl px-3 py-2 text-left text-xs transition ${
                    selectedTool === tool.name
                      ? "bg-[color:var(--panel-2)] text-[color:var(--text)]"
                      : "text-[color:var(--muted)] hover:bg-[color:var(--panel-2)]"
                  }`}
                >
                  <div className="font-medium">{tool.name}</div>
                  <div className="mt-1 text-[10px] text-[color:var(--muted)]">
                    {tool.description || "No description"}
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <div className="grid gap-6">
            <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--panel)] p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
                    Payload
                  </p>
                  <p className="mt-1 text-sm text-[color:var(--muted)]">
                    JSON arguments for {selectedTool}
                  </p>
                </div>
                <button
                  onClick={runTool}
                  disabled={loading}
                  className="rounded-xl bg-[color:var(--accent)] px-4 py-2 text-xs font-semibold text-black transition hover:brightness-110 disabled:opacity-60"
                >
                  {loading ? "Running" : "Run"}
                </button>
              </div>
              <textarea
                value={payloadText}
                onChange={(event) => setPayloadText(event.target.value)}
                rows={10}
                className="mt-4 w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--panel-2)] p-3 text-xs text-[color:var(--text)] outline-none"
              />
              {errorText ? (
                <p className="mt-3 text-xs text-rose-400">{errorText}</p>
              ) : null}
            </div>

            <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--panel)] p-5">
              <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
                Output
              </p>
              <pre className="mt-4 max-h-[420px] overflow-auto break-words whitespace-pre-wrap rounded-xl border border-[color:var(--border)] bg-[color:var(--panel-2)] p-3 text-xs text-[color:var(--text)]">
                {responseText || "Run a tool to see output."}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
