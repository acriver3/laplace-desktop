import { Button } from "@repo/ui/components/button";
import { ConnectionTile } from "@repo/ui/components/connector/connection-tile";
import { ConnectionsPageView } from "@repo/ui/components/connector/page-views";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@repo/ui/components/dropdown-menu";
import { ChevronDown, FolderInput, Plus, RefreshCw, SearchIcon } from "lucide-react";
import { useState } from "react";

import type { ServerSnapshot } from "../shared/helper-contracts";
import { BrokerStart } from "./BrokerStart";
import { CatalogConnectButton } from "./CatalogConnectButton";
import { ConnectionIcon } from "./ConnectionIcon";
import { Modal } from "./Dialogs";
import { PortablePeers } from "./PortablePeers";
import { PortableSetup } from "./PortableSetup";
import type { CatalogEntry } from "./types";

/** Connections on this computer; workspace connections live in Laplace itself. */
export function LocalConnectionsPage({
	servers,
	catalog,
	busy,
	refresh,
	add,
	importFile,
	details,
	edit,
	remove,
	control,
	install,
	search,
	onSearch,
	view,
	onView,
}: {
	servers: ServerSnapshot[];
	catalog: CatalogEntry[];
	busy: boolean;
	refresh: () => void;
	add: () => void;
	importFile: () => void;
	details: (server: ServerSnapshot) => void;
	edit: (server: ServerSnapshot) => void;
	remove: (server: ServerSnapshot) => void;
	control: (server: ServerSnapshot, action: "start" | "stop" | "restart") => void;
	install: (entry: CatalogEntry) => void;
	search: string;
	onSearch: (value: string) => void;
	view: string;
	onView: (value: string) => void;
}) {
	const [catalogDetails, setCatalogDetails] = useState<CatalogEntry>();
	const installedCatalog = new Map(
		catalog
			.filter((entry) => entry.installed && entry.serverId)
			.map((entry) => [entry.serverId, entry]),
	);
	const query = search.trim().toLowerCase();
	const matches = (...values: (string | undefined)[]) =>
		values.join(" ").toLowerCase().includes(query);
	const local = servers.filter((server) => matches(server.name, server.id));
	const available = catalog.filter(
		(entry) => !entry.installed && matches(entry.name, entry.description),
	);
	return (
		<ConnectionsPageView
			busy={busy}
			toolbar={{
				searchIcon: <SearchIcon className="size-4" aria-hidden="true" />,
				search,
				onSearch,
				searchLabel: "Search connections",
				filterLabel: "Show connections",
				filters: [
					{ value: "both", label: "All" },
					{ value: "existing", label: "Connected" },
					{ value: "available", label: "Available" },
				],
				view,
				onView,
				children: (
					<>
						<Button
							variant="outline"
							size="icon"
							aria-label="Refresh connections"
							disabled={busy}
							onClick={refresh}
						>
							<RefreshCw className="size-4" />
						</Button>
						<Button variant="outline" onClick={importFile}>
							<FolderInput className="size-4" />
							Import configuration
						</Button>
						<Button variant="primary" onClick={add}>
							<Plus className="size-4" />
							Add custom connection
						</Button>
					</>
				),
			}}
			notices={
				<>
					<PortableSetup />
					<BrokerStart entries={available} label="Connect selected with assistant" batch />
					{catalogDetails && (
						<Modal title={catalogDetails.name} close={() => setCatalogDetails(undefined)}>
							<div className="dialog-body stack">
								<p>{catalogDetails.description}</p>
								{catalogDetails.setupUrl && (
									<a href={catalogDetails.setupUrl} target="_blank" rel="noreferrer">
										Setup instructions
									</a>
								)}
								<BrokerStart
									entries={[catalogDetails]}
									label={
										catalogDetails.installed
											? "Reauthenticate with assistant"
											: "Connect with assistant"
									}
								/>
								{catalogDetails.demoOnly && <p>Demo Only</p>}
								{!catalogDetails.available && <p>Unavailable on this platform</p>}
							</div>
						</Modal>
					)}
				</>
			}
			sections={[
				...(view !== "available"
					? [
							{
								id: "local-connections",
								title: "This device",
								content: (
									<>
										<PortablePeers />
										<ul className="connector-row-list" aria-label="Local connections">
											{local.map((server) => (
												<ConnectionTile
													key={server.id}
													className="desktop-connection"
													title={server.name}
													subtitle={`${installedCatalog.has(server.id) ? "Catalog" : "Custom"} · ${server.tools.length} tools`}
													onDetails={() => details(server)}
													statusLabel={
														installedCatalog.get(server.id)?.demoOnly
															? "Demo Only"
															: server.status.replaceAll("_", " ")
													}
													connected={server.status === "online"}
													icon={<ConnectionIcon />}
												>
													{installedCatalog.get(server.id) && (
														<BrokerStart
															entries={[installedCatalog.get(server.id)!]}
															label="Reauthenticate with assistant"
														/>
													)}
													<DropdownMenu>
														<DropdownMenuTrigger
															render={<Button variant="outline" size="icon" />}
															aria-label={`Options for ${server.name} (${server.id})`}
														>
															<ChevronDown className="size-4" aria-hidden="true" />
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end">
															<DropdownMenuItem onClick={() => details(server)}>
																View details
															</DropdownMenuItem>
															<DropdownMenuItem onClick={() => edit(server)}>
																Edit connection
															</DropdownMenuItem>
															<DropdownMenuSeparator />
															<DropdownMenuItem
																disabled={busy}
																onClick={() => control(server, server.enabled ? "stop" : "start")}
															>
																{server.enabled ? "Stop" : "Start"}
															</DropdownMenuItem>
															<DropdownMenuItem
																disabled={busy}
																onClick={() => control(server, "restart")}
															>
																Restart
															</DropdownMenuItem>
															<DropdownMenuSeparator />
															<DropdownMenuItem
																className="text-destructive"
																disabled={busy}
																onClick={() => remove(server)}
															>
																Delete connection
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</ConnectionTile>
											))}
										</ul>
										{!local.length && (
											<p className="text-sm text-muted-foreground">
												{query
													? "No matching connections."
													: "No connections on this device yet. Connect one below, add a custom connection, or import your existing configuration."}
											</p>
										)}
									</>
								),
							},
						]
					: []),
				...(view !== "existing"
					? [
							{
								id: "available-connections",
								title: "Available to connect",
								content: (
									<>
										<ul className="connector-row-list" aria-label="Available connections">
											{available.map((entry) => (
												<ConnectionTile
													key={entry.id}
													className="desktop-connection desktop-catalog-connection"
													title={entry.name}
													onDetails={() => setCatalogDetails(entry)}
													statusLabel={
														entry.demoOnly
															? "Demo Only"
															: entry.available
																? "Available"
																: "Unavailable on this platform"
													}
													icon={<ConnectionIcon />}
												>
													<CatalogConnectButton
														entry={entry}
														busy={busy}
														manual={() => (entry.importOnly ? importFile() : install(entry))}
													/>
												</ConnectionTile>
											))}
										</ul>
										{!available.length && (
											<p className="text-sm text-muted-foreground">
												{query
													? "No matching connections."
													: "Every catalog connection is installed."}
											</p>
										)}
									</>
								),
							},
						]
					: []),
			]}
		/>
	);
}
