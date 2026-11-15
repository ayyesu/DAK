import { afterEach, expect, it, vi } from "vite-plus/test";

const loadTrackingFor = async (platform: string) => {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform, userAgent: "" });
  return (await import("./theme")).trackingFor;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("applies the SF-measured tightening only where SF is the font", async () => {
  expect((await loadTrackingFor("MacIntel"))(17)).toBeLessThan(0);
  // Inter sets its own spacing from the optical-size axis; tightening it again would crowd it.
  expect((await loadTrackingFor("Win32"))(17)).toBe(0);
  expect((await loadTrackingFor("Linux x86_64"))(34)).toBe(0);
});
