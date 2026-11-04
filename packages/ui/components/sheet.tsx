"use client";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import { XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib";

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

const SheetOverlay = ({
	className,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Backdrop>) => (
	<SheetPrimitive.Backdrop
		className={cn(
			"data-[closed]:fade-out-0 data-[open]:fade-in-0 inset-0 backdrop-blur-xs data-[closed]:animate-out data-[open]:animate-in fixed z-50 bg-background/80",
			className,
		)}
		{...props}
	/>
);

const sheetVariants = cva(
	"fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[closed]:duration-300 data-[open]:duration-500 data-[open]:animate-in data-[closed]:animate-out",
	{
		variants: {
			side: {
				top: "inset-x-0 top-0 border-b data-[closed]:slide-out-to-top data-[open]:slide-in-from-top",
				bottom:
					"inset-x-0 bottom-0 border-t data-[closed]:slide-out-to-bottom data-[open]:slide-in-from-bottom",
				left: "inset-y-0 left-0 h-full w-3/4 border-r data-[closed]:slide-out-to-left data-[open]:slide-in-from-left sm:max-w-sm",
				right:
					"inset-y-0 right-0 h-full w-3/4  border-l data-[closed]:slide-out-to-right data-[open]:slide-in-from-right sm:max-w-sm",
			},
		},
		defaultVariants: {
			side: "right",
		},
	},
);

type SheetContentProps = {} & React.ComponentProps<typeof SheetPrimitive.Popup> &
	VariantProps<typeof sheetVariants>;

const SheetContent = ({ side = "right", className, children, ...props }: SheetContentProps) => (
	<SheetPrimitive.Portal>
		<SheetOverlay />
		<SheetPrimitive.Popup className={sheetVariants({ side, className })} {...props}>
			{children}
			<SheetPrimitive.Close className="top-4 right-4 absolute rounded-sm text-muted-foreground ring-offset-background transition-colors hover:text-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[open]:bg-secondary">
				<XIcon className="size-4" />
				<span className="sr-only">Close</span>
			</SheetPrimitive.Close>
		</SheetPrimitive.Popup>
	</SheetPrimitive.Portal>
);

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("space-y-2 sm:text-left flex flex-col text-center", className)} {...props} />
);

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("sm:flex-row sm:justify-end sm:space-x-2 flex flex-col-reverse", className)}
		{...props}
	/>
);

const SheetTitle = ({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) => (
	<SheetPrimitive.Title
		className={cn("font-semibold text-lg text-foreground", className)}
		{...props}
	/>
);

const SheetDescription = ({
	className,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) => (
	<SheetPrimitive.Description
		className={cn("text-sm text-muted-foreground", className)}
		{...props}
	/>
);

export {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
};
