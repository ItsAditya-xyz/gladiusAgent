"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

const makeId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

type ArenaProfile = {
  id?: string;
  handle: string;
  name?: string;
  description?: string;
  followers?: number;
  followings?: number;
  threads?: number;
  avatar?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  imageUrl?: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
};

const defaultGreeting = (handle?: string) =>
  `Welcome${handle ? `, @${handle}` : ""}. You face Gladius. Speak.`;

const buildTitle = (text: string) => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 36 ? `${clean.slice(0, 36)}...` : clean;
};

const conversationKey = (handle: string) => `arena_conversations_${handle}`;
const activeKey = (handle: string) => `arena_active_conversation_${handle}`;

export default function Home() {
  const [handleInput, setHandleInput] = useState("");
  const [profile, setProfile] = useState<ArenaProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const normalizedHandle = useMemo(
    () => handleInput.trim().replace(/^@+/, ""),
    [handleInput]
  );

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) || null,
    [conversations, activeConversationId]
  );

  const orderedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations]
  );

  useEffect(() => {
    const cached = window.localStorage.getItem("arena_profile");
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as ArenaProfile;
        if (parsed?.handle) {
          setProfile(parsed);
        }
      } catch {
        window.localStorage.removeItem("arena_profile");
      }
    }
  }, []);

  useEffect(() => {
    if (!profile?.handle) {
      setConversations([]);
      setActiveConversationId(null);
      return;
    }

    const key = conversationKey(profile.handle);
    const activeIdKey = activeKey(profile.handle);
    const saved = window.localStorage.getItem(key);
    const savedActive = window.localStorage.getItem(activeIdKey);

    let initial: Conversation[] = [];
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Conversation[];
        if (Array.isArray(parsed)) {
          initial = parsed;
        }
      } catch {
        initial = [];
      }
    }

    if (!initial.length) {
      const starter: Conversation = {
        id: makeId(),
        title: "New chat",
        messages: [
          { id: makeId(), role: "assistant", content: defaultGreeting(profile.handle) },
        ],
        updatedAt: Date.now(),
      };
      initial = [starter];
      setActiveConversationId(starter.id);
    } else if (savedActive && initial.some((c) => c.id === savedActive)) {
      setActiveConversationId(savedActive);
    } else {
      setActiveConversationId(initial[0]?.id || null);
    }

    setConversations(initial);
  }, [profile?.handle]);

  useEffect(() => {
    if (!profile?.handle) return;
    window.localStorage.setItem(
      conversationKey(profile.handle),
      JSON.stringify(conversations)
    );
  }, [conversations, profile?.handle]);

  useEffect(() => {
    if (!profile?.handle || !activeConversationId) return;
    window.localStorage.setItem(activeKey(profile.handle), activeConversationId);
  }, [activeConversationId, profile?.handle]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages.length, chatLoading]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const createNewConversation = (handle?: string) => {
    const convo: Conversation = {
      id: makeId(),
      title: "New chat",
      messages: [
        { id: makeId(), role: "assistant", content: defaultGreeting(handle) },
      ],
      updatedAt: Date.now(),
    };
    setConversations((prev) => [convo, ...prev]);
    setActiveConversationId(convo.id);
  };

  const connectProfile = async () => {
    setProfileError(null);
    setChatError(null);
    if (!normalizedHandle) {
      const msg = "Enter a valid Arena handle.";
      setProfileError(msg);
      setToast(msg);
      return;
    }
    setProfileLoading(true);
    try {
      const res = await fetch("/api/arena/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: normalizedHandle }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to fetch profile.");
      }
      const fetched = data.profile as ArenaProfile;
      setProfile(fetched);
      window.localStorage.setItem("arena_profile", JSON.stringify(fetched));
      setHandleInput("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Profile lookup failed.";
      setProfileError(msg);
      setToast(msg);
    } finally {
      setProfileLoading(false);
    }
  };

  const disconnectProfile = () => {
    setProfile(null);
    setConversations([]);
    setActiveConversationId(null);
    setMessageInput("");
    setChatError(null);
    window.localStorage.removeItem("arena_profile");
  };

  const sendMessage = async () => {
    if (!profile || chatLoading || !activeConversation) return;
    const text = messageInput.trim();
    if (!text) return;

    const history = activeConversation.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      content: text,
    };

    setConversations((prev) =>
      prev.map((conv) => {
        if (conv.id !== activeConversation.id) return conv;
        const title =
          conv.title === "New chat" ? buildTitle(text) : conv.title;
        return {
          ...conv,
          title,
          messages: [...conv.messages, userMessage],
          updatedAt: Date.now(),
        };
      })
    );

    setMessageInput("");
    setChatLoading(true);
    setChatError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          handle: profile.handle,
          profile,
          history,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Agent failed to respond.");
      }

      const answer = data.answer || "";
      const imageUrl =
        typeof data.image_url === "string"
          ? data.image_url
          : typeof data.image_data_url === "string"
            ? data.image_data_url
            : "";
      const uploadError =
        typeof data.image_upload_error === "string"
          ? data.image_upload_error
          : "";

      const assistantMessage: ChatMessage = {
        id: makeId(),
        role: "assistant",
        content:
          answer ||
          (imageUrl
            ? data.image_caption || "Image generated."
            : data.queued
              ? "Image queued. The forge will answer soon."
              : uploadError
                ? `Image upload failed: ${uploadError}`
                : "No response returned."),
        imageUrl: imageUrl || undefined,
      };

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== activeConversation.id) return conv;
          return {
            ...conv,
            messages: [...conv.messages, assistantMessage],
            updatedAt: Date.now(),
          };
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Agent error.";
      setChatError(message);
      setToast(message);
      const assistantMessage: ChatMessage = {
        id: makeId(),
        role: "assistant",
        content: `Error: ${message}`,
      };
      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== activeConversation.id) return conv;
          return {
            ...conv,
            messages: [...conv.messages, assistantMessage],
            updatedAt: Date.now(),
          };
        })
      );
    } finally {
      setChatLoading(false);
    }
  };

  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  if (!profile) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-[color:var(--bg)] px-6 text-[color:var(--text)]">
        {toast ? (
          <div className="absolute right-6 top-6 rounded-xl border border-[color:var(--border)] bg-[color:var(--panel)] px-4 py-3 text-sm text-[color:var(--text)] shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
            {toast}
          </div>
        ) : null}
        <div className="w-full max-w-md rounded-3xl border border-[color:var(--border)] bg-[color:var(--panel)] p-8 shadow-[0_24px_60px_rgba(0,0,0,0.4)]">
          <h1 className="text-2xl font-semibold">What's your Arena Handle?</h1>
          <div className="mt-6">
            <div className="flex items-center gap-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--panel-2)] px-4 py-3">
              <span className="text-[color:var(--muted)]">@</span>
              <input
                value={handleInput}
                onChange={(event) => setHandleInput(event.target.value)}
                placeholder="ArenaGladius"
                className="flex-1 bg-transparent text-base text-[color:var(--text)] outline-none placeholder:text-[color:var(--muted)]"
              />
            </div>
            {profileError ? (
              <p className="mt-3 text-sm text-rose-400">{profileError}</p>
            ) : null}
            <button
              onClick={connectProfile}
              disabled={profileLoading}
              className="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-[color:var(--accent)] px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-60"
            >
              {profileLoading ? "Logging in..." : "Log in"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[color:var(--bg)] text-[color:var(--text)]">
      {toast ? (
        <div className="absolute right-6 top-6 z-10 rounded-xl border border-[color:var(--border)] bg-[color:var(--panel)] px-4 py-3 text-sm text-[color:var(--text)] shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          {toast}
        </div>
      ) : null}
      <div className="flex min-h-screen">
        <aside className="flex w-full max-w-[260px] flex-col border-r border-[color:var(--border)] bg-[color:var(--panel)]">
          <div className="border-b border-[color:var(--border)] p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 overflow-hidden rounded-xl border border-[color:var(--border)] bg-black/40">
                {profile.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.avatar} alt={profile.handle} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-sm text-[color:var(--muted)]">
                    @
                  </div>
                )}
              </div>
              <div>
                <p className="text-sm font-semibold">@{profile.handle}</p>
                <p className="text-xs text-[color:var(--muted)]">Arena Console</p>
              </div>
            </div>
            <button
              onClick={() => createNewConversation(profile.handle)}
              className="mt-4 w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--panel-2)] px-3 py-2 text-xs text-[color:var(--text)] transition hover:border-[color:var(--accent)]"
            >
              New chat
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            <p className="mb-3 text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
              History
            </p>
            <div className="space-y-2">
              {orderedConversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => setActiveConversationId(conv.id)}
                  className={`w-full rounded-xl px-3 py-2 text-left text-sm transition ${
                    conv.id === activeConversationId
                      ? "bg-[color:var(--panel-2)] text-[color:var(--text)]"
                      : "text-[color:var(--muted)] hover:bg-[color:var(--panel-2)]"
                  }`}
                >
                  <div className="line-clamp-1 font-medium">
                    {conv.title}
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--muted)]">
                    {new Date(conv.updatedAt).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-[color:var(--border)] p-4">
            <button
              onClick={disconnectProfile}
              className="w-full rounded-xl border border-[color:var(--border)] bg-transparent px-3 py-2 text-xs text-[color:var(--muted)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--text)]"
            >
              Switch handle
            </button>
            <a
              href="/admin"
              className="mt-3 block w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--panel-2)] px-3 py-2 text-center text-xs text-[color:var(--text)] transition hover:border-[color:var(--accent)]"
            >
              Admin tools
            </a>
          </div>
        </aside>

        <section className="flex flex-1 flex-col">
          <div className="border-b border-[color:var(--border)] px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
                  Gladius
                </p>
                <p className="text-sm text-[color:var(--muted)]">
                  {chatLoading ? "Processing" : "Ready"}
                </p>
              </div>
              {chatError ? (
                <p className="text-xs text-rose-400">{chatError}</p>
              ) : null}
            </div>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-6">
            {(activeConversation?.messages || []).map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                    msg.role === "user"
                      ? "bg-[color:var(--accent)] text-black"
                      : "bg-[color:var(--panel)] text-[color:var(--text)] border border-[color:var(--border)]"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  {msg.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={msg.imageUrl}
                      alt="Generated"
                      className="mt-3 w-full rounded-xl border border-[color:var(--border)]"
                    />
                  ) : null}
                </div>
              </div>
            ))}
            {chatLoading ? (
              <div className="flex items-center gap-2 text-xs text-[color:var(--muted)]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[color:var(--accent)]" />
                Gladius is thinking...
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <div className="border-t border-[color:var(--border)] px-6 py-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 rounded-2xl border border-[color:var(--border)] bg-[color:var(--panel-2)] px-4 py-3">
                <textarea
                  value={messageInput}
                  onChange={(event) => setMessageInput(event.target.value)}
                  onKeyDown={onMessageKeyDown}
                  rows={2}
                  placeholder="Message Gladius"
                  className="w-full resize-none bg-transparent text-sm text-[color:var(--text)] outline-none placeholder:text-[color:var(--muted)]"
                />
              </div>
              <button
                onClick={sendMessage}
                disabled={chatLoading}
                className="inline-flex items-center justify-center rounded-2xl bg-[color:var(--accent)] px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-60"
              >
                {chatLoading ? "Sending" : "Send"}
              </button>
            </div>
            <p className="mt-3 text-xs text-[color:var(--muted)]">
              Enter to send. Shift + Enter for a new line.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
