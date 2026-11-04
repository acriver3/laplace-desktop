import type { ComponentProps, ReactNode } from "react";

import { ConnectionToolbar } from "./connection-toolbar";
import { HomeStartPanel } from "./home-panels";
import { AssistantChoices, SetupFlow, SetupStep } from "./setup-flow";

/** Shared page composition; controllers decide which sources are ready or empty. */
export function HomePageView({
	header,
	before,
	gettingStarted,
	startTitle,
	startDescription,
	connect,
	assistant,
	additionalStart,
	connections,
	apps,
	children,
}: {
	header?: ReactNode;
	before?: ReactNode;
	gettingStarted: boolean;
	startTitle: string;
	startDescription: string;
	connect: ReactNode;
	assistant: ReactNode;
	additionalStart?: ReactNode;
	connections?: ReactNode;
	apps?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<>
			{before}
			{header}
			{gettingStarted ? (
				<HomeStartPanel title={startTitle} description={startDescription}>
					<li className="home-setup-step min-w-0 space-y-3">{connect}</li>
					<li className="min-w-0">{assistant}</li>
					{additionalStart && (
						<li className="home-setup-step min-w-0 space-y-3">{additionalStart}</li>
					)}
				</HomeStartPanel>
			) : (
				<>
					<div
						className={`home-summary-grid gap-4 grid${connections ? " home-summary-admin" : ""}`}
					>
						{connections}
						{assistant}
					</div>
					{apps}
				</>
			)}
			{children}
		</>
	);
}

export interface ConnectionPageSection {
	id: string;
	title?: ReactNode;
	actions?: ReactNode;
	content: ReactNode;
}

export function ConnectionsPageView({
	header,
	toolbar,
	notices,
	sections,
	details,
	busy = false,
}: {
	header?: ReactNode;
	toolbar: ComponentProps<typeof ConnectionToolbar>;
	notices?: ReactNode;
	sections: ConnectionPageSection[];
	details?: ReactNode;
	busy?: boolean;
}) {
	return (
		<div className="connector-connections-content space-y-6" aria-busy={busy}>
			{header}
			<ConnectionToolbar {...toolbar} />
			{notices}
			{sections.map(({ id, title, actions, content }) => (
				<section key={id} className="connector-section" aria-labelledby={title ? id : undefined}>
					{title && (
						<div className="gap-3 flex flex-wrap items-center justify-between">
							<h2 id={id} className="connector-section-title">
								{title}
							</h2>
							{actions}
						</div>
					)}
					{content}
				</section>
			))}
			{details}
		</div>
	);
}

export interface AssistantFollowUpStep {
	id: string;
	title: ReactNode;
	description?: ReactNode;
	content?: ReactNode;
}

/** Both transports use the same chooser and numbered flow, with explicit steps. */
export function AssistantSetupView({
	id,
	compact = false,
	label,
	stepsLabel,
	choice,
	setup,
	followUpSteps = [],
	footer,
}: {
	id?: string;
	compact?: boolean;
	label: string;
	stepsLabel: string;
	choice: ComponentProps<typeof AssistantChoices> & {
		title: ReactNode;
		selectionLabel?: ReactNode;
		environment?: ReactNode;
	};
	setup: { title?: ReactNode; description?: ReactNode; content: ReactNode };
	followUpSteps?: AssistantFollowUpStep[];
	footer?: ReactNode;
}) {
	return (
		<SetupFlow id={id} compact={compact} label={label} stepsLabel={stepsLabel} footer={footer}>
			<SetupStep number={1} compact={compact}>
				<h2>{choice.title}</h2>
				{choice.options.length > 0 && (
					<AssistantChoices
						options={choice.options}
						selected={choice.selected}
						onSelect={choice.onSelect}
						label={choice.label}
						checkIcon={choice.checkIcon}
					/>
				)}
				{choice.selectionLabel && (
					<p className="standard-setup-selection" aria-live="polite">
						{choice.selectionLabel}
					</p>
				)}
				{choice.environment}
			</SetupStep>
			<SetupStep number={2} compact={compact}>
				{!compact && setup.title && <h2>{setup.title}</h2>}
				{!compact && setup.description && <p>{setup.description}</p>}
				{setup.content}
			</SetupStep>
			{!compact &&
				followUpSteps.map((step, index) => (
					<SetupStep key={step.id} number={index + 3}>
						<h2>{step.title}</h2>
						{step.description && <p>{step.description}</p>}
						{step.content}
					</SetupStep>
				))}
		</SetupFlow>
	);
}

export interface SettingsNavigationItem {
	id: string;
	label: string;
}

export function SettingsPageView({
	header,
	navigationLabel,
	items,
	activeId,
	onSelect,
	renderNavigationItem,
	children,
}: {
	header?: ReactNode;
	navigationLabel: string;
	items: SettingsNavigationItem[];
	activeId: string;
	onSelect?: (id: string) => void;
	renderNavigationItem?: (item: SettingsNavigationItem, active: boolean) => ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="connector-settings">
			{header}
			<nav className="settings-navigation" aria-label={navigationLabel}>
				{items.map((item) => (
					<span key={item.id} className="contents">
						{renderNavigationItem ? (
							renderNavigationItem(item, item.id === activeId)
						) : (
							<button
								type="button"
								className="settings-navigation-link"
								aria-current={item.id === activeId ? "page" : undefined}
								onClick={() => onSelect?.(item.id)}
							>
								{item.label}
							</button>
						)}
					</span>
				))}
			</nav>
			{children}
		</div>
	);
}
