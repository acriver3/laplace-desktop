"use client";

import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib";

const labelVariants = cva(
	"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
);

const Label = ({
	className,
	...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & VariantProps<typeof labelVariants>) => (
	// Design-system primitive: `htmlFor` is supplied by callers (e.g. FormLabel).
	// oxlint-disable-next-line jsx-a11y/label-has-associated-control -- primitive label
	<label className={cn(labelVariants(), className)} {...props} />
);

export { Label };
