import React from "react";

import { logoPaths, logoViewBox } from "../brand/logo.generated";
import { cn } from "../lib";

/** The Laplace brand mark: two overlapping squares, rising together. */
export function LogoMark({
	className,
	label = "Laplace",
	...props
}: React.SVGProps<SVGSVGElement> & { label?: string }) {
	return (
		<svg
			className={cn("size-7 shrink-0", className)}
			viewBox={logoViewBox}
			role="img"
			aria-label={label}
			{...props}
		>
			{logoPaths.map((path, index) => (
				<path key={index} {...path} />
			))}
		</svg>
	);
}

export function Logo({
	withLabel = true,
	className,
	label = "Laplace",
}: {
	className?: string;
	withLabel?: boolean;
	label?: string;
}) {
	return (
		<span className={cn("gap-2.5 flex items-center leading-none text-foreground", className)}>
			<LogoMark aria-hidden={withLabel} label={label} />
			{withLabel && (
				<span className="font-semibold tracking-tight max-md:sr-only md:block text-[1.05rem]">
					{label}
				</span>
			)}
		</span>
	);
}
