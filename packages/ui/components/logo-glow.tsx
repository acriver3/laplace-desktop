"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "../lib";
import { colorsFromName, loadLogoColors, type LogoGlowColors } from "../lib/logo-glow";

export function LogoGlow({
	src,
	cacheKey,
	name,
	enabled = true,
	className,
	children,
}: {
	src?: string;
	cacheKey: string;
	name: string;
	enabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const [colors, setColors] = useState<LogoGlowColors>(() => colorsFromName(name));

	useEffect(() => {
		const fallback = colorsFromName(name);
		if (!enabled) return;
		if (!src) {
			setColors(fallback);
			return;
		}
		let cancelled = false;
		// Sampling decodes the logo again; it waits for idle time so it never competes with first content.
		const sample = () =>
			void loadLogoColors(src, cacheKey).then((next) => {
				if (!cancelled) setColors(next ?? fallback);
			});
		if (typeof requestIdleCallback !== "function") {
			const timer = setTimeout(sample, 200);
			return () => {
				cancelled = true;
				clearTimeout(timer);
			};
		}
		const handle = requestIdleCallback(sample, { timeout: 2000 });
		return () => {
			cancelled = true;
			cancelIdleCallback(handle);
		};
	}, [cacheKey, enabled, name, src]);

	if (!enabled) return children;

	return (
		<span
			className={cn("logo-glow", className)}
			style={
				{
					"--logo-c1": colors.c1,
					"--logo-c2": colors.c2,
					"--logo-c3": colors.c3,
				} as CSSProperties
			}
		>
			<span className="logo-glow-face">{children}</span>
		</span>
	);
}
