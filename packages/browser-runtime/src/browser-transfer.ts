import { createHash } from "node:crypto";

export const browserJsonLimit = 1024 * 1024;
export const browserTransferLimit = 32 * 1024 * 1024;
export const browserChunkSize = 192 * 1024;
export type TransferDescription = { bytes: number; sha256: string; chunks: number };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function transferLimit(value = browserJsonLimit) {
	if (!Number.isSafeInteger(value) || value < 1 || value > browserTransferLimit)
		throw Error("Invalid browser transfer limit.");
	return value;
}
export function describeTransfer(bytes: Buffer): TransferDescription {
	return {
		bytes: bytes.length,
		sha256: digest(bytes),
		chunks: Math.ceil(bytes.length / browserChunkSize),
	};
}
/** One in-order response bound to one delivered invocation. Never a reusable download URL. */
export class BrowserResultTransfer {
	private parts: Buffer[] = [];
	private size = 0;
	constructor(
		readonly description: TransferDescription,
		limit: number,
	) {
		if (
			!Number.isSafeInteger(description.bytes) ||
			description.bytes < 1 ||
			description.bytes > transferLimit(limit) ||
			!/^([a-f0-9]{64})$/.test(description.sha256) ||
			description.chunks !== Math.ceil(description.bytes / browserChunkSize)
		)
			throw Error("Invalid browser transfer.");
	}
	append(index: number, base64: string) {
		if (
			index !== this.parts.length ||
			this.parts.length >= this.description.chunks ||
			base64.length > Math.ceil(browserChunkSize / 3) * 4 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
		)
			throw Error("Invalid browser chunk.");
		const bytes = Buffer.from(base64, "base64");
		const expected = Math.min(browserChunkSize, this.description.bytes - this.size);
		if (bytes.length !== expected || bytes.toString("base64") !== base64)
			throw Error("Invalid browser chunk size.");
		this.parts.push(bytes);
		this.size += bytes.length;
	}
	finish(): unknown {
		if (this.size !== this.description.bytes || this.parts.length !== this.description.chunks)
			throw Error("Incomplete browser transfer.");
		const bytes = Buffer.concat(this.parts);
		if (digest(bytes) !== this.description.sha256)
			throw Error("Browser transfer checksum mismatch.");
		return JSON.parse(bytes.toString("utf8"));
	}
}
