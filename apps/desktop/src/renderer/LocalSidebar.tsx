import { Button } from "@repo/ui/components/button";
import { LogoMark } from "@repo/ui/components/logo";
import { ArrowLeft, LogIn, LogOut, Monitor, ShieldCheck, PanelLeft } from "lucide-react";

const link =
	"connector-sidebar-link min-h-11 md:min-h-9 gap-2 px-3 py-1.5 text-sm font-normal md:justify-start flex items-center justify-center rounded-lg w-full";

/** Connect's sidebar, reduced to the pages Desktop draws itself. */
export function LocalSidebar({
	account,
	section = "servers",
	pending = 0,
	onNavigate,
	collapsed,
	onToggle,
	onOpenLaplace,
	openLaplaceDisabled,
	onSignIn,
	signingIn,
	onSignOut,
}: {
	account?: { id: string; name: string };
	section?: string;
	pending?: number;
	onNavigate?: (section: "servers" | "credentials") => void;
	collapsed: boolean;
	onToggle: () => void;
	onOpenLaplace: () => void;
	openLaplaceDisabled: boolean;
	onSignIn: () => void;
	signingIn: boolean;
	onSignOut: () => void;
}) {
	return (
		<aside
			aria-label="Main sidebar"
			className="connector-main-sidebar min-h-0 bg-sidebar text-sidebar-foreground flex flex-col border-r"
		>
			<div className="min-h-0 space-y-3 p-2 py-3 md:p-4 flex-1 overflow-y-auto">
				<div className="connector-sidebar-heading">
					<span className="connector-home-link">
						<LogoMark className="size-6 shrink-0" />
						<span className="connector-main-label">Laplace</span>
					</span>
					<Button
						variant="ghost"
						size="icon"
						aria-label={collapsed ? "Expand main sidebar" : "Collapse main sidebar"}
						title={collapsed ? "Expand main sidebar" : "Collapse main sidebar"}
						aria-expanded={!collapsed}
						onClick={onToggle}
					>
						<PanelLeft className="size-4" />
					</Button>
				</div>
				<nav aria-label="Connector navigation" className="space-y-1">
					<ul className="gap-1 flex flex-col">
						{account && (
							<li>
								<button
									type="button"
									title="Back to Laplace"
									className={link}
									disabled={openLaplaceDisabled}
									onClick={onOpenLaplace}
								>
									<ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
									<span className="connector-main-label">Back to Laplace</span>
								</button>
							</li>
						)}
						<li>
							<button
								type="button"
								title="On this device"
								aria-current={section !== "credentials" ? "page" : undefined}
								className={link}
								onClick={() => onNavigate?.("servers")}
							>
								<Monitor className="size-4 shrink-0" aria-hidden="true" />
								<span className="connector-main-label">On this device</span>
							</button>
						</li>
						<li>
							<button
								type="button"
								title="Credentials"
								aria-current={section === "credentials" ? "page" : undefined}
								className={link}
								onClick={() => onNavigate?.("credentials")}
							>
								<ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
								<span className="connector-main-label">Credentials</span>
								{pending > 0 && <span aria-label={`${pending} pending requests`}>{pending}</span>}
							</button>
						</li>
					</ul>
				</nav>
			</div>
			<div className="connector-sidebar-footer p-2 md:p-5 border-t">
				{account ? (
					<>
						<p className="connector-main-label px-3 text-xs break-words text-muted-foreground">
							Signed in as {account.name}
						</p>
						<button type="button" title="Sign out" className={link} onClick={onSignOut}>
							<LogOut className="size-4 shrink-0" aria-hidden="true" />
							<span className="connector-main-label">Sign out</span>
						</button>
					</>
				) : (
					<button
						type="button"
						title="Sign in"
						className={link}
						disabled={signingIn}
						onClick={onSignIn}
					>
						<LogIn className="size-4 shrink-0" aria-hidden="true" />
						<span className="connector-main-label">Sign in</span>
					</button>
				)}
			</div>
		</aside>
	);
}
