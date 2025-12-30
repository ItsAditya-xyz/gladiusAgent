import { NextResponse } from "next/server";
import { toolDeclarations } from "@/app/lib/arenaTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ tools: toolDeclarations });
}
