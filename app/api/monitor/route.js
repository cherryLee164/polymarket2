import { NextResponse } from "next/server";
import { getMonitorSnapshot } from "@/lib/monitor-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request) {
  const { searchParams } = new URL(request.url);
  return NextResponse.json(
    getMonitorSnapshot({
      startDate: searchParams.get("startDate"),
      endDate: searchParams.get("endDate"),
      page: searchParams.get("monitorPage") || searchParams.get("page"),
      monitorVariant: searchParams.get("monitorVariant"),
    }),
  );
}
