import { NextResponse } from "next/server";
import { getUserTrackerData } from "@/lib/user-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getUserTrackerData();
    return NextResponse.json(data, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "user-tracker-failed" },
      { status: 500 },
    );
  }
}
