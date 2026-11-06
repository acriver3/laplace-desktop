import { describe, expect, it, vi } from "vitest";

import { retryingDownload } from "../src/connector-releases";

const signal = new AbortController().signal;
const respond = (status: number, body = "bytes") => new Response(status === 204 ? null : body, { status });

describe("retryingDownload", () => {
	it("retries a transient CDN error with a cache-busting URL, then succeeds", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(respond(501, "Not Implemented"))
			.mockResolvedValueOnce(respond(200));
		const wait = vi.fn(async () => {});
		const bytes = await retryingDownload("https://cdn.test/file.js", 100, signal, fetcher as any, {
			wait,
		});
		expect(bytes.toString()).toBe("bytes");
		expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
			"https://cdn.test/file.js",
			"https://cdn.test/file.js?attempt=1",
		]);
		expect(wait).toHaveBeenCalledTimes(1);
	});
	it("retries throttling and dropped connections", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(respond(429))
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(respond(200));
		const bytes = await retryingDownload("https://cdn.test/a", 100, signal, fetcher as any, {
			wait: async () => {},
		});
		expect(bytes.toString()).toBe("bytes");
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
	it("does not retry a missing file", async () => {
		const fetcher = vi.fn().mockResolvedValue(respond(404));
		await expect(
			retryingDownload("https://cdn.test/a", 100, signal, fetcher as any, { wait: async () => {} }),
		).rejects.toThrow("Verified update download is unavailable.");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("gives up after the attempt limit", async () => {
		const fetcher = vi.fn().mockImplementation(async () => respond(503));
		await expect(
			retryingDownload("https://cdn.test/a", 100, signal, fetcher as any, {
				attempts: 3,
				wait: async () => {},
			}),
		).rejects.toThrow("Verified update download is unavailable.");
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
	it("does not retry after cancellation", async () => {
		const controller = new AbortController();
		const fetcher = vi.fn().mockImplementation(async () => {
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		});
		await expect(
			retryingDownload("https://cdn.test/a", 100, controller.signal, fetcher as any, {
				wait: async () => {},
			}),
		).rejects.toThrow();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
