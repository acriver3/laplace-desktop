"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import * as React from "react";

import { cn } from "../lib";

const Switch = ({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) => (
	<SwitchPrimitive.Root
		className={cn(
			"peer h-6 w-11 inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-input transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-touch",
			className,
		)}
		{...props}
	>
		<SwitchPrimitive.Thumb
			className={cn(
				"size-5 shadow-lg translate-x-0 data-[checked]:translate-x-5 pointer-events-none block rounded-full bg-background ring-0 transition-transform",
			)}
		/>
	</SwitchPrimitive.Root>
);

export { Switch };
