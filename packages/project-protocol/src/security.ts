const encoder = new TextEncoder();

export async function sign(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verify(secret: string, value: string, signature: string): Promise<boolean> {
	if (!/^[0-9a-f]{64}$/.test(signature)) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		Uint8Array.from(signature.match(/../g)!, (b) => parseInt(b, 16)),
		encoder.encode(value),
	);
}
