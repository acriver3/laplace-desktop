"use client";

import { MonitorCogIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "../lib";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

export const colorModes = ["system", "light", "dark"] as const;

export type ColorMode = (typeof colorModes)[number];

export type ColorModeToggleProps = {
	labels: Record<ColorMode, string>;
	modes?: readonly ColorMode[];
	defaultMode?: ColorMode;
	className?: string;
};

const MODE_ICONS = {
	system: MonitorCogIcon,
	light: SunIcon,
	dark: MoonIcon,
} as const;

const DEFAULT_MODES: readonly ColorMode[] = ["light", "dark"];

export function ColorModeToggle({
	labels,
	modes = DEFAULT_MODES,
	defaultMode = "light",
	className,
}: ColorModeToggleProps) {
	const { resolvedTheme, setTheme, theme } = useTheme();
	const [mounted, setMounted] = useState(false);
	const [value, setValue] = useState<string>(defaultMode);

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (!mounted) {
			return;
		}

		const includesSystem = modes.includes("system");
		const resolved = !includesSystem && theme === "system" ? resolvedTheme : theme;

		if (resolved) {
			setValue(resolved);
		}
	}, [theme, resolvedTheme, mounted, modes]);

	const displayValue = mounted ? value : defaultMode;
	const activeIndex = Math.max(
		0,
		modes.findIndex((mode) => mode === displayValue),
	);

	const handleClick = (optionValue: ColorMode) => {
		setTheme(optionValue);
		setValue(optionValue);
	};

	return (
		<TooltipProvider delay={0}>
			<div
				className={cn(
					"gap-0 p-0.5 relative inline-flex items-center rounded-full bg-muted",
					className,
				)}
				data-test="color-mode-toggle"
			>
				<div
					className="left-0.5 top-0.5 h-7 w-7 ease-in-out absolute rounded-full border border-border bg-background transition-transform duration-200"
					style={{
						transform: `translateX(${activeIndex * 100}%)`,
					}}
					aria-hidden="true"
				/>

				{modes.map((mode) => {
					const Icon = MODE_ICONS[mode];
					const isActive = mode === displayValue;
					const label = labels[mode];

					return (
						<Tooltip key={mode}>
							<TooltipTrigger
								render={(props) => (
									<button
										{...props}
										type="button"
										onClick={(event) => {
											props.onClick?.(event);
											handleClick(mode);
										}}
										className={cn(
											props.className,
											"h-7 w-7 relative z-10 flex items-center justify-center rounded-full transition-colors",
											"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
											isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
										)}
										data-test={`color-mode-toggle-item-${mode}`}
										aria-label={label}
										aria-pressed={isActive}
									>
										<Icon className="size-3.5" />
									</button>
								)}
							/>
							<TooltipContent>{label}</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
		</TooltipProvider>
	);
}
