import { NextResponse } from "next/server";
import { getOrderSnapshot } from "@/lib/order-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request) {
  const { searchParams } = new URL(request.url);

  return NextResponse.json(
    getOrderSnapshot({
      hourPage: searchParams.get("hourPage"),
      orderPage: searchParams.get("orderPage"),
      settlePage: searchParams.get("settlePage"),
    }),
  );
}
