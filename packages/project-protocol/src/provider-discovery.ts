// Standalone copy of the hosted provider ordering; Desktop has no gateway checkout.
export interface DiscoverableProvider {
	service: string;
	displayName: string;
}

const firstProviderService = "fusion-api";
const recommendedProviderServices = [
	"googlesheets",
	"gmail",
	"slack",
	"googlecalendar",
	"googledrive",
	"github",
	"notion",
	"hubspot",
	"googleforms",
	"airtable",
	"trello",
	"asana",
	"jira",
	"linear",
	"clickup",
	"monday",
	"googledocs",
	"googleslides",
	"dropbox",
	"box",
	"confluence",
	"outlook",
	"discord",
	"telegram",
	"twilio",
	"sendgrid",
	"mailchimp",
	"shopify",
	"stripe",
	"googleanalytics",
	"googlesearchconsole",
	"linkedin",
	"pipedrive",
	"zendesk",
	"intercom",
	"openai",
	"anthropic",
	"gemini",
	"perplexity",
	"deepseek",
	"gitlab",
	"dockerhub",
	"vercel",
	"cloudflareworker",
	"awss3",
	"cloudflarer2",
	"googlebigquery",
] as const;
const recommendedProviderServiceRank = new Map(
	recommendedProviderServices.map((service, index) => [compactProviderService(service), index]),
);

/** Order the provider browser's pinned and recommended apps before the alphabetical fallback. */
export function compareProvidersForDiscovery(
	left: DiscoverableProvider,
	right: DiscoverableProvider,
): number {
	const leftPinned = left.service === firstProviderService;
	const rightPinned = right.service === firstProviderService;
	if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
	const recommendedRank =
		getRecommendedProviderServiceRank(left.service) -
		getRecommendedProviderServiceRank(right.service);
	return recommendedRank || left.displayName.localeCompare(right.displayName);
}

function getRecommendedProviderServiceRank(service: string): number {
	return (
		recommendedProviderServiceRank.get(compactProviderService(service)) ?? Number.MAX_SAFE_INTEGER
	);
}

function compactProviderService(service: string): string {
	return service
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, "");
}
