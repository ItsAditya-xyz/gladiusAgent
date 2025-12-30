import { arenaFetch } from "@/app/lib/arenaApi";
import { Buffer } from "node:buffer";
import { getSupabase } from "@/app/lib/supabaseServer";
import { extractPostIdFromUrl, isUuid } from "@/app/lib/ids";
import { istWindow } from "@/app/lib/time";

const cleanText = (value: string) =>
  value
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const safeNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const getTopCommunities = async (sinceDays = 7, limitN = 10) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("top_communities_by_activity", {
    since_interval: `${sinceDays} days`,
    limit_n: limitN,
  });
  if (error) throw new Error(error.message);
  return data || [];
};

export const getCommunityTimeseries = async (
  communityIdOrContract: string,
  daysBack = 14
) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("community_activity_timeseries", {
    p_community: communityIdOrContract,
    days_back: Math.min(daysBack, 30),
  });
  if (error) throw new Error(error.message);
  return { community_id: communityIdOrContract, series: data || [] };
};

export const searchTokenCommunities = async (
  tokenNameOrContract: string
) => {
  return arenaFetch(
    `/communities/search?searchString=${encodeURIComponent(
      tokenNameOrContract
    )}`
  );
};

export const getTopUsers = async (sinceDays = 7, limitN = 12) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("top_users_by_engagement", {
    since_interval: `${sinceDays} days`,
    limit_n: limitN,
  });
  if (error) throw new Error(error.message);
  return (data || []).map((row: Record<string, unknown>) => {
    const handle = typeof row.handle === "string" ? row.handle : "";
    return {
      ...row,
      display: handle ? `@${handle}` : row.display,
    };
  });
};

const fetchProfileByHandle = async (handle: string) => {
  const data = await arenaFetch(
    `/user/handle?handle=${encodeURIComponent(handle)}`
  );
  const user = data?.user || data?.data?.user || {};
  if (!user?.id) {
    throw new Error("Arena profile not found.");
  }
  return user;
};

const resolveUserId = async (handleOrId: string) => {
  const cleaned = (handleOrId || "").trim().replace(/^@+/, "");
  if (isUuid(cleaned)) return cleaned;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("sa_users")
    .select("id")
    .ilike("handle", cleaned)
    .limit(1);
  if (!error && data && data[0]?.id) {
    return data[0].id as string;
  }

  const profile = await fetchProfileByHandle(cleaned);
  if (profile?.id) return profile.id as string;

  throw new Error(`Could not resolve user id from '${handleOrId}'.`);
};

export const getUserRecentPosts = async (userId: string, limitN = 8) => {
  const supabase = getSupabase();
  const uid = await resolveUserId(userId);
  const { data, error } = await supabase.rpc("user_recent_posts", {
    p_user: uid,
    limit_n: limitN,
  });
  if (error) throw new Error(error.message);
  const rows = data || [];
  return rows.map((row: Record<string, unknown>) => ({
    ...row,
    content_text:
      typeof row.content_text === "string" && row.content_text.length > 400
        ? `${row.content_text.slice(0, 400)}...`
        : row.content_text,
  }));
};

export const getUserTopPosts = async (
  userId: string,
  daysBack = 90,
  k = 20
) => {
  const supabase = getSupabase();
  const uid = await resolveUserId(userId);

  let { data, error } = await supabase.rpc("user_recent_posts_simple", {
    p_user: uid,
    limit_n: k,
  });

  if (error) throw new Error(error.message);

  let rows = data || [];
  if (!rows.length) {
    const fallback = await supabase.rpc("user_top_posts", {
      p_user: uid,
      days_back: daysBack,
      k,
    });
    if (fallback.error) throw new Error(fallback.error.message);
    rows = fallback.data || [];
  }

  const excerpt = rows
    .map((row: Record<string, unknown>) =>
      cleanText(String(row.content_text || ""))
    )
    .filter(Boolean)
    .join("\n\n");

  return { posts: rows, excerpt };
};

export const getTrendingFeed = async (limitN = 12) => {
  const pageSize = Math.min(Math.max(limitN, 3), 25);
  return arenaFetch(`/threads/feed/trendingPosts?page=1&pageSize=${pageSize}`);
};

const upsertUserRow = async (
  userId: string,
  handle?: string,
  name?: string,
  picture?: string,
  address?: string
) => {
  if (!userId) return;
  const supabase = getSupabase();
  const payload: Record<string, unknown> = { id: userId };
  if (handle) payload.handle = handle.replace(/^@+/, "");
  if (name !== undefined) payload.name = name;
  if (picture !== undefined) payload.picture = picture;
  if (address !== undefined) payload.address = address;
  await supabase.from("sa_users").upsert(payload, { onConflict: "id" });
};

const upsertCommunityRow = async (communityId: string, name?: string) => {
  if (!communityId) return;
  const supabase = getSupabase();
  await supabase
    .from("sa_communities")
    .upsert({ id: communityId, name }, { onConflict: "id" });
};

const normalizeApiImages = (images: Array<Record<string, unknown> | string>) =>
  (images || []).reduce<Record<string, unknown>[]>((acc, item) => {
    if (typeof item === "string") {
      acc.push({ source_url: item });
      return acc;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const url =
        (typeof obj.url === "string" && obj.url) ||
        (typeof obj.path === "string" && obj.path) ||
        (typeof obj.src === "string" && obj.src) ||
        (typeof obj.source_url === "string" && obj.source_url);
      if (typeof url === "string") {
        acc.push({
          source_url: url,
          mime: obj.mime,
          width: obj.width,
          height: obj.height,
          is_gif:
            typeof obj.is_gif === "boolean"
              ? obj.is_gif
              : url.toLowerCase().endsWith(".gif"),
        });
      }
    }
    return acc;
  }, []);

const existingImageSourceUrls = async (threadId: string) => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("sa_images")
    .select("source_url")
    .eq("thread_id", threadId);
  if (error) throw new Error(error.message);
  return new Set(
    (data || [])
      .map((row: { source_url?: string }) => row.source_url)
      .filter(Boolean) as string[]
  );
};

const upsertImagesForThread = async (
  threadId: string,
  imagesPayload: Array<Record<string, unknown> | string>
) => {
  const images = normalizeApiImages(imagesPayload || []);
  if (!images.length) return 0;

  const existing = await existingImageSourceUrls(threadId);
  const rows = images
    .filter((img) => typeof img.source_url === "string")
    .filter((img) => !existing.has(String(img.source_url)))
    .map((img) => ({
      thread_id: threadId,
      source_url: img.source_url,
      storage_path: null,
      mime: img.mime || null,
      width: img.width || null,
      height: img.height || null,
      is_gif: img.is_gif || false,
    }));

  if (!rows.length) return 0;
  const supabase = getSupabase();
  const { error } = await supabase.from("sa_images").insert(rows);
  if (error) throw new Error(error.message);
  return rows.length;
};

const upsertThreadsFromApiPayload = async (
  userId: string,
  payload: Record<string, unknown>
) => {
  const threads = (payload?.threads as Array<Record<string, unknown>>) || [];
  if (!threads.length) return 0;
  const supabase = getSupabase();
  const rows = [] as Array<Record<string, unknown>>;

  for (const thread of threads) {
    const threadId = String(thread.id || "");
    if (!threadId) continue;

    const userHandle =
      typeof thread.userHandle === "string" ? thread.userHandle : "";
    const userObj = (thread.user as Record<string, unknown>) || {};
    const userName =
      typeof userObj.name === "string" ? userObj.name : undefined;
    const userPic =
      typeof userObj.profileImage === "string"
        ? userObj.profileImage
        : typeof userObj.picture === "string"
          ? userObj.picture
          : undefined;
    const userAddr =
      typeof userObj.address === "string" ? userObj.address : undefined;

    await upsertUserRow(userId, userHandle, userName, userPic, userAddr);

    const communityId = thread.communityId as string | undefined;
    if (communityId) {
      await upsertCommunityRow(communityId, thread.communityName as string);
    }

    rows.push({
      id: threadId,
      user_id: userId,
      community_id: communityId || null,
      content_html: thread.content || null,
      content_text: cleanText(String(thread.content || "")),
      thread_type: thread.threadType,
      language: thread.language,
      display_status: thread.displayStatus,
      created_at: thread.createdAt,
      updated_at: thread.updatedAt,
      answer_count: thread.answerCount || 0,
      like_count: thread.likeCount || 0,
      bookmark_count: thread.bookmarkCount || 0,
      repost_count: thread.repostCount || 0,
      is_edited: Boolean(thread.isEdited),
      is_deleted: Boolean(thread.isDeleted),
      is_pinned: Boolean(thread.isPinned),
      pinned_in_community: Boolean(thread.pinnedInCommunity),
      paywall: Boolean(thread.paywall),
      price: thread.price,
      currency: thread.currency,
      currency_address: thread.currencyAddress,
      currency_decimals: thread.currencyDecimals,
      tip_amount: thread.tipAmount,
      tip_count: thread.tipCount,
    });
  }

  const { error } = await supabase
    .from("sa_threads")
    .upsert(rows, { onConflict: "id" });
  if (error) throw new Error(error.message);

  for (const thread of threads) {
    const threadId = String(thread.id || "");
    if (!threadId) continue;
    const imagesPayload =
      (thread.images as Array<Record<string, unknown> | string>) ||
      (thread.image as Array<Record<string, unknown> | string>) ||
      (thread.media as Array<Record<string, unknown> | string>) ||
      [];
    try {
      await upsertImagesForThread(threadId, imagesPayload);
    } catch {
      // ignore image upsert errors
    }
  }

  return rows.length;
};

const ensureThreadsForUser = async (
  userId: string,
  freshnessMinutes = 10,
  maxFetch = 200
) => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("sa_threads")
    .select("created_at", { count: "exact" })
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);

  const latest = data?.[0]?.created_at as string | undefined;
  let needsRefresh = true;
  if (latest) {
    const latestDate = new Date(latest);
    const ageMinutes = (Date.now() - latestDate.getTime()) / (1000 * 60);
    needsRefresh = ageMinutes > freshnessMinutes;
  }

  if (!needsRefresh) return 0;

  let page = 1;
  let inserted = 0;
  while (inserted < maxFetch) {
    const payload = await arenaFetch(
      `/threads/feed/user?userId=${encodeURIComponent(
        userId
      )}&page=${page}&pageSize=50`
    );
    const threads = payload?.threads || [];
    if (!threads.length) break;

    inserted += await upsertThreadsFromApiPayload(userId, { threads });
    if (threads.length < 50) break;
    page += 1;
  }

  return inserted;
};

export const getUserStats = async (
  handle: string,
  includePosts = true,
  maxChars = 4000,
  topDaysBack = 90,
  topK = 20
) => {
  const cleanHandle = (handle || "").trim().replace(/^@+/, "");
  const user = await fetchProfileByHandle(cleanHandle);
  if (!user?.id) {
    throw new Error("Arena profile not found.");
  }

  const profile = {
    handle: user.twitterHandle || user.handle || cleanHandle,
    name: user.twitterName || user.name,
    user_id: user.id,
    followers: user.followerCount,
    followings: user.followingsCount,
    thread_count: user.threadCount,
    description: cleanText(user.twitterDescription || ""),
    created_on: user.createdOn,
    address: user.address,
    key_price_avax: user.lastKeyPrice
      ? Math.round(safeNumber(user.lastKeyPrice) / 1e18 * 1000) / 1000
      : null,
    display: user.twitterHandle ? `@${user.twitterHandle}` : null,
    twitterPicture: user.twitterPicture,
  };

  const stats = await arenaFetch(
    `/shares/stats?userId=${encodeURIComponent(user.id)}`
  );

  const shares = {
    total_holdings: stats?.totalHoldings,
    total_holders: stats?.totalHolders,
    buys: stats?.stats?.buys,
    sells: stats?.stats?.sells,
    fees_paid_avax: stats?.stats?.feesPaid
      ? Math.round(safeNumber(stats.stats.feesPaid) / 1e18 * 1000) / 1000
      : null,
    fees_earned_avax: stats?.stats?.feesEarned
      ? Math.round(safeNumber(stats.stats.feesEarned) / 1e18 * 1000) / 1000
      : null,
    portfolio_value_avax: stats?.portfolioValue
      ? Math.round(safeNumber(stats.portfolioValue) / 1e18 * 1000) / 1000
      : null,
    referrals_earned_avax: stats?.stats?.referralsEarned
      ? Math.round(safeNumber(stats.stats.referralsEarned) / 1e18 * 1000) / 1000
      : null,
  };

  const sync = { attempted: false, inserted: 0 };
  if (includePosts && profile.user_id) {
    sync.attempted = true;
    try {
      sync.inserted = await ensureThreadsForUser(profile.user_id);
    } catch {
      sync.inserted = 0;
    }
  }

  let postsExcerpt = "";
  if (includePosts && profile.user_id) {
    const top = await getUserTopPosts(profile.user_id, topDaysBack, topK);
    postsExcerpt = top.excerpt;
    if (maxChars > 0 && postsExcerpt.length > maxChars) {
      postsExcerpt = `${postsExcerpt.slice(0, maxChars)}...`;
    }
  }

  return {
    success: true,
    profile,
    shares,
    posts_excerpt: postsExcerpt,
    sync,
  };
};

export const analyzePost = async (urlOrId: string) => {
  const postId = extractPostIdFromUrl(urlOrId);
  const payload = await arenaFetch(`/threads?threadId=${encodeURIComponent(postId)}`);
  const thread = payload?.thread || {};
  const user = thread.user || {};

  const images = thread.images || [];
  if (thread.id) {
    try {
      await upsertImagesForThread(thread.id, images);
    } catch {
      // ignore
    }
  }

  const media = await getMediaJsonForThread(postId);
  const imageUrls = media.map((m) => m.url).filter(Boolean);

  return {
    success: true,
    post_id: thread.id || postId,
    author: {
      handle: thread.userHandle || user.handle || user.ixHandle || "",
      user_id: user.id,
      display: thread.userHandle ? `@${thread.userHandle}` : null,
    },
    content_text: cleanText(thread.content || ""),
    repostId: thread.repostId,
    threadType: thread.threadType,
    answerId: thread.answerId,
    tipAmount: thread.tipAmount,
    image_urls: imageUrls,
    media,
  };
};

export const getMediaJsonForThread = async (threadId: string) => {
  const supabase = getSupabase();
  const { data: images, error } = await supabase
    .from("sa_images")
    .select("id, source_url, storage_path, mime, width, height, is_gif")
    .eq("thread_id", threadId)
    .order("id", { ascending: true });
  if (error) throw new Error(error.message);

  const ids = (images || []).map((img) => img.id).filter(Boolean) as number[];
  let analyses: Record<string, Record<string, unknown>> = {};
  if (ids.length) {
    const { data: analysisRows, error: analysisError } = await supabase
      .from("sa_image_analysis")
      .select(
        "image_id, caption, ocr_text, topics, entities, safety_flags, sentiment, meme_template, meta"
      )
      .in("image_id", ids);
    if (analysisError) throw new Error(analysisError.message);
    analyses = (analysisRows || []).reduce<Record<string, Record<string, unknown>>>(
      (acc, row: { image_id: number }) => {
        acc[row.image_id] = row as Record<string, unknown>;
        return acc;
      },
      {}
    );
  }

  return (images || []).map((img) => {
    const analysis = analyses[img.id] || {};
    return {
      image_id: img.id,
      url: img.storage_path || img.source_url,
      source_url: img.source_url,
      storage_path: img.storage_path,
      mime: img.mime,
      width: img.width,
      height: img.height,
      is_gif: Boolean(img.is_gif),
      caption: analysis.caption || null,
      ocr_text: analysis.ocr_text || null,
      topics: analysis.topics || [],
      entities: analysis.entities || {},
      safety_flags: analysis.safety_flags || [],
      sentiment: analysis.sentiment || null,
      meme_template: analysis.meme_template || null,
      meta: analysis.meta || {},
    };
  });
};

export const searchKeywordsTimewindow = async (
  query: string,
  startDaysOffset = 0,
  daysSpan = 1,
  limitN = 50,
  mode: "OR" | "AND" = "OR"
) => {
  const supabase = getSupabase();
  const cleaned = query.split(/\s+/).filter(Boolean).join(" ");
  const { start, end } = istWindow(startDaysOffset, daysSpan);
  const { data, error } = await supabase.rpc(
    "search_threads_by_keywords_timewindow",
    {
      p_query: cleaned,
      p_start: start,
      p_end: end,
      p_limit: limitN,
      p_mode: mode,
    }
  );
  if (error) throw new Error(error.message);
  return data || [];
};

export const getConversationHistory = async (limitN = 20, handle?: string) => {
  const supabase = getSupabase();
  const payload: Record<string, unknown> = { p_limit: limitN };
  if (handle) payload.p_handle = handle;
  const { data, error } = await supabase.rpc(
    "tool_get_conversation_history",
    payload
  );
  if (error) throw new Error(error.message);
  return data || [];
};

export const getTopFriends = async (
  startDaysOffset = 0,
  daysSpan = 7,
  limitN = 20
) => {
  const supabase = getSupabase();
  const { start, end } = istWindow(startDaysOffset, daysSpan);
  const { data, error } = await supabase.rpc("tool_top_friends", {
    p_start: start,
    p_end: end,
    p_limit: limitN,
  });
  if (error) throw new Error(error.message);
  return data || [];
};

const parseDataUrl = (dataUrl: string) => {
  const match = dataUrl.match(/^data:(.*?);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid image data URL.");
  }
  return { mimeType: match[1] || "image/png", base64: match[2] };
};

const uploadImageToArena = async (imageDataUrl: string) => {
  const { mimeType, base64 } = parseDataUrl(imageDataUrl);
  const buffer = Buffer.from(base64, "base64");
  const ext = mimeType.includes("png")
    ? "png"
    : mimeType.includes("jpeg") || mimeType.includes("jpg")
      ? "jpg"
      : "png";
  const fileName = `gladius_${Date.now()}.${ext}`;

  const policyResponse = await arenaFetch(
    `/uploads/getUploadPolicy?fileType=${encodeURIComponent(
      mimeType
    )}&fileName=${encodeURIComponent(fileName)}`
  );
  const uploadPolicy = policyResponse?.uploadPolicy as Record<string, unknown>;
  if (!uploadPolicy) {
    throw new Error("Upload policy missing.");
  }

  uploadPolicy["Content-Type"] = mimeType;
  delete uploadPolicy.enctype;
  delete uploadPolicy.url;

  const form = new FormData();
  for (const [key, value] of Object.entries(uploadPolicy)) {
    form.append(key, String(value));
  }
  const blob = new Blob([buffer], { type: mimeType });
  form.append("file", blob, fileName);

  const uploadUrl = "https://storage.googleapis.com/starsarena-s3-01/";
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    body: form,
  });

  if (uploadResponse.status !== 204) {
    const text = await uploadResponse.text();
    throw new Error(
      `Failed to upload image: ${uploadResponse.status} ${text}`
    );
  }

  const key = typeof uploadPolicy.key === "string" ? uploadPolicy.key : "";
  if (!key) {
    throw new Error("Upload policy key missing.");
  }
  return `https://static.starsarena.com/${key}`;
};

export const generateImage = async (
  prompt: string,
  caption?: string,
  contextImageUrls: string[] = []
) => {
  const apiKey = process.env.GENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GENAI_API_KEY.");
  }
  const model =
    process.env.GENAI_IMAGE_MODEL || "gemini-2.5-flash-image";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const requestParts: Array<Record<string, unknown>> = [{ text: prompt }];

  const uniqueUrls = contextImageUrls
    .filter((url) => typeof url === "string")
    .slice(0, 3);

  for (const url of uniqueUrls) {
    try {
      const imgRes = await fetch(url, { cache: "no-store" });
      if (!imgRes.ok) continue;
      const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.byteLength > 2_500_000) continue;
      requestParts.push({
        inlineData: {
          mimeType,
          data: buffer.toString("base64"),
        },
      });
    } catch {
      // ignore individual image failures
    }
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: requestParts,
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    }),
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini image error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const responseParts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find(
    (part: { inlineData?: { data?: string } }) => part?.inlineData?.data
  );
  const imageData = imagePart?.inlineData?.data as string | undefined;
  const mimeType =
    imagePart?.inlineData?.mimeType || "image/png";

  if (!imageData) {
    throw new Error("No image returned from Gemini.");
  }

  let arenaUrl = "";
  let uploadError = "";
  try {
    arenaUrl = await uploadImageToArena(
      `data:${mimeType};base64,${imageData}`
    );
  } catch (error) {
    uploadError =
      error instanceof Error ? error.message : "Upload failed.";
  }

  return {
    image_url: arenaUrl || undefined,
    image_data_url: arenaUrl
      ? ""
      : `data:${mimeType};base64,${imageData}`,
    caption: caption || "",
    upload_error: uploadError || undefined,
  };
};

export const getProfileImage = async (handle: string) => {
  const cleanHandle = (handle || "").trim().replace(/^@+/, "");
  if (!cleanHandle) {
    throw new Error("Missing handle.");
  }
  const data = await arenaFetch(
    `/user/handle?handle=${encodeURIComponent(cleanHandle)}`
  );
  const user = data?.user || data?.data?.user || {};
  const imageUrl =
    user.twitterPicture || user.profileImage || user.picture || null;
  return { handle: cleanHandle, image_url: imageUrl };
};

export const searchWeb = async (
  query: string,
  maxResults = 6,
  searchDepth: "basic" | "advanced" = "basic",
  includeAnswer = true,
  includeDomains?: string[],
  excludeDomains?: string[]
) => {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing TAVILY_API_KEY.");
  }

  const payload: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: Math.min(Math.max(maxResults, 1), 10),
    search_depth: searchDepth,
    include_answer: includeAnswer,
  };

  if (includeDomains && includeDomains.length) {
    payload.include_domains = includeDomains;
  }
  if (excludeDomains && excludeDomains.length) {
    payload.exclude_domains = excludeDomains;
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tavily error (${response.status}): ${text}`);
  }

  const data = await response.json();
  const results = (data?.results || []).slice(0, maxResults).map((item: any) => ({
    title: item?.title || "",
    url: item?.url || "",
    snippet: String(item?.content || "").slice(0, 500),
    score: item?.score,
  }));

  return {
    success: true,
    query: data?.query || query,
    answer: data?.answer,
    results,
  };
};

export const toolDeclarations = [
  {
    name: "get_top_communities",
    description: "Get the most active communities in a recent window.",
    parameters: {
      type: "object",
      properties: {
        since_days: { type: "integer", default: 7, minimum: 1 },
        limit_n: { type: "integer", default: 10, minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "get_community_timeseries",
    description:
      "Get daily activity metrics which includes users posts for a community by UUID or contract address.",
    parameters: {
      type: "object",
      properties: {
        community_id_or_contract: {
          type: "string",
          description: "Community UUID or contract address (0x... or bare hex).",
        },
        days_back: { type: "integer", default: 14, minimum: 1 },
      },
      required: ["community_id_or_contract"],
    },
  },
  {
    name: "search_token_communities",
    description:
      "Search Arena token communities/trenches by name OR contract address.",
    parameters: {
      type: "object",
      properties: {
        token_name_or_contract_address: {
          type: "string",
          description: "Community name (no $) or contract address (0x... ).",
        },
      },
      required: ["token_name_or_contract_address"],
    },
  },
  {
    name: "get_top_users",
    description: "Top engaged users recently.",
    parameters: {
      type: "object",
      properties: {
        since_days: { type: "integer", default: 7, minimum: 1 },
        limit_n: { type: "integer", default: 12, minimum: 3, maximum: 25 },
      },
    },
  },
  {
    name: "get_user_recent_posts",
    description: "Recent posts for a given user id to build evidence.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        limit_n: { type: "integer", default: 8, minimum: 1, maximum: 15 },
      },
      required: ["user_id"],
    },
  },
  {
    name: "get_user_stats",
    description:
      "Fetch Arena user stats and a short posts excerpt by @handle for grounded roasts/comparisons.",
    parameters: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "User handle, with or without leading @",
        },
        include_posts: { type: "boolean", default: true },
        max_chars: { type: "integer", default: 4000, minimum: 500, maximum: 12000 },
        top_days_back: { type: "integer", default: 90, minimum: 7 },
        top_k: { type: "integer", default: 20, minimum: 3, maximum: 50 },
      },
      required: ["handle"],
    },
  },
  {
    name: "get_user_top_posts",
    description: "Fetch a user's top posts (recent + engaged) for grounded evidence.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        days_back: { type: "integer", default: 90, minimum: 7 },
        k: { type: "integer", default: 20, minimum: 3, maximum: 50 },
      },
      required: ["user_id"],
    },
  },
  {
    name: "get_trending_feed",
    description: "Get the current trending feed posts.",
    parameters: {
      type: "object",
      properties: {
        limit_n: { type: "integer", default: 12, minimum: 3, maximum: 25 },
      },
    },
  },
  {
    name: "analyze_post",
    description:
      "Fetch Arena post text + author + images for a given Arena URL or UUID.",
    parameters: {
      type: "object",
      properties: {
        url_or_id: {
          type: "string",
          description: "Full arena.social URL OR raw post UUID.",
        },
      },
      required: ["url_or_id"],
    },
  },
  {
    name: "search_keywords_timewindow",
    description:
      "Keyword(s) search over posts within an IST-based day window.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Space-separated keyword(s)" },
        start_days_offset: {
          type: "integer",
          default: 0,
          maximum: 0,
          description: "0 means today, -1 means yesterday, -7 means from 7 days ago",
        },
        days_span: { type: "integer", default: 1, minimum: 1, maximum: 30 },
        limit_n: { type: "integer", default: 50, minimum: 1, maximum: 100 },
        mode: {
          type: "string",
          enum: ["OR", "AND"],
          default: "OR",
          description: "OR means any keyword in query, AND means all keywords",
        },
      },
      required: ["query", "mode"],
    },
  },
  {
    name: "tool_get_conversation_history",
    description:
      "Fetch recent conversations with the agent on Arena.",
    parameters: {
      type: "object",
      properties: {
        limit_n: { type: "integer", default: 20, minimum: 1, maximum: 100 },
        handle: {
          type: "string",
          description: "Optional parent_user_handle filter (no @).",
        },
      },
    },
  },
  {
    name: "tool_top_friends",
    description:
      "Return the most active users who interacted with the agent within a given time window.",
    parameters: {
      type: "object",
      properties: {
        start_days_offset: {
          type: "integer",
          default: 0,
          description: "Offset from today (negative = days ago).",
        },
        days_span: { type: "integer", default: 7, minimum: 1 },
        limit_n: { type: "integer", default: 20, minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "generate_image",
    description:
      "Generate an image from a prompt. Returns a data URL.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Scene prompt. Include Gladius if requested.",
        },
        caption: {
          type: "string",
          description: "Optional short line to accompany the image.",
        },
        context_image_urls: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional reference image URLs (profile pictures, post images).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "get_profile_image",
    description: "Fetch a user's profile image URL by handle.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Arena handle with or without @" },
      },
      required: ["handle"],
    },
  },
  {
    name: "search_web",
    description:
      "Search the public web (via Tavily) and return ranked results and an optional concise answer.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", default: 6, minimum: 1, maximum: 10 },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          default: "basic",
        },
        include_answer: { type: "boolean", default: true },
        include_domains: { type: "array", items: { type: "string" } },
        exclude_domains: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    },
  },
];

export const dispatchTool = async (name: string, args: Record<string, any>) => {
  switch (name) {
    case "get_top_communities":
      return getTopCommunities(args.since_days, args.limit_n);
    case "get_community_timeseries":
      return getCommunityTimeseries(args.community_id_or_contract, args.days_back);
    case "search_token_communities":
      return searchTokenCommunities(args.token_name_or_contract_address);
    case "get_top_users":
      return getTopUsers(args.since_days, args.limit_n);
    case "get_user_recent_posts":
      return getUserRecentPosts(args.user_id, args.limit_n);
    case "get_user_stats":
      return getUserStats(
        args.handle,
        args.include_posts,
        args.max_chars,
        args.top_days_back,
        args.top_k
      );
    case "get_user_top_posts":
      return getUserTopPosts(args.user_id, args.days_back, args.k);
    case "get_trending_feed":
      return getTrendingFeed(args.limit_n);
    case "analyze_post":
      return analyzePost(args.url_or_id);
    case "search_keywords_timewindow":
      return searchKeywordsTimewindow(
        args.query,
        args.start_days_offset,
        args.days_span,
        args.limit_n,
        args.mode
      );
    case "tool_get_conversation_history":
      return getConversationHistory(args.limit_n, args.handle);
    case "tool_top_friends":
      return getTopFriends(args.start_days_offset, args.days_span, args.limit_n);
    case "generate_image":
      return generateImage(args.prompt, args.caption, args.context_image_urls);
    case "get_profile_image":
      return getProfileImage(args.handle);
    case "search_web":
      return searchWeb(
        args.query,
        args.max_results,
        args.search_depth,
        args.include_answer,
        args.include_domains,
        args.exclude_domains
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};
