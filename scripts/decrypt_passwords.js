#!/usr/bin/env node
// 网站密码.xlsx 解密工具（安全版）
// 算法: XOR 循环
// 密钥来源优先级: 环境变量 DECRYPT_KEY > .env.order 的 key= > --key 参数
//
// 用法:
//   node scripts/decrypt_passwords.js             # 解密并显示统计（不显示密码内容）
//   node scripts/decrypt_passwords.js --write    # 解密结果写入 xlsx 的 F 列
//   node scripts/decrypt_passwords.js --show      # 显示前 5 条解密内容（谨慎使用）
//
// 安全说明:
//   - 密钥从不写入代码或日志，只从 .env.order 或环境变量读取
//   - 默认不输出任何密码内容到控制台，只显示成功条数
//   - 解密结果只写入 xlsx F 列（本地文件）

const ExcelJS = require("exceljs");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const XLSX_PATH = "D:/cursor/ploymarket/网站密码.xlsx";
const ENV_PATH = "D:/cursor/ploymarket/.env.order";

// 从 .env.order 读取 key=
function loadKeyFromEnv() {
  if (!fs.existsSync(ENV_PATH)) return null;
  const content = fs.readFileSync(ENV_PATH, "utf8");
  const match = content.match(/^key\s*=\s*"([^"]*)"\s*$/m) || content.match(/^key\s*=\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

// XOR 循环解密
function xorDecrypt(cipherBuf, keyBuf) {
  if (keyBuf.length === 0) return null;
  const out = Buffer.alloc(cipherBuf.length);
  for (let i = 0; i < cipherBuf.length; i++) {
    out[i] = cipherBuf[i] ^ keyBuf[i % keyBuf.length];
  }
  return out;
}

// 可打印 ASCII 比例
function printableRatio(buf) {
  if (!buf || buf.length === 0) return 0;
  let p = 0;
  for (const b of buf) {
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d) p++;
  }
  return p / buf.length;
}

function safeText(buf) {
  if (!buf) return "(null)";
  let s = "";
  for (const b of buf) {
    if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
    else s += ".";
  }
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  const writeMode = args.includes("--write");
  const showMode = args.includes("--show");

  // 解析密钥
  let keyStr = process.env.DECRYPT_KEY;
  let keySource = "环境变量 DECRYPT_KEY";
  if (!keyStr) {
    keyStr = loadKeyFromEnv();
    keySource = ".env.order 中的 key=";
  }
  if (!keyStr) {
    // 交互式输入
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    keyStr = await new Promise((resolve) => {
      rl.question("请输入解密密钥: ", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
    keySource = "交互式输入";
  }

  if (!keyStr) {
    console.error("未提供密钥");
    process.exit(1);
  }

  const keyBuf = Buffer.from(keyStr, "utf8");
  console.log(`=== 网站密码.xlsx 解密工具 ===`);
  console.log(`密钥来源: ${keySource} (${keyBuf.length} 字节)`);
  console.log(`算法: XOR 循环`);
  console.log(`密钥内容: 不显示(安全)`);
  console.log("");

  // 加载 xlsx
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  const ws = wb.getWorksheet("存储");
  if (!ws) {
    console.error("Sheet '存储' 不存在");
    process.exit(1);
  }

  const samples = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const name = String(ws.getCell(r, 1).value || "");
    const user = String(ws.getCell(r, 3).value || "");
    const enc = ws.getCell(r, 5).value;
    if (!enc) continue;
    const buf = Buffer.from(String(enc), "base64");
    samples.push({ r, name, user, buf });
  }

  console.log(`加载了 ${samples.length} 条加密记录`);

  // 解密所有样本
  let successCount = 0;
  let failCount = 0;
  const decrypted = [];
  for (const s of samples) {
    const out = xorDecrypt(s.buf, keyBuf);
    const ratio = printableRatio(out);
    if (ratio >= 0.9) {
      successCount++;
    } else {
      failCount++;
    }
    decrypted.push({ ...s, out, ratio });
  }

  console.log("");
  console.log(`=== 解密统计 ===`);
  console.log(`成功: ${successCount} 条 (可读率 >= 90%)`);
  console.log(`失败: ${failCount} 条`);

  if (showMode) {
    console.log("");
    console.log(`=== 前 5 条解密内容 (--show) ===`);
    for (let i = 0; i < Math.min(5, decrypted.length); i++) {
      const d = decrypted[i];
      console.log(`R${d.r} ${d.name}/${d.user} -> ${safeText(d.out)}`);
    }
  }

  if (writeMode) {
    console.log("");
    console.log(`=== 写入 xlsx F 列 ===`);
    for (const d of decrypted) {
      ws.getCell(d.r, 6).value = safeText(d.out);
    }
    await wb.xlsx.writeFile(XLSX_PATH);
    console.log(`已写入 ${decrypted.length} 条解密结果到 ${XLSX_PATH}`);
  } else {
    console.log("");
    console.log(`（使用 --write 参数将结果写入 xlsx F 列）`);
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
