"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib";
import { Button, type ButtonProps } from "./button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu";

/** Two independent actions with one visual boundary. Menu content owns selection behavior. */
export function SplitButton({
	children,
	menu,
	menuLabel,
	menuDisplay,
	className,
	disabled,
	loading,
	variant = "outline",
	size = "sm",
	...props
}: Omit<ButtonProps, "render"> & { menu?: ReactNode; menuLabel: string; menuDisplay?: ReactNode }) {
	return (
		<div className={cn("min-w-0 inline-flex items-stretch", className)}>
			<Button
				{...props}
				data-split-action={menu ? "primary" : undefined}
				type={props.type ?? "button"}
				variant={variant}
				size={size}
				disabled={disabled}
				loading={loading}
				className={cn("min-w-0", menu && "rounded-r-none")}
			>
				{children}
			</Button>
			{menu && (
				<DropdownMenu>
					<DropdownMenuTrigger
						data-split-action="menu"
						render={<Button type="button" variant={variant} size={size} />}
						className="gap-2 px-3 [&>svg]:m-0 h-auto shrink-0 rounded-l-none border-l border-l-current/25"
						disabled={disabled || loading}
						aria-label={menuLabel}
					>
						{menuDisplay && (
							<span className="inline-flex shrink-0" data-split-icon>
								{menuDisplay}
							</span>
						)}
						<ChevronDown className="size-4" aria-hidden="true" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">{menu}</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
