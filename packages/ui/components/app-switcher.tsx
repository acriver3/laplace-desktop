"use client";

import { AppWindowIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "./dropdown-menu";

interface AppSwitcherProps {
	current: "saas" | "connector";
	saasHref: string;
	connectorHref: string;
	label: string;
	collapsed?: boolean;
}

export function AppSwitcher({
	current,
	saasHref,
	connectorHref,
	label,
	collapsed,
}: AppSwitcherProps) {
	const ready = useSyncExternalStore(subscribeToHydration, clientReady, serverReady);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className="min-w-0 gap-2 p-2 text-sm font-medium flex items-center rounded-md hover:bg-muted"
				aria-label={label}
				disabled={!ready}
			>
				<AppWindowIcon className="size-4 shrink-0" />
				{!collapsed && <span>{label}</span>}
				<ChevronDownIcon className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>{label}</DropdownMenuLabel>
					{[
						{ id: "saas", name: "Thrillstock", href: saasHref },
						{ id: "connector", name: "Laplace", href: connectorHref },
					].map((app) => (
						<DropdownMenuItem
							key={app.id}
							nativeButton={false}
							render={
								<a
									href={app.href}
									aria-label={app.name}
									aria-current={app.id === current ? "page" : undefined}
								/>
							}
						>
							<span>{app.name}</span>
							{app.id === current && <CheckIcon className="size-4 ml-auto" />}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function subscribeToHydration() {
	return () => {};
}
function clientReady() {
	return true;
}
function serverReady() {
	return false;
}
