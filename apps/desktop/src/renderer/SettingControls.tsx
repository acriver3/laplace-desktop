import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@repo/ui/components/tooltip";
import { Info } from "lucide-react";
import { useId, type InputHTMLAttributes } from "react";

export function SettingHint({ label, hint }: { label: string; hint: string }) {
	const id = useId();
	return (
		<TooltipProvider delay={250}>
			<Tooltip>
				<TooltipTrigger
					type="button"
					className="desktop-setting-hint"
					aria-label={`About ${label}`}
					aria-describedby={id}
				>
					<Info size={15} aria-hidden="true" />
				</TooltipTrigger>
				<TooltipContent id={id} role="tooltip" className="desktop-setting-tooltip" side="top">
					{hint}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

export function SettingLabel({
	label,
	hint,
	htmlFor,
}: {
	label: string;
	hint: string;
	htmlFor?: string;
}) {
	return (
		<span className="desktop-setting-label">
			{htmlFor ? (
				<label htmlFor={htmlFor} title={hint}>
					{label}
				</label>
			) : (
				<span title={hint}>{label}</span>
			)}
			<SettingHint label={label} hint={hint} />
		</span>
	);
}

export function SettingToggle({
	id,
	label,
	hint,
	...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & {
	id: string;
	label: string;
	hint: string;
}) {
	return (
		<div className="desktop-setting-toggle">
			<span className="desktop-setting-copy">
				<SettingLabel htmlFor={id} label={label} hint={hint} />
			</span>
			<input {...input} id={id} type="checkbox" />
		</div>
	);
}
