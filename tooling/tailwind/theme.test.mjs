import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const themeCss = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
const tailwindTheme = readFileSync(
	join(dirname(createRequire(import.meta.url).resolve("tailwindcss/package.json")), "theme.css"),
	"utf8",
);

function parseCustomProperties(css) {
	return Object.fromEntries(
		[...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
	);
}

function extractBlock(css, prelude) {
	const start = css.indexOf(prelude);
	assert.ok(start >= 0, `Missing ${prelude} block`);
	const open = css.indexOf("{", start);
	let depth = 0;
	for (let index = open; index < css.length; index += 1) {
		if (css[index] === "{") depth += 1;
		if (css[index] === "}") {
			depth -= 1;
			if (depth === 0) return css.slice(open + 1, index);
		}
	}
	throw new Error(`Unclosed ${prelude} block`);
}

const defaults = parseCustomProperties(tailwindTheme);
const light = parseCustomProperties(extractBlock(themeCss, ":root"));
const dark = { ...light, ...parseCustomProperties(extractBlock(themeCss, ".dark")) };

function oklchToLinearSrgb(lightness, chroma, hue) {
	const angle = (hue * Math.PI) / 180;
	const a = chroma * Math.cos(angle);
	const b = chroma * Math.sin(angle);
	const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

function luminanceFromLinearSrgb(channels) {
	const [red, green, blue] = channels.map((channel) => Math.max(0, channel));
	return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function parseHex(value) {
	const hex = value.replace("#", "");
	const normalized = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
	assert.equal(normalized.length, 6, `Unsupported color ${value}`);
	const channels = [0, 2, 4].map((index) => {
		const channel = Number.parseInt(normalized.slice(index, index + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function parseColor(value) {
	if (value.startsWith("#") || value === "white" || value === "black") {
		return parseHex(value === "white" ? "#fff" : value === "black" ? "#000" : value);
	}
	const match = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i);
	assert.ok(match, `Unsupported color ${value}`);
	const lightness = match[2] === "%" ? Number(match[1]) / 100 : Number(match[1]);
	return luminanceFromLinearSrgb(oklchToLinearSrgb(lightness, Number(match[3]), Number(match[4])));
}

function resolveValue(value, vars, seen = new Set()) {
	const reference = value.match(/^var\(--([\w-]+)\)$/);
	if (!reference) return value;
	const name = reference[1];
	assert.ok(!seen.has(name), `Circular token ${name}`);
	const next = vars[name] ?? defaults[name];
	assert.ok(next, `Missing token ${name}`);
	return resolveValue(next, vars, new Set(seen).add(name));
}

function luminance(vars, name) {
	return parseColor(resolveValue(vars[name], vars));
}

function checkContrast(vars, foreground, background, minimum) {
	const values = [luminance(vars, foreground), luminance(vars, background)].sort((a, b) => a - b);
	const ratio = (values[1] + 0.05) / (values[0] + 0.05);
	assert.ok(
		ratio >= minimum,
		`${foreground} on ${background}: ${ratio.toFixed(2)}:1, expected ${minimum}:1`,
	);
}

function checkReadingAndControls(vars) {
	for (const background of ["background", "card"]) {
		checkContrast(vars, "foreground", background, 7);
		checkContrast(vars, "muted-foreground", background, 7);
		checkContrast(vars, "input", background, 3);
	}
	checkContrast(vars, "primary-foreground", "primary", 7);
	checkContrast(vars, "touch-foreground", "touch", 7);
}

await test("light theme reading text and accents exceed enhanced contrast", () => {
	checkReadingAndControls(light);
});

await test("dark theme reading text and accents exceed enhanced contrast", () => {
	checkReadingAndControls(dark);
});
