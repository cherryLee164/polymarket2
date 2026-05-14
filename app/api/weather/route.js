import { NextResponse } from "next/server";
import { getWeatherDashboardSnapshot } from "@/lib/weather-trading-data";
import { writeWeatherLiveConfig } from "@/lib/weather-live-config";
import { getWeatherServiceStatus, startWeatherService, stopWeatherService } from "@/lib/service-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await getWeatherDashboardSnapshot();
    return NextResponse.json(snapshot, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error?.message || "weather-sync-failed",
      },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (body?.action === "start") {
      return NextResponse.json(
        {
          ok: true,
          serviceStatus: startWeatherService(),
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
          serviceStatus: stopWeatherService(),
        },
        {
          headers: {
            "cache-control": "no-store",
          },
        },
      );
    }
    const config = await writeWeatherLiveConfig({
      liveBaseStake: body?.liveBaseStake,
      temperatureOffsets: body?.temperatureOffsets,
      offsetStrategies: body?.offsetStrategies,
      executionMode: body?.executionMode,
    });
    return NextResponse.json(
      {
        ok: true,
        config,
        serviceStatus: getWeatherServiceStatus(),
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
        error: error?.message || "weather-config-update-failed",
      },
      { status: 400 },
    );
  }
}
