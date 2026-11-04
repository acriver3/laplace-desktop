import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import * as React from "react";
import { twMerge } from "tailwind-merge";

export * from "./logo-glow";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

const TRIGGER_EVENT_KEYS = [
	"onClick",
	"onPointerDown",
	"onPointerUp",
	"onPointerMove",
	"onPointerCancel",
	"onPointerEnter",
	"onPointerLeave",
	"onPointerOver",
	"onPointerOut",
	"onKeyDown",
	"onKeyUp",
	"onFocus",
	"onBlur",
	"onMouseDown",
	"onMouseUp",
] as const;

function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]) {
	return (node: T | null) => {
		for (const ref of refs) {
			if (typeof ref === "function") ref(node);
			else if (ref && typeof ref === "object" && "current" in ref) {
				(ref as React.MutableRefObject<T | null>).current = node;
			}
		}
	};
}

/**
 * Merge props from two Base UI triggers (e.g. Tooltip + Menu) so one element can
 * compose both behaviors. Use with `render` props instead of Radix `asChild`.
 */
export function mergeTriggerProps(
	a: object,
	b: object,
): Record<string, unknown> & { ref: React.RefCallback<HTMLElement> } {
	const out: Record<string, unknown> = { ...a, ...b };

	const ar = a as Record<string, unknown>;
	const br = b as Record<string, unknown>;
	for (const key of TRIGGER_EVENT_KEYS) {
		const va = ar[key];
		const vb = br[key];
		if (typeof va === "function" && typeof vb === "function") {
			out[key] = (e: unknown) => {
				(va as (e: unknown) => void)(e);
				(vb as (e: unknown) => void)(e);
			};
		}
	}

	out.ref = mergeRefs(
		ar.ref as React.Ref<HTMLElement> | undefined,
		br.ref as React.Ref<HTMLElement> | undefined,
	);

	out.className = cn(
		(a as { className?: string }).className,
		(b as { className?: string }).className,
	);

	const styleA = (a as { style?: React.CSSProperties }).style;
	const styleB = (b as { style?: React.CSSProperties }).style;
	if (styleA || styleB) {
		out.style = { ...styleA, ...styleB };
	}

	return out as Record<string, unknown> & { ref: React.RefCallback<HTMLElement> };
}
