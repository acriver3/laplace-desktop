export type LogoGlowColors = {
	c1: string;
	c2: string;
	c3: string;
};

const cache = new Map<string, LogoGlowColors>();

export function providerArtPath(remoteUrl: string): string {
	const match = remoteUrl.match(/\/logo\/third-party\/(.+)$/);
	return `/provider-art/${match ? match[1] : (remoteUrl.split("/").pop() ?? "icon")}`;
}

export function colorsFromName(name: string): LogoGlowColors {
	let hash = 0;
	for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	const hue = hash % 360;
	return {
		c1: `oklch(0.55 0.14 ${hue})`,
		c2: `oklch(0.62 0.12 ${(hue + 38) % 360})`,
		c3: `oklch(0.48 0.1 ${(hue + 196) % 360})`,
	};
}

function hueFromRgb(red: number, green: number, blue: number): number {
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	const delta = max - min;
	if (delta < 1) return 0;
	let hue = 0;
	if (max === red) hue = ((green - blue) / delta) % 6;
	else if (max === green) hue = (blue - red) / delta + 2;
	else hue = (red - green) / delta + 4;
	hue *= 60;
	return hue < 0 ? hue + 360 : hue;
}

export function sampleLogoColors(image: {
	width: number;
	height: number;
	data: ArrayLike<number>;
}): LogoGlowColors | null {
	const buckets = new Map<number, { r: number; g: number; b: number; weight: number }>();
	for (let index = 0; index < image.data.length; index += 4) {
		const alpha = image.data[index + 3] ?? 0;
		if (alpha < 40) continue;
		const red = image.data[index] ?? 0;
		const green = image.data[index + 1] ?? 0;
		const blue = image.data[index + 2] ?? 0;
		const max = Math.max(red, green, blue);
		const min = Math.min(red, green, blue);
		if (max < 28 || min > 232) continue;
		if (max === 0 || (max - min) / max < 0.12) continue;
		const bucket = (Math.round(hueFromRgb(red, green, blue) / 20) * 20) % 360;
		const current = buckets.get(bucket) ?? { r: 0, g: 0, b: 0, weight: 0 };
		const weight = alpha / 255;
		current.r += red * weight;
		current.g += green * weight;
		current.b += blue * weight;
		current.weight += weight;
		buckets.set(bucket, current);
	}
	const ranked = [...buckets.values()]
		.sort((left, right) => right.weight - left.weight)
		.slice(0, 3);
	if (!ranked.length) return null;
	const colors = ranked.map((bucket) => {
		const red = Math.round(bucket.r / bucket.weight);
		const green = Math.round(bucket.g / bucket.weight);
		const blue = Math.round(bucket.b / bucket.weight);
		return `rgb(${red} ${green} ${blue})`;
	});
	return {
		c1: colors[0] ?? "var(--touch)",
		c2: colors[1] ?? colors[0] ?? "var(--touch)",
		c3: colors[2] ?? colors[1] ?? colors[0] ?? "var(--touch)",
	};
}

export async function loadLogoColors(
	src: string,
	cacheKey: string,
): Promise<LogoGlowColors | null> {
	const cached = cache.get(cacheKey);
	if (cached) return cached;
	if (typeof Image === "undefined" || typeof document === "undefined") return null;
	try {
		const image = new Image();
		image.decoding = "async";
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("logo"));
			image.src = src;
		});
		const size = 32;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return null;
		context.drawImage(image, 0, 0, size, size);
		const sampled = sampleLogoColors(context.getImageData(0, 0, size, size));
		if (sampled) cache.set(cacheKey, sampled);
		return sampled;
	} catch {
		return null;
	}
}
