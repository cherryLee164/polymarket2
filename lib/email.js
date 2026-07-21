const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_ORDER_PATH = path.join(ROOT_DIR, ".env.order");

function readEnvOrderText() {
  try {
    return fs.readFileSync(ENV_ORDER_PATH, "utf8");
  } catch {
    return "";
  }
}

function parseEmailConfig() {
  const text = readEnvOrderText();
  // 匹配 EMAIL_CONFIG = { ... }（支持多行）
  const match = text.match(/EMAIL_CONFIG\s*=\s*\{[\s\S]*?\}/);
  if (!match) {
    return null;
  }
  // 把 Python dict 风格的单引号替换为 JSON 双引号，再解析
  let raw = match[0].replace(/^EMAIL_CONFIG\s*=\s*/, "");
  raw = raw.replace(/'/g, '"');
  raw = raw.replace(/\b(True|False|None)\b/g, (_, token) => {
    if (token === "True") return "true";
    if (token === "False") return "false";
    return "null";
  });
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildTransporter(config) {
  return nodemailer.createTransport({
    host: config.smtp_server,
    port: Number(config.smtp_port) || 465,
    secure: Number(config.smtp_port) === 465 || Number(config.smtp_port) === 587,
    auth: {
      user: config.smtp_user,
      pass: config.smtp_password,
    },
  });
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "$--";
  return `$${num.toFixed(2)}`;
}

function buildReportBody({ date, balanceUsd, orders, todayProfitUsd, yesterdayBalanceUsd, stakePlan }) {
  const orderRows = orders
    .map((o) => {
      const city = o.cityZh || o.citySlug || "未知";
      const target = o.targetTempC != null ? `${o.targetTempC}°C` : "--";
      const stake = formatCurrency(o.spentUsd || o.stakeUsd || o.requestedStakeUsd);
      const price = o.buyNoPrice != null ? `${(Number(o.buyNoPrice) * 100).toFixed(1)}¢` : "--";
      const status = o.status || "--";
      const pnl = o.status === "resolved" ? formatCurrency(o.pnlUsd) : "待结算";
      return `<tr><td>${city}</td><td>${target}</td><td>${stake}</td><td>${price}</td><td>${status}</td><td>${pnl}</td></tr>`;
    })
    .join("");

  const todayStake = orders.reduce((s, o) => s + Number(o.spentUsd || o.stakeUsd || o.requestedStakeUsd || 0), 0);
  const sp = stakePlan || {};
  const tierLabel = sp.tier || "--";
  const stakePerCity = sp.stakeUsd != null ? formatCurrency(sp.stakeUsd) : "--";
  const activeCities = sp.activeCitySlugs ? `${sp.activeCitySlugs.length} 个` : "--";
  const downgradeReason = sp.downgradeReason || null;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Polymarket 天气实盘日报</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
table { border-collapse: collapse; margin: 12px 0; }
th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
th { background: #f5f5f5; }
.metric { font-size: 18px; font-weight: bold; margin-right: 24px; }
.profit { color: #2e7d32; }
.loss { color: #c62828; }
.stake-info { color: #666; margin: 8px 0; }
</style>
</head>
<body>
<h2>Polymarket 天气实盘日报 ${date}</h2>
<p>
  <span class="metric">账户余额: ${formatCurrency(balanceUsd)}</span>
  <span class="metric">今日下单: ${formatCurrency(todayStake)}</span>
  <span class="metric">昨日余额: ${formatCurrency(yesterdayBalanceUsd)}</span>
  <span class="metric ${todayProfitUsd >= 0 ? "profit" : "loss"}">今日盈亏: ${todayProfitUsd == null ? "--" : (todayProfitUsd >= 0 ? "+" : "") + formatCurrency(todayProfitUsd).replace("$", "")}</span>
</p>
<p class="stake-info">
  档位: <b>${tierLabel}</b> | 单笔金额: <b>${stakePerCity}</b> | 实际下单城市: <b>${activeCities}</b>
  ${downgradeReason ? `| 降级原因: ${downgradeReason}` : ""}
</p>
<table>
  <thead>
    <tr><th>城市</th><th>目标温度</th><th>下单金额</th><th>No 价格</th><th>状态</th><th>盈亏</th></tr>
  </thead>
  <tbody>
    ${orderRows || '<tr><td colspan="6">今日无订单</td></tr>'}
  </tbody>
</table>
<p style="color:#888;font-size:12px;">本邮件由 weather_live_order_loop.js 自动发送</p>
</body>
</html>`;
}

async function sendDailyReport({ date, balanceUsd, orders, todayProfitUsd, yesterdayBalanceUsd, exitReason, stakePlan }) {
  const config = parseEmailConfig();
  if (!config) {
    console.log("[EMAIL] EMAIL_CONFIG not found in .env.order, skip sending");
    return { sent: false, reason: "no-config" };
  }
  if (!config.smtp_server || !config.smtp_user || !config.smtp_password) {
    console.log("[EMAIL] incomplete EMAIL_CONFIG, skip sending");
    return { sent: false, reason: "incomplete-config" };
  }
  const to = Array.isArray(config.to_emails) && config.to_emails.length > 0
    ? config.to_emails
    : [config.smtp_user];
  const subject = `${config.subject_prefix || "[TDS监控]"} 天气实盘日报 ${date} ${exitReason || ""}`.trim();
  const html = buildReportBody({ date, balanceUsd, orders, todayProfitUsd, yesterdayBalanceUsd, stakePlan });
  const transporter = buildTransporter(config);
  try {
    const info = await transporter.sendMail({
      from: config.from_email || config.smtp_user,
      to,
      subject,
      html,
    });
    console.log(`[EMAIL] sent: ${info.messageId} to=${to.join(",")}`);
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[EMAIL] failed: ${error?.message || error}`);
    return { sent: false, reason: "send-error", error: String(error?.message || error) };
  }
}

module.exports = { sendDailyReport, parseEmailConfig };
