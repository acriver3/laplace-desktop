import { cn } from "../lib";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			data-skeleton=""
			className={cn("animate-pulse rounded-md bg-primary/10 motion-reduce:animate-none", className)}
			{...props}
		/>
	);
}

export { Skeleton };
