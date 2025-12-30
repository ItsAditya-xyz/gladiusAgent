import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rawHandle = String(body?.handle || "").trim();
    const handle = rawHandle.replace(/^@+/, "");

    if (!handle) {
      return NextResponse.json({ error: "Missing handle." }, { status: 400 });
    }

    const url = `https://api.starsarena.com/user/handle?handle=${encodeURIComponent(handle)}`;
    const headers: HeadersInit = {
      Accept: "application/json",
    };
    const jwt = process.env.ARENA_JWT || process.env.JWT;
    if (jwt) {
      headers.Authorization = `Bearer ${jwt}`;
    }

    const res = await fetch(url, {
      headers,
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        {
          error: `Arena API error (${res.status}).`,
          details: text.slice(0, 400),
        },
        { status: res.status }
      );
    }

    const data = await res.json();
    const user = data?.user || data?.data?.user || {};
    if (!user?.id) {
      return NextResponse.json(
        { error: "Handle not found." },
        { status: 404 }
      );
    }

    const profile = {
      id: user.id,
      handle: user.twitterHandle || user.handle || handle,
      name: user.twitterName || user.name,
      description: user.twitterDescription || user.description,
      followers: user.followerCount,
      followings: user.followingsCount,
      threads: user.threadCount,
      avatar: user.twitterPicture || user.picture || user.profileImage,
    };

    return NextResponse.json({ profile });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch profile." },
      { status: 500 }
    );
  }
}
