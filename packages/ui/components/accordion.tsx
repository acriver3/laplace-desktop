"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDownIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib";

const Accordion = AccordionPrimitive.Root;

const AccordionItem = ({
	className,
	...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) => (
	<AccordionPrimitive.Item className={cn("border-b", className)} {...props} />
);

const AccordionTrigger = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) => (
	<AccordionPrimitive.Header className="flex">
		<AccordionPrimitive.Trigger
			className={cn(
				"py-4 font-medium text-sm flex flex-1 items-center justify-between transition-all hover:underline [&[data-panel-open]>svg]:rotate-180",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]" />
		</AccordionPrimitive.Trigger>
	</AccordionPrimitive.Header>
);

const AccordionContent = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof AccordionPrimitive.Panel>) => (
	<AccordionPrimitive.Panel
		className={cn(
			"text-sm data-ending-style:h-0 data-starting-style:h-0 h-[var(--accordion-panel-height)] overflow-hidden transition-[height,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:opacity-0 data-starting-style:opacity-0",
			className,
		)}
		{...props}
	>
		<div className="pt-0 pb-4">{children}</div>
	</AccordionPrimitive.Panel>
);

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
