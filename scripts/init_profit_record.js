// 初始化收益记录.xlsx：创建 6月-9月 四个 sheet，预填日期，设置收入公式
// 用法：node scripts/init_profit_record.js
const ExcelJS = require("exceljs");
const path = require("path");

const XLSX_PATH = path.join(__dirname, "..", "收益记录.xlsx");

// 各月份及天数
const MONTHS = [
  { month: 6, days: 30, startDay: 21 }, // 6月从 21 号开始
  { month: 7, days: 31, startDay: 1 },
  { month: 8, days: 31, startDay: 1 },
  { month: 9, days: 30, startDay: 1 },
];

async function main() {
  const wb = new ExcelJS.Workbook();

  // 上个月最后一天的金额引用（用于跨月收入计算）
  // 格式：{ sheetName, row } 或 null
  let prevMonthLastDayRef = null;

  for (const { month, days, startDay } of MONTHS) {
    const sheetName = `${month}月`;
    const ws = wb.addWorksheet(sheetName);

    // 表头
    ws.getCell("A1").value = "日期";
    ws.getCell("B1").value = "金额";
    ws.getCell("C1").value = "收入";
    ws.getCell("D1").value = "充值金额";
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { horizontal: "center" };

    // 列宽
    ws.getColumn(1).width = 14;
    ws.getColumn(2).width = 12;
    ws.getColumn(3).width = 12;
    ws.getColumn(4).width = 12;

    // 填入日期行
    let rowIdx = 2;
    for (let day = startDay; day <= days; day++) {
      const dateCell = ws.getCell(`A${rowIdx}`);
      // Excel 日期：2026-{month}-{day}（用 UTC 避免时区偏移）
      dateCell.value = new Date(Date.UTC(2026, month - 1, day));
      dateCell.numFmt = "yyyy/m/d";

      // 金额列默认留空（后续填入）
      // 充值金额列默认留空（用户手动填入）
      // 收入列：用公式，扣除当天充值金额（D列为空时视为0）
      if (rowIdx === 2) {
        // 每月第一天
        if (prevMonthLastDayRef) {
          // 跨月：收入 = 当天金额 - 上月最后一天金额 - 当天充值
          ws.getCell(`C${rowIdx}`).value = {
            formula: `B${rowIdx}-${prevMonthLastDayRef.sheetName}!B${prevMonthLastDayRef.row}-IF(D${rowIdx}="",0,D${rowIdx})`,
          };
        } else {
          // 6-21 是起始日，收入 = 0
          ws.getCell(`C${rowIdx}`).value = 0;
        }
      } else {
        // 同月内：收入 = 当天金额 - 前一天金额 - 当天充值
        ws.getCell(`C${rowIdx}`).value = { formula: `B${rowIdx}-B${rowIdx - 1}-IF(D${rowIdx}="",0,D${rowIdx})` };
      }

      rowIdx++;
    }

    // 记录本月最后一天的引用（供下月跨月计算）
    prevMonthLastDayRef = { sheetName, row: rowIdx - 1 };

    console.log(`创建 sheet: ${sheetName}, ${rowIdx - 2} 行数据`);
  }

  // 填入 6-21 的初始数据：金额 21.43，收入 0
  const juneSheet = wb.getWorksheet("6月");
  juneSheet.getCell("B2").value = 21.43;
  juneSheet.getCell("C2").value = 0;

  // 保存（如果原文件被 Excel 占用，写入 .new.xlsx）
  let savePath = XLSX_PATH;
  try {
    await wb.xlsx.writeFile(savePath);
  } catch (e) {
    if (e.code === "EBUSY" || e.code === "EPERM") {
      savePath = XLSX_PATH.replace(".xlsx", ".new.xlsx");
      console.log(`原文件被占用，写入: ${savePath}`);
      await wb.xlsx.writeFile(savePath);
      console.log(`请关闭 Excel 后将 ${savePath} 重命名为 ${XLSX_PATH}`);
    } else {
      throw e;
    }
  }
  console.log(`\n保存成功: ${savePath}`);
  console.log("6-21 初始数据: 金额=21.43, 收入=0");
  console.log("其他日期金额留空，收入公式已设置");
  console.log("跨月引用: 7-1 收入 = 7-1 金额 - 6月!6-30 金额");
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
