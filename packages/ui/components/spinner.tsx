import { Loader2Icon } from "lucide-react";

import { cn } from "../lib";

export function Spinner({ className }: { className?: string }) {
	return (
		<Loader2Icon
			aria-hidden="true"
			className={cn(
				"size-4 animate-spin shrink-0 text-primary motion-reduce:animate-none",
				className,
			)}
		/>
	);
}
