// 迁移收益记录.xlsx：添加 D 列"充值金额"，更新 C 列收入公式和月总收益公式
// 用法：node scripts/migrate_profit_record.js
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const ROOT_DIR = path.join(__dirname, "..");
const XLSX_PATH = path.join(ROOT_DIR, "收益记录.xlsx");

const MONTHS = [
  { sheetName: "6月", month: 6, startDay: 21, days: 30, hasPrev: false },
  { sheetName: "7月", month: 7, startDay: 1, days: 31, hasPrev: true, prevSheet: "6月" },
  { sheetName: "8月", month: 8, startDay: 1, days: 31, hasPrev: true, prevSheet: "7月" },
  { sheetName: "9月", month: 9, startDay: 1, days: 30, hasPrev: true, prevSheet: "8月" },
];

async function main() {
  const readPath = XLSX_PATH;
  if (!fs.existsSync(readPath)) {
    console.error(`文件不存在: ${readPath}`);
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(readPath);
  console.log(`读取: ${readPath}`);

  for (const { sheetName, month, startDay, days, hasPrev, prevSheet } of MONTHS) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) {
      console.log(`跳过: ${sheetName} 不存在`);
      continue;
    }

    // 添加 D 列表头
    const d1 = ws.getCell("D1");
    if (d1.value === null || d1.value === undefined || d1.value === "") {
      d1.value = "充值金额";
      d1.font = { bold: true };
      d1.alignment = { horizontal: "center" };
    }
    ws.getColumn(4).width = 12;

    const monthLastRow = 1 + (days - startDay + 1);
    const prevMonthLastRow = hasPrev
      ? 1 + (MONTHS.find((m) => m.sheetName === prevSheet).days - MONTHS.find((m) => m.sheetName === prevSheet).startDay + 1)
      : 0;

    // 更新 C 列收入公式
    for (let row = 2; row <= monthLastRow; row++) {
      const cCell = ws.getCell(`C${row}`);
      if (row === 2 && !hasPrev) {
        // 6-21 起始日，收入 = 0
        cCell.value = 0;
      } else if (row === 2 && hasPrev) {
        // 跨月首日
        cCell.value = {
          formula: `B${row}-${prevSheet}!B${prevMonthLastRow}-IF(D${row}="",0,D${row})`,
        };
      } else {
        // 同月内
        cCell.value = { formula: `B${row}-B${row - 1}-IF(D${row}="",0,D${row})` };
      }
    }

    // 更新月总收益行（summaryRow）
    const summaryRow = monthLastRow + 1;
    const existingSummary = ws.getCell(`A${summaryRow}`).value;
    if (existingSummary !== null && existingSummary !== undefined && existingSummary !== "") {
      // 已有总收益行，更新公式
      ws.getCell(`B${summaryRow}`).value = {
        formula: `LOOKUP(2,1/(B2:B${monthLastRow}<>""),B2:B${monthLastRow})-B2-SUM(D2:D${monthLastRow})`,
      };
      console.log(`  ${sheetName} 总收益公式已更新`);
    } else {
      // 没有总收益行，创建
      ws.getCell(`A${summaryRow}`).value = `${month}月总收益`;
      ws.getCell(`B${summaryRow}`).value = {
        formula: `LOOKUP(2,1/(B2:B${monthLastRow}<>""),B2:B${monthLastRow})-B2-SUM(D2:D${monthLastRow})`,
      };
      const bold = { font: { bold: true } };
      ws.getCell(`A${summaryRow}`).style = bold;
      ws.getCell(`B${summaryRow}`).style = bold;
      console.log(`  ${sheetName} 总收益行已创建`);
    }

    console.log(`  ${sheetName} C列公式已迁移（${monthLastRow - 1} 行）`);
  }

  // 保存：文件被占用则报错提示关闭 Excel
  try {
    await wb.xlsx.writeFile(XLSX_PATH);
  } catch (e) {
    if (e.code === "EBUSY" || e.code === "EPERM") {
      throw new Error("收益记录.xlsx 被 Excel 占用，请先关闭 Excel 再重试");
    }
    throw e;
  }
  console.log(`\n保存成功: ${XLSX_PATH}`);
  console.log("迁移完成：D 列充值金额已添加，C 列收入公式已更新为扣除充值");
  console.log("充值时在 D 列填入金额即可，收入会自动扣除，不填则默认 0");
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
