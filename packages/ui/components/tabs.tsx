"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import * as React from "react";

import { cn } from "../lib";

const Tabs = TabsPrimitive.Root;

const TabsList = ({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) => (
	<TabsPrimitive.List
		className={cn(
			"text-sm inline-flex items-center justify-center border-b-2 text-card-foreground/80",
			className,
		)}
		{...props}
	/>
);

const TabsTrigger = ({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Tab>) => (
	<TabsPrimitive.Tab
		className={cn(
			"-mb-0.5 px-3 py-2 font-medium text-sm inline-flex items-center justify-center border-b-2 border-transparent whitespace-nowrap text-muted-foreground ring-offset-background transition-all hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 aria-selected:border-touch aria-selected:text-card-foreground",
			className,
		)}
		{...props}
	/>
);

const TabsContent = ({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Panel>) => (
	<TabsPrimitive.Panel
		className={cn(
			"mt-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden",
			className,
		)}
		{...props}
	/>
);

export { Tabs, TabsContent, TabsList, TabsTrigger };
