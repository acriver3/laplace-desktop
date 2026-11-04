import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib";
import { Spinner } from "./spinner";

const buttonVariants = cva(
	"flex items-center justify-center font-semibold enabled:cursor-pointer transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&>svg]:mr-1.5 [&>svg+svg]:hidden",
	{
		variants: {
			variant: {
				primary:
					"bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary)82%,var(--background))]",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-[color-mix(in_srgb,var(--secondary)90%,black)]",
				touch:
					"bg-touch text-touch-foreground hover:bg-[color-mix(in_srgb,var(--touch)82%,var(--background))]",
				outline:
					"border border-(--button-outline-border) bg-(--button-outline) text-(--button-outline-text) shadow-(--button-outline-shadow) hover:border-(--button-outline-hover-border) hover:bg-(--button-outline-hover)",
				ghost: "text-foreground hover:bg-foreground/10 hover:text-foreground",
				destructive:
					"bg-destructive text-destructive-foreground hover:bg-[color-mix(in_srgb,var(--destructive)90%,black)]",
				link: "text-primary underline underline-offset-4 hover:decoration-2",
			},
			size: {
				sm: "h-6 rounded-full px-3 text-xs",
				md: "h-9 rounded-full px-4 text-sm",
				lg: "h-12 rounded-full px-6 text-base",
				icon: "size-8 rounded-full [&>svg]:m-0",
			},
		},
		defaultVariants: {
			variant: "secondary",
			size: "md",
		},
	},
);

export type ButtonRenderProps = React.HTMLAttributes<HTMLElement> & {
	disabled?: boolean;
	type?: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
};

export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> &
	VariantProps<typeof buttonVariants> & {
		loading?: boolean;
		children?: React.ReactNode;
		/**
		 * Compose styles and behavior onto a custom element (e.g. `<a>` or `next/link`).
		 * Spread the received props onto the root element.
		 */
		render?: (props: ButtonRenderProps) => React.ReactElement<{ ref?: React.Ref<unknown> }>;
	};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ className, children, variant, size, loading, disabled, render, ...props },
	ref,
) {
	const mergedClassName = cn(buttonVariants({ variant, size, className }));
	const isDisabled = Boolean(disabled || loading);

	if (render) {
		const element = render({
			...props,
			className: mergedClassName,
			disabled: isDisabled,
			"aria-busy": loading || undefined,
			children: (
				<>
					{loading && <Spinner className="mr-1.5 size-4 text-inherit" />}
					{children}
				</>
			),
		});

		return ref ? React.cloneElement(element, { ref }) : element;
	}

	return (
		<button
			ref={ref}
			className={mergedClassName}
			disabled={isDisabled}
			aria-busy={loading || undefined}
			{...props}
		>
			{loading && <Spinner className="mr-1.5 size-4 text-inherit" />}
			{children}
		</button>
	);
});

Button.displayName = "Button";

export { Button, buttonVariants };
