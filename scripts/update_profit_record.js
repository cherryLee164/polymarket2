// 每日更新收益记录.xlsx：获取账户余额，填入前一天的金额
// 用法：
//   自动获取余额：node scripts/update_profit_record.js
//   手动指定金额：node scripts/update_profit_record.js 2026-06-22 25.50
//   只指定金额（自动用昨天日期）：node scripts/update_profit_record.js 25.50
const ExcelJS = require("exceljs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.join(__dirname, "..");
const XLSX_PATH = path.join(ROOT_DIR, "收益记录.xlsx");
const XLSX_NEW_PATH = path.join(ROOT_DIR, "收益记录.new.xlsx");

// Excel 日期序列号转 YYYY-MM-DD（Excel 序列号从 1900-01-01=1 开始，含 1900-02-29 bug）
function excelSerialToYmd(serial) {
  // Excel epoch: 1899-12-30（考虑 1900-02-29 bug）
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + serial * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 读取单元格日期为 YYYY-MM-DD
function cellDateToYmd(cellValue) {
  if (cellValue instanceof Date) {
    return `${cellValue.getUTCFullYear()}-${String(cellValue.getUTCMonth() + 1).padStart(2, "0")}-${String(cellValue.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof cellValue === "number") {
    return excelSerialToYmd(cellValue);
  }
  return null;
}

// 获取北京时间昨天的日期（YYYY-MM-DD）
function getYesterdayBeijing() {
  const now = new Date();
  // 北京时间 = UTC + 8
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  // 减 1 天
  beijing.setDate(beijing.getDate() - 1);
  const y = beijing.getFullYear();
  const m = String(beijing.getMonth() + 1).padStart(2, "0");
  const d = String(beijing.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 调用 Python 获取 Polymarket 账户余额
function getBalanceFromPython() {
  const scriptPath = path.join(__dirname, "get_balance.py");
  const result = spawnSync("python", [scriptPath], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status !== 0) {
    return { error: result.stderr || "Python 调用失败" };
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { error: "解析余额输出失败" };
  }
}

// 日期转 Excel 行号
// 返回 { sheetName, row } 或 null
function dateToCell(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  if (year !== 2026) return null;

  const monthSheetMap = {
    6: { sheetName: "6月", startDay: 21, days: 30 },
    7: { sheetName: "7月", startDay: 1, days: 31 },
    8: { sheetName: "8月", startDay: 1, days: 31 },
    9: { sheetName: "9月", startDay: 1, days: 30 },
  };

  const cfg = monthSheetMap[month];
  if (!cfg) return null;
  if (day < cfg.startDay || day > cfg.days) return null;

  // 行号 = 1（表头）+ (day - startDay + 1)
  const row = 1 + (day - cfg.startDay + 1);
  return { sheetName: cfg.sheetName, row };
}

async function main() {
  // 解析命令行参数
  const args = process.argv.slice(2);
  let targetDate, amount;

  if (args.length === 0) {
    // 自动模式：获取昨天的余额
    targetDate = getYesterdayBeijing();
    console.log(`自动模式：统计 ${targetDate} 的金额`);
    const balanceResult = getBalanceFromPython();
    if (balanceResult.error) {
      console.error(`获取余额失败: ${balanceResult.error}`);
      console.log(`请手动填入：node scripts/update_profit_record.js ${targetDate} <金额>`);
      process.exit(1);
    }
    amount = balanceResult.portfolioUsd;
    console.log(`资产组合: $${amount}`);
  } else if (args.length === 1) {
    // 只指定金额，用昨天日期
    targetDate = getYesterdayBeijing();
    amount = parseFloat(args[0]);
  } else {
    // 指定日期和金额
    targetDate = args[0];
    amount = parseFloat(args[1]);
  }

  if (!Number.isFinite(amount)) {
    console.error("金额无效");
    process.exit(1);
  }

  console.log(`更新: 日期=${targetDate}, 金额=${amount}`);

  // 查找对应的单元格
  const cellRef = dateToCell(targetDate);
  if (!cellRef) {
    console.error(`日期 ${targetDate} 不在 6-9月范围内`);
    process.exit(1);
  }

  // 读取 xlsx（优先 .new.xlsx 因为它是最新版本，fallback 到原文件）
  const wb = new ExcelJS.Workbook();
  let readPath;
  const fs = require("fs");
  if (fs.existsSync(XLSX_NEW_PATH)) {
    readPath = XLSX_NEW_PATH;
  } else {
    readPath = XLSX_PATH;
  }
  try {
    await wb.xlsx.readFile(readPath);
  } catch (e) {
    console.error(`读取 ${readPath} 失败: ${e.message}`);
    process.exit(1);
  }
  console.log(`读取: ${readPath}`);

  const ws = wb.getWorksheet(cellRef.sheetName);
  if (!ws) {
    console.error(`Sheet "${cellRef.sheetName}" 不存在`);
    process.exit(1);
  }

  // 检查日期是否匹配
  const dateCell = ws.getCell(`A${cellRef.row}`);
  const cellYmd = cellDateToYmd(dateCell.value);
  if (cellYmd !== targetDate) {
    console.error(`日期不匹配: 期望 ${targetDate}, 实际 ${cellYmd}`);
    process.exit(1);
  }

  // 填入金额
  ws.getCell(`B${cellRef.row}`).value = amount;
  console.log(`已填入 ${cellRef.sheetName}!B${cellRef.row} = ${amount}`);

  // 在该月最后一行下面加一行"X月总收益"汇总（公式 = 最后一笔余额 - 首笔余额）
  // 仅当该行尚未填写时写入，避免覆盖用户已写内容
  const [targetYear, targetMonth, targetDay] = targetDate.split("-").map(Number);
  const monthCfg = targetMonth >= 6 && targetMonth <= 9
    ? { startDay: targetMonth === 6 ? 21 : 1, days: targetMonth === 9 ? 30 : (targetMonth === 6 ? 30 : 31) }
    : null;
  if (monthCfg) {
    const monthLastRow = 1 + (monthCfg.days - monthCfg.startDay + 1);
    const summaryRow = monthLastRow + 1;
    const existingSummary = ws.getCell(`A${summaryRow}`).value;
    if (existingSummary === null || existingSummary === undefined || existingSummary === "") {
      ws.getCell(`A${summaryRow}`).value = `${targetMonth}月总收益`;
      ws.getCell(`B${summaryRow}`).value = {
        formula: `LOOKUP(2,1/(B2:B${monthLastRow}<>""),B2:B${monthLastRow})-B2`,
      };
      ws.getCell(`C${summaryRow}`).value = null;
      const bold = { font: { bold: true } };
      ws.getCell(`A${summaryRow}`).style = bold;
      ws.getCell(`B${summaryRow}`).style = bold;
      console.log(`已添加 ${cellRef.sheetName}!A${summaryRow} "${targetMonth}月总收益"`);
    }
  }

  // 保存：只写原文件，被占用则重试 3 次，避免数据分裂
  let writeOk = false;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await wb.xlsx.writeFile(XLSX_PATH);
      writeOk = true;
      break;
    } catch (e) {
      lastErr = e;
      if (e.code === "EBUSY" || e.code === "EPERM") {
        console.log(`原文件被占用，第 ${attempt} 次重试前等待 10 秒...`);
        await new Promise((r) => setTimeout(r, 10000));
      } else {
        throw e;
      }
    }
  }
  if (!writeOk) {
    throw new Error(`写入 xlsx 失败（重试 3 次）: ${lastErr?.message || "unknown"}`);
  }
  console.log(`保存成功: ${XLSX_PATH}`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
