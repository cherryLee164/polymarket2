import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
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
    if (body?.action === "boost") {
      const amount = Number(body?.amount) || 1;
      const rootDir = process.cwd();
      const scriptPath = path.join(rootDir, "scripts", "test_extra_order.py");
      const logDir = path.join(rootDir, "data", "weather_predictions");
      const now = new Date();
      const beijingDate = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const todayLog = `weather-boost-${beijingDate}.log`;
      const logPath = path.join(logDir, todayLog);
      const fs = await import("fs");
      const logStream = fs.createWriteStream(logPath, { flags: "a" });
      const child = spawn("python", [scriptPath, "--amount", String(amount)], {
        cwd: rootDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      logStream.write(`\n[${new Date().toISOString()}] boost started amount=${amount}\n`);
      child.stdout.on("data", (data) => logStream.write(data));
      child.stderr.on("data", (data) => logStream.write(data));
      child.on("exit", (code) => {
        logStream.write(`[${new Date().toISOString()}] boost exited code=${code}\n`);
        logStream.end();
      });
      return NextResponse.json(
        {
          ok: true,
          message: `加仓已启动，每个城市 $${amount}`,
          logFile: todayLog,
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
