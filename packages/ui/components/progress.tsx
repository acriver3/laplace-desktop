"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import * as React from "react";

import { cn } from "../lib";

const Progress = ({
	className,
	value,
	...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value"> & {
	value?: number | null;
}) => (
	<ProgressPrimitive.Root
		className={cn("h-4 relative w-full overflow-hidden rounded-full bg-border", className)}
		value={value ?? null}
		{...props}
	>
		<ProgressPrimitive.Track className="h-full w-full rounded-full">
			<ProgressPrimitive.Indicator className="ease-out h-full rounded-full bg-primary transition-[width] duration-300" />
		</ProgressPrimitive.Track>
	</ProgressPrimitive.Root>
);

export { Progress };
