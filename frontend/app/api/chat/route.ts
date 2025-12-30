import { NextResponse } from "next/server";
import { buildSystemPrompt } from "@/app/lib/gladiusPrompt";
import { dispatchTool, toolDeclarations } from "@/app/lib/arenaTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = {
  role: "user" | "assistant" | "system" | "developer";
  content: string;
};

type ChatPayload = {
  message: string;
  handle?: string;
  profile?: Record<string, unknown>;
  history?: ChatMessage[];
};

type GeminiContent = {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
};

const safeNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const buildUserContext = (handle: string, profile?: Record<string, unknown>) => {
  if (!handle && !profile) return "";
  const name = typeof profile?.name === "string" ? profile.name : "";
  const description =
    typeof profile?.description === "string" ? profile.description : "";
  const followers = safeNumber(profile?.followers);
  const followings = safeNumber(profile?.followings);
  const threads = safeNumber(profile?.threads);

  return [
    `Current user: @${handle || "unknown"}.`,
    name ? `Name: ${name}.` : "",
    description ? `Bio: ${description}.` : "",
    followers !== undefined ? `Followers: ${followers}.` : "",
    followings !== undefined ? `Following: ${followings}.` : "",
    threads !== undefined ? `Threads: ${threads}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
};

const sanitizeHistory = (history?: ChatMessage[]) => {
  if (!Array.isArray(history)) return [] as GeminiContent[];
  const cleaned = history
    .filter((msg) => msg && typeof msg.content === "string")
    .map((msg) => {
      const role: GeminiContent["role"] =
        msg.role === "assistant" ? "model" : "user";
      return {
        role,
        content: msg.content.trim().slice(0, 2000),
      };
    })
    .filter((msg) => msg.content.length > 0)
    .map((msg): GeminiContent => ({
      role: msg.role,
      parts: [{ text: msg.content }],
    }));
  return cleaned.slice(-12);
};

const extractText = (parts: Array<Record<string, unknown>> = []) =>
  parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

const extractFunctionCall = (parts: Array<Record<string, unknown>> = []) => {
  for (const part of parts) {
    if (part.functionCall) {
      return part.functionCall as { name?: string; args?: Record<string, any> };
    }
  }
  return null;
};

const buildGeminiResponse = (
  name: string,
  response: Record<string, unknown>
): GeminiContent => {
  const role: GeminiContent["role"] = "user";
  return {
    role,
    parts: [
      {
        functionResponse: {
          name,
          response,
        },
      },
    ],
  };
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatPayload;
    const message = String(body?.message || "").trim();
    if (!message) {
      return NextResponse.json({ error: "Missing message." }, { status: 400 });
    }
    console.log("[chat] incoming message:", message.slice(0, 300));

    const handle = String(body?.handle || body?.profile?.handle || "")
      .trim()
      .replace(/^@+/, "");

    const apiKey = process.env.GENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing GENAI_API_KEY." },
        { status: 500 }
      );
    }

    const systemPrompt = buildSystemPrompt(
      new Date().toISOString().slice(0, 10)
    );
    const contextPrompt = buildUserContext(handle, body?.profile);
    const systemText = contextPrompt
      ? `${systemPrompt}\n\n${contextPrompt}`
      : systemPrompt;

    const model =
      process.env.GENAI_MODEL ||
      process.env.GOOGLE_GENAI_MODEL ||
      "gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const contents: GeminiContent[] = [
      ...sanitizeHistory(body?.history),
      { role: "user", parts: [{ text: message }] },
    ];

    const tools = [{ functionDeclarations: toolDeclarations }];

    let answer = "";
    let imageUrl = "";
    let imageDataUrl = "";
    let imageCaption = "";
    let imageUploadError = "";
    const collectedImageUrls: string[] = [];
    let safetyStop = false;

    for (let i = 0; i < 4; i += 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemText }] },
          contents,
          tools,
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 700,
          },
        }),
        next: { revalidate: 0 },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return NextResponse.json(
          { error: `Gemini error (${response.status}).`, details: errorText },
          { status: 500 }
        );
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const text = extractText(parts);
      const functionCall = extractFunctionCall(parts);

      if (candidate?.finishReason === "SAFETY") {
        safetyStop = true;
      }

      if (functionCall?.name) {
        contents.push({
          role: "model",
          parts: [{ functionCall }],
        });

        const args =
          functionCall.args && typeof functionCall.args === "object"
            ? functionCall.args
            : {};
        console.log("[chat] tool call:", functionCall.name, args);
        if (functionCall.name === "generate_image") {
          const ctx = Array.isArray(args.context_image_urls)
            ? args.context_image_urls
            : [];
          if (!ctx.length && collectedImageUrls.length) {
            args.context_image_urls = collectedImageUrls.slice(0, 3);
          }
        }
        let toolResult: Record<string, unknown> | unknown;
        try {
          toolResult = await dispatchTool(functionCall.name, args);
          console.log(
            "[chat] tool result:",
            functionCall.name,
            typeof toolResult === "object"
              ? JSON.stringify(toolResult).slice(0, 800)
              : String(toolResult)
          );
          if (
            functionCall.name === "get_profile_image" &&
            toolResult &&
            typeof toolResult === "object"
          ) {
            const resultObj = toolResult as Record<string, unknown>;
            if (typeof resultObj.image_url === "string") {
              collectedImageUrls.push(resultObj.image_url);
            }
          }
          if (
            functionCall.name === "generate_image" &&
            toolResult &&
            typeof toolResult === "object"
          ) {
            const resultObj = toolResult as Record<string, unknown>;
            if (typeof resultObj.image_url === "string") {
              imageUrl = resultObj.image_url;
            }
            if (typeof resultObj.image_data_url === "string") {
              imageDataUrl = resultObj.image_data_url;
            }
            if (typeof resultObj.caption === "string") {
              imageCaption = resultObj.caption;
            }
            if (typeof resultObj.upload_error === "string") {
              imageUploadError = resultObj.upload_error;
            }
            console.log("[chat] image ready:", {
              image_url: imageUrl || null,
              has_data_url: Boolean(imageDataUrl),
              upload_error: imageUploadError || null,
            });
            return NextResponse.json({
              answer: "",
              image_url: imageUrl || undefined,
              image_data_url: imageDataUrl || undefined,
              image_caption: imageCaption || undefined,
              image_upload_error: imageUploadError || undefined,
            });
          }
        } catch (toolError) {
          console.log(
            "[chat] tool error:",
            functionCall.name,
            toolError instanceof Error ? toolError.message : toolError
          );
          toolResult = {
            error:
              toolError instanceof Error ? toolError.message : "Tool error.",
          };
        }

        contents.push(
          buildGeminiResponse(functionCall.name, { result: toolResult })
        );
        continue;
      }

      answer = text;
      break;
    }

    if (!answer && safetyStop) {
      answer = "Cannot answer that.";
    }

    return NextResponse.json({
      answer,
      image_url: imageUrl || undefined,
      image_data_url: imageDataUrl || undefined,
      image_caption: imageCaption || undefined,
      image_upload_error: imageUploadError || undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent error." },
      { status: 500 }
    );
  }
}
