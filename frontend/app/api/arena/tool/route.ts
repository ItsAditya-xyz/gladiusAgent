import { NextResponse } from "next/server";
import { dispatchTool } from "@/app/lib/arenaTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const name = String(body?.name || "").trim();
    const args = body?.arguments && typeof body.arguments === "object" ? body.arguments : {};

    if (!name) {
      return NextResponse.json({ error: "Missing tool name." }, { status: 400 });
    }

    const result = await dispatchTool(name, args);
    return NextResponse.json({ result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Tool error." },
      { status: 500 }
    );
  }
}
