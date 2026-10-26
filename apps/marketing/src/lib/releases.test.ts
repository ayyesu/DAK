import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease } from "./releases";

const STABLE_RELEASE = {
  tag_name: "v0.3.0",
  html_url: "https://github.com/ayyesu/dak-releases/releases/tag/v0.3.0",
  published_at: "2026-10-26T22:23:45Z",
  assets: [
    { name: "DAK-0.3.0-arm64.dmg", browser_download_url: "https://example.com/dmg" },
    { name: "DAK-0.3.0-x64.exe", browser_download_url: "https://example.com/exe" },
  ],
};

class StorageStub {
  private readonly entries = new Map<string, string>();
  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.entries.set(key, value);
  }
}

let storage: StorageStub;

beforeEach(() => {
  storage = new StorageStub();
  vi.stubGlobal("sessionStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs?.();
  vi.restoreAllMocks();
});

describe("fetchLatestRelease", () => {
  it("serves a fresh cache entry without fetching", async () => {
    storage.setItem(
      "dak-stable-release",
      JSON.stringify({ fetchedAt: Date.now(), release: STABLE_RELEASE }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await fetchLatestRelease("stable")).toEqual(STABLE_RELEASE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores a legacy cache entry stored as a bare release", async () => {
    storage.setItem("dak-stable-release", JSON.stringify(STABLE_RELEASE));
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ tag_name: "v0.4.0", assets: [] }), { status: 200 }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const release = await fetchLatestRelease("stable");
    expect(release.tag_name).toBe("v0.4.0");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("refetches once the cache is older than its TTL", async () => {
    vi.useFakeTimers();
    storage.setItem(
      "dak-stable-release",
      JSON.stringify({ fetchedAt: Date.now(), release: STABLE_RELEASE }),
    );
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ tag_name: "v0.4.0", assets: [] }), { status: 200 }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    vi.advanceTimersByTime(11 * 60 * 1000);
    const release = await fetchLatestRelease("stable");
    expect(release.tag_name).toBe("v0.4.0");
    expect(fetchSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("caches nothing when GitHub answers with an error payload", async () => {
    const fetchSpy = vi
      .fn()
      .mockReturnValueOnce(
        Promise.resolve(
          new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 }),
        ),
      )
      .mockReturnValueOnce(
        Promise.resolve(new Response(JSON.stringify(STABLE_RELEASE), { status: 200 })),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchLatestRelease("stable")).rejects.toThrow();
    expect(storage.getItem("dak-stable-release")).toBeNull();

    expect(await fetchLatestRelease("stable")).toEqual(STABLE_RELEASE);
    expect(storage.getItem("dak-stable-release")).not.toBeNull();
  });

  it("caches a fresh fetch so later calls skip the network", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(STABLE_RELEASE), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    expect(await fetchLatestRelease("stable")).toEqual(STABLE_RELEASE);
    expect(await fetchLatestRelease("stable")).toEqual(STABLE_RELEASE);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
