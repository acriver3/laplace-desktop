import type { ReactNode } from "react";

import { Button } from "../button";

export function SetupFlow({
	compact = false,
	label,
	stepsLabel,
	id,
	children,
	footer,
}: {
	compact?: boolean;
	label: string;
	stepsLabel: string;
	id?: string;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<section
			id={id}
			className={`standard-setup${compact ? " standard-setup-compact" : ""}`}
			aria-label={label}
		>
			<ol className="standard-setup-steps" aria-label={stepsLabel}>
				{children}
			</ol>
			{compact && footer && <div className="standard-setup-compact-footer">{footer}</div>}
		</section>
	);
}

export function SetupStep({
	number,
	compact = false,
	children,
}: {
	number: number;
	compact?: boolean;
	children: ReactNode;
}) {
	return (
		<li>
			{!compact && (
				<span className="standard-setup-number" aria-hidden="true">
					{number}
				</span>
			)}
			<div className="standard-setup-content">{children}</div>
		</li>
	);
}

export function AssistantChoices({
	options,
	checkIcon,
	selected,
	onSelect,
	label,
}: {
	checkIcon: ReactNode;
	options: { id: string; label: string; title?: string; icon: ReactNode }[];
	selected: string;
	onSelect: (id: string) => void;
	label: string;
}) {
	return (
		<div className="standard-setup-assistants" role="group" aria-label={label}>
			{options.map((option) => (
				<Button
					key={option.id}
					type="button"
					variant="outline"
					className="standard-setup-assistant"
					aria-pressed={option.id === selected}
					aria-label={option.title ?? option.label}
					title={option.title ?? option.label}
					onClick={() => onSelect(option.id)}
				>
					{option.icon}
					<span className="standard-setup-assistant-label">{option.label}</span>
					{option.id === selected && checkIcon}
				</Button>
			))}
		</div>
	);
}
