"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogOverlay = ({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Backdrop>) => (
	<DialogPrimitive.Backdrop
		className={cn(
			"data-[closed]:fade-out-0 data-[open]:fade-in-0 inset-0 backdrop-blur-xs data-[closed]:animate-out data-[open]:animate-in fixed z-50 bg-card",
			className,
		)}
		{...props}
	/>
);

const DialogContent = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Popup>) => (
	<DialogPrimitive.Portal>
		<DialogOverlay />
		<DialogPrimitive.Popup
			className={cn(
				"data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[closed]:slide-out-to-left-1/2 data-[closed]:slide-out-to-top-[48%] data-[open]:slide-in-from-left-1/2 data-[open]:slide-in-from-top-[48%] max-w-lg gap-4 p-6 shadow-lg data-[closed]:animate-out data-[open]:animate-in md:w-full fixed top-[50%] left-[50%] z-50 grid w-full translate-x-[-50%] translate-y-[-50%] rounded-2xl border bg-background duration-200",
				className,
			)}
			{...props}
		>
			{children}
			<DialogPrimitive.Close className="top-4 right-4 absolute rounded-sm text-muted-foreground ring-offset-background transition-colors hover:text-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[open]:bg-accent data-[open]:text-muted-foreground">
				<XIcon className="size-4" />
				<span className="sr-only">Close</span>
			</DialogPrimitive.Close>
		</DialogPrimitive.Popup>
	</DialogPrimitive.Portal>
);

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("space-y-1.5 sm:text-left flex flex-col text-center", className)} {...props} />
);

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("sm:flex-row sm:justify-end sm:space-x-2 flex flex-col-reverse", className)}
		{...props}
	/>
);

const DialogTitle = ({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) => (
	<DialogPrimitive.Title
		className={cn("font-semibold text-lg tracking-tight leading-none", className)}
		{...props}
	/>
);

const DialogDescription = ({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) => (
	<DialogPrimitive.Description
		className={cn("text-sm text-muted-foreground", className)}
		{...props}
	/>
);

export {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
};
