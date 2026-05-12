"use client";

import { useSyncExternalStore } from "react";

function subscribe(onStoreChange) {
  const timer = window.setTimeout(onStoreChange, 0);
  return () => window.clearTimeout(timer);
}

function getClientSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}

export function HydrationStable({ children, fallback = null }) {
  const mounted = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  return mounted ? children : fallback;
}
