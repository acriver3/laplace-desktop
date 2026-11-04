"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import * as React from "react";

import { cn } from "../lib";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

type TooltipPositionerProps = React.ComponentProps<typeof TooltipPrimitive.Positioner>;

const TooltipContent = ({
	className,
	sideOffset = 4,
	side,
	align,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & {
	sideOffset?: number;
	side?: TooltipPositionerProps["side"];
	align?: TooltipPositionerProps["align"];
}) => (
	<TooltipPrimitive.Portal>
		<TooltipPrimitive.Positioner className="z-50" sideOffset={sideOffset} side={side} align={align}>
			<TooltipPrimitive.Popup
				className={cn(
					"fade-in-0 zoom-in-95 data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 animate-in px-3 py-1.5 text-sm shadow-md data-[closed]:animate-out z-50 overflow-hidden rounded-md border bg-popover text-popover-foreground",
					className,
				)}
				{...props}
			/>
		</TooltipPrimitive.Positioner>
	</TooltipPrimitive.Portal>
);

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
