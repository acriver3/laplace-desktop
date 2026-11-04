"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import * as React from "react";

import { cn } from "../lib";
import { buttonVariants } from "./button";

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

const AlertDialogPortal = AlertDialogPrimitive.Portal;

const AlertDialogOverlay = ({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Backdrop>) => (
	<AlertDialogPrimitive.Backdrop
		className={cn(
			"data-[closed]:fade-out-0 data-[open]:fade-in-0 inset-0 bg-black/80 data-[closed]:animate-out data-[open]:animate-in fixed z-50",
			className,
		)}
		{...props}
	/>
);

const AlertDialogContent = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Popup>) => (
	<AlertDialogPortal>
		<AlertDialogOverlay />
		<AlertDialogPrimitive.Popup
			className={cn(
				"data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[closed]:slide-out-to-left-1/2 data-[closed]:slide-out-to-top-[48%] data-[open]:slide-in-from-left-1/2 data-[open]:slide-in-from-top-[48%] max-w-lg gap-4 p-6 shadow-lg data-[closed]:animate-out data-[open]:animate-in sm:rounded-2xl fixed top-[50%] left-[50%] z-50 grid w-full translate-x-[-50%] translate-y-[-50%] border bg-card duration-200",
				className,
			)}
			{...props}
		>
			{children}
		</AlertDialogPrimitive.Popup>
	</AlertDialogPortal>
);

const AlertDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("space-y-2 sm:text-left flex flex-col text-center", className)} {...props} />
);

const AlertDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("sm:flex-row sm:justify-end sm:space-x-2 flex flex-col-reverse", className)}
		{...props}
	/>
);

const AlertDialogTitle = ({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) => (
	<AlertDialogPrimitive.Title className={cn("font-semibold text-lg", className)} {...props} />
);

const AlertDialogDescription = ({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) => (
	<AlertDialogPrimitive.Description
		className={cn("text-sm text-muted-foreground", className)}
		{...props}
	/>
);

const AlertDialogAction = ({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Close>) => (
	<AlertDialogPrimitive.Close className={cn(buttonVariants(), className)} {...props} />
);

const AlertDialogCancel = ({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Close>) => (
	<AlertDialogPrimitive.Close
		className={cn(buttonVariants({ variant: "outline" }), "mt-2 sm:mt-0", className)}
		{...props}
	/>
);

export {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogOverlay,
	AlertDialogPortal,
	AlertDialogTitle,
	AlertDialogTrigger,
};
