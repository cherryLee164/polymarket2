import { NextResponse } from "next/server";
import { getRecoverySnapshot } from "@/lib/recovery-data";
import { writeRecoveryConfig } from "@/lib/recovery-config";
import { getBtcServiceStatus, startBtcServices, stopBtcServices } from "@/lib/service-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getRecoverySnapshot());
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (body?.action === "start") {
      return NextResponse.json(
        {
          ok: true,
          serviceStatus: startBtcServices(),
        },
        {
          headers: {
            "cache-control": "no-store",
          },
        },
      );
    }
    if (body?.action === "stop") {
      return NextResponse.json(
        {
          ok: true,
          serviceStatus: stopBtcServices(),
        },
        {
          headers: {
            "cache-control": "no-store",
          },
        },
      );
    }
    const config = await writeRecoveryConfig({
      entryLeadMinutes: body?.entryLeadMinutes,
      limitPriceCents: body?.limitPriceCents,
      limitShares: body?.limitShares,
    });
    return NextResponse.json(
      {
        ok: true,
        config,
        serviceStatus: getBtcServiceStatus(),
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error?.message || "recovery-config-update-failed",
      },
      { status: 400 },
    );
  }
}
