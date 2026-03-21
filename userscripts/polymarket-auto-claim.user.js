// ==UserScript==
// @name         Polymarket Portfolio Auto Claim
// @namespace    https://polymarket.com/
// @version      0.1.0
// @description  Auto-click claim/redeem actions on the Polymarket portfolio page at a configurable interval.
// @author       Codex
// @match        https://polymarket.com/portfolio*
// @match        https://polymarket.com/*/portfolio*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "pm-auto-claim-settings-v1";
  const DEFAULT_SETTINGS = {
    enabled: false,
    intervalMs: 30000,
    autoRefresh: false,
    refreshMs: 180000,
    dryRun: false,
  };

  const CLAIM_LABELS = ["claim", "redeem", "领取", "主张", "兑换"];
  const CONFIRM_LABELS = ["confirm", "continue", "领取", "主张", "兑换", "确认", "继续"];
  const EXCLUDE_LABELS = ["sell", "卖出", "buy", "买入", "购买"];
  const CLICK_COOLDOWN_MS = 15000;

  let settings = loadSettings();
  let lastActionAt = 0;
  let lastRefreshAt = 0;
  let lastStatus = "idle";
  let intervalHandle = null;

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { ...DEFAULT_SETTINGS };
      }
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (error) {
      console.warn("[pm-auto-claim] Failed to load settings", error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function extractText(node) {
    if (!node) {
      return "";
    }
    const aria = node.getAttribute?.("aria-label");
    const title = node.getAttribute?.("title");
    const value = node.getAttribute?.("value");
    return normalizeText([node.textContent, aria, title, value].filter(Boolean).join(" "));
  }

  function isVisible(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !node.hasAttribute("disabled") &&
      node.getAttribute("aria-disabled") !== "true"
    );
  }

  function containsAny(text, candidates) {
    return candidates.some((candidate) => text.includes(candidate));
  }

  function isClaimAction(node) {
    const text = extractText(node);
    if (!text) {
      return false;
    }
    if (containsAny(text, EXCLUDE_LABELS)) {
      return false;
    }
    return containsAny(text, CLAIM_LABELS);
  }

  function isConfirmAction(node) {
    const text = extractText(node);
    if (!text) {
      return false;
    }
    if (containsAny(text, EXCLUDE_LABELS)) {
      return false;
    }
    return containsAny(text, CONFIRM_LABELS);
  }

  function getCandidates() {
    const nodes = Array.from(
      document.querySelectorAll("button, a[role='button'], [role='button']")
    );
    return nodes.filter((node) => isVisible(node));
  }

  function findClaimButtons() {
    return getCandidates().filter((node) => isClaimAction(node));
  }

  function findConfirmButtons() {
    return getCandidates().filter((node) => {
      if (!isConfirmAction(node)) {
        return false;
      }
      const dialog = node.closest("[role='dialog'], [data-radix-portal], [data-state='open']");
      return Boolean(dialog);
    });
  }

  function chooseBestButton(buttons) {
    const scored = buttons
      .map((button) => {
        const text = extractText(button);
        let score = 0;
        if (text === "领取" || text === "claim") {
          score += 100;
        }
        if (text === "主张" || text === "redeem") {
          score += 95;
        }
        if (text === "兑换") {
          score += 90;
        }
        const dialog = button.closest("[role='dialog']");
        if (dialog) {
          score += 20;
        }
        const rect = button.getBoundingClientRect();
        score += Math.max(0, 1000 - rect.top);
        return { button, text, score };
      })
      .sort((left, right) => right.score - left.score);

    return scored[0]?.button ?? null;
  }

  function clickNode(node, reason) {
    if (!node) {
      return false;
    }
    const text = extractText(node) || "<empty>";
    lastActionAt = Date.now();
    lastStatus = `${settings.dryRun ? "dry-run" : "clicked"} ${reason}: ${text}`;
    updatePanel();
    console.log(`[pm-auto-claim] ${lastStatus}`);
    if (!settings.dryRun) {
      node.click();
    }
    return true;
  }

  function tick() {
    if (!settings.enabled) {
      return;
    }
    const now = Date.now();
    if (now - lastActionAt < CLICK_COOLDOWN_MS) {
      return;
    }

    const confirmButton = chooseBestButton(findConfirmButtons());
    if (confirmButton) {
      clickNode(confirmButton, "confirm");
      return;
    }

    const claimButton = chooseBestButton(findClaimButtons());
    if (claimButton) {
      clickNode(claimButton, "claim");
      return;
    }

    if (settings.autoRefresh && now - lastRefreshAt >= settings.refreshMs) {
      lastRefreshAt = now;
      lastStatus = settings.dryRun ? "dry-run refresh" : "refresh";
      updatePanel();
      console.log(`[pm-auto-claim] ${lastStatus}`);
      if (!settings.dryRun) {
        window.location.reload();
      }
      return;
    }

    lastStatus = "waiting";
    updatePanel();
  }

  function schedule() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
    }
    intervalHandle = window.setInterval(tick, Math.max(3000, Number(settings.intervalMs) || 30000));
  }

  function createToggleRow(labelText, checked, onChange) {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "12px";
    row.style.fontSize = "12px";
    row.style.color = "#1f2937";

    const text = document.createElement("span");
    text.textContent = labelText;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));

    row.append(text, input);
    return row;
  }

  function createNumberRow(labelText, value, onChange) {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.flexDirection = "column";
    row.style.gap = "6px";
    row.style.fontSize = "12px";
    row.style.color = "#1f2937";

    const text = document.createElement("span");
    text.textContent = labelText;

    const input = document.createElement("input");
    input.type = "number";
    input.min = "3";
    input.step = "1";
    input.value = String(value);
    input.style.border = "1px solid rgba(15, 23, 42, 0.12)";
    input.style.borderRadius = "10px";
    input.style.padding = "8px 10px";
    input.style.fontSize = "12px";
    input.addEventListener("change", () => onChange(Number(input.value) || value));

    row.append(text, input);
    return row;
  }

  let panelStatusNode = null;

  function updatePanel() {
    if (!panelStatusNode) {
      return;
    }
    panelStatusNode.textContent = [
      settings.enabled ? "running" : "stopped",
      `interval ${(settings.intervalMs / 1000).toFixed(0)}s`,
      lastStatus,
    ].join(" | ");
  }

  function createPanel() {
    if (document.getElementById("pm-auto-claim-panel")) {
      return;
    }

    const panel = document.createElement("aside");
    panel.id = "pm-auto-claim-panel";
    panel.style.position = "fixed";
    panel.style.right = "18px";
    panel.style.bottom = "18px";
    panel.style.zIndex = "999999";
    panel.style.width = "260px";
    panel.style.padding = "14px";
    panel.style.borderRadius = "18px";
    panel.style.background = "rgba(255,255,255,0.96)";
    panel.style.border = "1px solid rgba(15, 23, 42, 0.08)";
    panel.style.boxShadow = "0 18px 48px rgba(15, 23, 42, 0.16)";
    panel.style.backdropFilter = "blur(12px)";
    panel.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    const title = document.createElement("div");
    title.textContent = "Polymarket Auto Claim";
    title.style.fontSize = "14px";
    title.style.fontWeight = "700";
    title.style.color = "#111827";

    panelStatusNode = document.createElement("div");
    panelStatusNode.style.marginTop = "6px";
    panelStatusNode.style.fontSize = "11px";
    panelStatusNode.style.lineHeight = "1.4";
    panelStatusNode.style.color = "#6b7280";

    const body = document.createElement("div");
    body.style.display = "grid";
    body.style.gap = "10px";
    body.style.marginTop = "12px";

    body.append(
      createToggleRow("Enable auto click", settings.enabled, (checked) => {
        settings.enabled = checked;
        saveSettings();
        updatePanel();
      }),
      createToggleRow("Dry run", settings.dryRun, (checked) => {
        settings.dryRun = checked;
        saveSettings();
        updatePanel();
      }),
      createToggleRow("Auto refresh", settings.autoRefresh, (checked) => {
        settings.autoRefresh = checked;
        saveSettings();
        updatePanel();
      }),
      createNumberRow("Scan interval (seconds)", Math.round(settings.intervalMs / 1000), (seconds) => {
        settings.intervalMs = Math.max(3, seconds) * 1000;
        saveSettings();
        schedule();
        updatePanel();
      }),
      createNumberRow("Refresh interval (seconds)", Math.round(settings.refreshMs / 1000), (seconds) => {
        settings.refreshMs = Math.max(10, seconds) * 1000;
        saveSettings();
        updatePanel();
      }),
    );

    const footer = document.createElement("div");
    footer.style.marginTop = "12px";
    footer.style.display = "flex";
    footer.style.gap = "8px";

    const scanButton = document.createElement("button");
    scanButton.textContent = "Run now";
    scanButton.type = "button";
    scanButton.style.flex = "1";
    scanButton.style.border = "none";
    scanButton.style.borderRadius = "12px";
    scanButton.style.padding = "10px 12px";
    scanButton.style.background = "#2563eb";
    scanButton.style.color = "#fff";
    scanButton.style.fontSize = "12px";
    scanButton.style.fontWeight = "700";
    scanButton.style.cursor = "pointer";
    scanButton.addEventListener("click", tick);

    const stopButton = document.createElement("button");
    stopButton.textContent = "Stop";
    stopButton.type = "button";
    stopButton.style.flex = "1";
    stopButton.style.border = "1px solid rgba(15, 23, 42, 0.12)";
    stopButton.style.borderRadius = "12px";
    stopButton.style.padding = "10px 12px";
    stopButton.style.background = "#fff";
    stopButton.style.color = "#111827";
    stopButton.style.fontSize = "12px";
    stopButton.style.fontWeight = "700";
    stopButton.style.cursor = "pointer";
    stopButton.addEventListener("click", () => {
      settings.enabled = false;
      saveSettings();
      updatePanel();
    });

    footer.append(scanButton, stopButton);
    panel.append(title, panelStatusNode, body, footer);
    document.body.append(panel);
    updatePanel();
  }

  function boot() {
    createPanel();
    schedule();
    setTimeout(tick, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
