"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import * as React from "react";

import { cn } from "../lib";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

type PopoverPositionerProps = React.ComponentProps<typeof PopoverPrimitive.Positioner>;

const PopoverContent = ({
	className,
	align = "center",
	side,
	sideOffset = 4,
	...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
	align?: PopoverPositionerProps["align"];
	side?: PopoverPositionerProps["side"];
	sideOffset?: number;
}) => (
	<PopoverPrimitive.Portal>
		<PopoverPrimitive.Positioner className="z-50" align={align} side={side} sideOffset={sideOffset}>
			<PopoverPrimitive.Popup
				className={cn(
					"data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 w-72 p-4 shadow-md data-[closed]:animate-out data-[open]:animate-in z-50 origin-[var(--transform-origin)] rounded-lg border bg-popover text-popover-foreground outline-hidden",
					className,
				)}
				{...props}
			/>
		</PopoverPrimitive.Positioner>
	</PopoverPrimitive.Portal>
);

export { Popover, PopoverContent, PopoverTrigger };
