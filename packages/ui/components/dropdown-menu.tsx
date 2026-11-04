"use client";

import { Menu as DropdownMenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib";

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.SubmenuRoot;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const DropdownMenuSubTrigger = ({
	className,
	inset,
	children,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubmenuTrigger> & {
	inset?: boolean;
}) => (
	<DropdownMenuPrimitive.SubmenuTrigger
		className={cn(
			"px-3 py-1.5 text-sm flex cursor-default items-center rounded-lg outline-hidden select-none focus:bg-accent data-[open]:bg-accent",
			inset ? "pl-8" : "",
			className,
		)}
		{...props}
	>
		{children}
		<ChevronRightIcon className="size-4 ml-auto" />
	</DropdownMenuPrimitive.SubmenuTrigger>
);

const DropdownMenuSubContent = ({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Popup>) => (
	<DropdownMenuPrimitive.Portal>
		<DropdownMenuPrimitive.Positioner className="z-50">
			<DropdownMenuPrimitive.Popup
				className={cn(
					"data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 p-1 shadow-lg shadow-black/3 data-[closed]:animate-out data-[open]:animate-in z-50 min-w-[8rem] overflow-hidden rounded-lg border bg-popover text-popover-foreground",
					className,
				)}
				{...props}
			/>
		</DropdownMenuPrimitive.Positioner>
	</DropdownMenuPrimitive.Portal>
);

type DropdownPositionerProps = React.ComponentProps<typeof DropdownMenuPrimitive.Positioner>;

const DropdownMenuContent = ({
	className,
	sideOffset = 4,
	side,
	align,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Popup> & {
	sideOffset?: number;
	side?: DropdownPositionerProps["side"];
	align?: DropdownPositionerProps["align"];
}) => (
	<DropdownMenuPrimitive.Portal>
		<DropdownMenuPrimitive.Positioner
			className="z-50"
			sideOffset={sideOffset}
			side={side}
			align={align}
		>
			<DropdownMenuPrimitive.Popup
				className={cn(
					"p-2 shadow-xl shadow-black/3 z-50 min-w-[8rem] overflow-hidden rounded-xl border bg-popover text-popover-foreground",
					"data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[closed]:animate-out data-[open]:animate-in",
					className,
				)}
				{...props}
			/>
		</DropdownMenuPrimitive.Positioner>
	</DropdownMenuPrimitive.Portal>
);

const DropdownMenuItem = ({
	className,
	inset,
	onSelect,
	nativeButton,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
	inset?: boolean;
	/** Alias for `onClick` (Radix `DropdownMenuItem` used `onSelect`). */
	onSelect?: React.MouseEventHandler<HTMLElement>;
}) => {
	const { onClick, ...rest } = props;
	return (
		<DropdownMenuPrimitive.Item
			nativeButton={nativeButton}
			className={cn(
				"px-3 py-2 text-sm relative flex cursor-default items-center rounded-md outline-hidden transition-colors select-none focus:bg-accent focus:text-accent-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50",
				inset ? "pl-8" : "",
				className,
			)}
			{...rest}
			onClick={(e) => {
				onClick?.(e);
				onSelect?.(e);
			}}
		/>
	);
};

const DropdownMenuCheckboxItem = ({
	className,
	children,
	checked,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) => (
	<DropdownMenuPrimitive.CheckboxItem
		className={cn(
			"py-3 pr-3 pl-8 text-sm relative flex cursor-default items-center rounded-md outline-hidden transition-colors select-none focus:bg-accent focus:text-accent-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50",
			className,
		)}
		checked={checked}
		{...props}
	>
		<span className="left-2 size-3.5 absolute flex items-center justify-center">
			<DropdownMenuPrimitive.CheckboxItemIndicator>
				<CheckIcon className="size-4" />
			</DropdownMenuPrimitive.CheckboxItemIndicator>
		</span>
		{children}
	</DropdownMenuPrimitive.CheckboxItem>
);

const DropdownMenuRadioItem = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) => (
	<DropdownMenuPrimitive.RadioItem
		className={cn(
			"py-2 pr-8 pl-3 text-sm data-[checked]:font-semibold relative flex cursor-default items-center rounded-md outline-hidden transition-colors select-none focus:bg-accent focus:text-accent-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50",
			className,
		)}
		{...props}
	>
		<span className="right-2 size-3.5 absolute flex items-center justify-center">
			<DropdownMenuPrimitive.RadioItemIndicator>
				<CheckIcon className="size-4" />
			</DropdownMenuPrimitive.RadioItemIndicator>
		</span>
		{children}
	</DropdownMenuPrimitive.RadioItem>
);

const DropdownMenuLabel = ({
	className,
	inset,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.GroupLabel> & {
	inset?: boolean;
}) => (
	<DropdownMenuPrimitive.GroupLabel
		className={cn("px-3 py-2 font-semibold text-sm", inset ? "pl-8" : "", className)}
		{...props}
	/>
);

const DropdownMenuSeparator = ({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) => (
	<DropdownMenuPrimitive.Separator
		className={cn("-mx-2 my-1.5 h-px bg-border", className)}
		{...props}
	/>
);

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
	return (
		<span
			className={cn("text-xs tracking-widest ml-auto text-muted-foreground", className)}
			{...props}
		/>
	);
};

export {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
};
