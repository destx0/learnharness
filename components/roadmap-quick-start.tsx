"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MapIcon, SearchIcon, WaypointsIcon, XIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import { cn } from "@/lib/utils";

/**
 * ROADMAP QUICK START (2026-11-13).
 *
 * The roadmap.sh catalog as a read-mode entry point: suggested cards on the
 * read draft, and a searchable browser (from the read session's Roadmaps
 * chip) for jumping between any imported roadmap. Starting a roadmap opens
 * its seeded read session; an existing session for that roadmap opens
 * directly. The catalog is runtime data under data/roadmaps/catalog.json;
 * `preset` says a graph seed is imported.
 */

export interface RoadmapQuickItem {
	slug: string;
	title: string;
	type: string;
	category: string;
	subcategory: string;
	preset: boolean;
	existingChatId: string | null;
}

interface CatalogResponse {
	roadmaps: RoadmapQuickItem[];
	categories?: unknown[];
	missing?: boolean;
}

const SUGGESTED = [
	"angular",
	"react",
	"nodejs",
	"python",
	"devops",
	"system-design",
	"frontend",
	"backend",
	"full-stack",
	"docker",
	"kubernetes",
	"javascript",
];

function useCatalog(enabled = true) {
	const [data, setData] = useState<CatalogResponse | null>(null);
	const [loading, setLoading] = useState(enabled);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		setLoading(true);
		void fetch("/api/roadmaps", { cache: "no-store" })
			.then((res) => res.ok ? res.json() as Promise<CatalogResponse> : Promise.reject(new Error("catalog")))
			.then((body) => {
				if (cancelled) return;
				setData(body);
				setFailed(false);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => { cancelled = true; };
	}, [enabled]);
	return { data, loading, failed };
}

/** Shared start/open behavior: open an existing roadmap session, or create
 *  a seeded read session and hand the opening prompt to the chat page. */
function useRoadmapLauncher(onNavigating?: () => void) {
	const router = useRouter();
	const [starting, setStarting] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const launch = async (item: RoadmapQuickItem) => {
		if (item.existingChatId) {
			onNavigating?.();
			router.push(`/chat/${item.existingChatId}`);
			return;
		}
		setStarting(item.slug);
		setError(null);
		try {
			const response = await fetch("/api/chats", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: item.title, kind: "read", roadmapSlug: item.slug }),
			});
			if (!response.ok) throw new Error("create");
			const body = (await response.json()) as { id?: unknown };
			if (typeof body.id !== "string") throw new Error("id");
			if (!stashOpeningPrompt(body.id, item.title)) throw new Error("stash");
			onNavigating?.();
			router.push(`/chat/${body.id}`);
		} catch {
			setError("Couldn’t start that roadmap. Try again.");
			setStarting(null);
		}
	};
	return { launch, starting, error };
}

function typeLabel(item: RoadmapQuickItem): string {
	return item.type === "role" ? "Role roadmap" : item.type === "best-practice" ? "Best practice" : "Skill roadmap";
}

function RoadmapCard({
	item,
	starting,
	onLaunch,
	compact = false,
}: {
	item: RoadmapQuickItem;
	starting: boolean;
	onLaunch: (item: RoadmapQuickItem) => void;
	compact?: boolean;
}) {
	const open = Boolean(item.existingChatId);
	return (
		<button
			type="button"
			onClick={() => onLaunch(item)}
			disabled={starting}
			data-testid={`roadmap-card-${item.slug}`}
			className={cn(
				"group flex cursor-pointer flex-col items-start rounded-lg border border-border/70 bg-card/60 text-left transition-colors hover:border-border hover:bg-accent/40 disabled:cursor-default disabled:opacity-60",
				compact ? "min-h-[3.6rem] px-2.5 py-2" : "min-h-[4.6rem] px-3 py-2.5",
			)}
		>
			<span className="flex w-full items-center gap-1.5">
				<span className={cn("min-w-0 flex-1 truncate font-ui font-medium", compact ? "text-[11px]" : "text-xs")}>
					{item.title}
				</span>
				{item.preset && <WaypointsIcon className="size-3 shrink-0 text-muted-foreground/70" aria-label="Graph preset" />}
			</span>
			<span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{typeLabel(item)}</span>
			<span className="mt-auto block font-ui text-[9px] uppercase tracking-widest text-muted-foreground/60">
				{starting ? "Starting…" : open ? "Open" : "Start"}
			</span>
		</button>
	);
}

export function RoadmapBrowser({
	open,
	onClose,
	catalog,
}: {
	open: boolean;
	onClose: () => void;
	catalog?: CatalogResponse | null;
}) {
	const { data: fetched, loading, failed } = useCatalog(!catalog);
	const data = catalog ?? fetched;
	const [query, setQuery] = useState("");
	const { launch, starting, error } = useRoadmapLauncher(onClose);
	const roadmaps = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return (data?.roadmaps ?? []).filter((item) =>
			!needle || [item.title, item.category, item.subcategory, item.slug].some((value) => value.toLowerCase().includes(needle)),
		);
	}, [data, query]);
	const groups = useMemo(() => {
		const byCategory = new Map<string, RoadmapQuickItem[]>();
		for (const item of roadmaps) {
			const key = item.category || "Other";
			const list = byCategory.get(key) ?? [];
			list.push(item);
			byCategory.set(key, list);
		}
		return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
	}, [roadmaps]);

	return (
		<HostDialog
			open={open}
			onClose={() => { onClose(); return "closed"; }}
			aria-label="Roadmaps"
			backdropProps={{
				"data-testid": "roadmap-browser",
				className: "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
			}}
			frame={<div className="flex h-[min(82vh,48rem)] w-full max-w-[56rem] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl" onClick={(event) => event.stopPropagation()} />}
		>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
				<MapIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span className="font-title text-lg tracking-tight">Roadmaps</span>
				<span className="font-ui text-[10px] uppercase tracking-widest text-muted-foreground/60">
					{data?.roadmaps.length ?? 0} from roadmap.sh
				</span>
				<div className="relative ml-auto min-w-[12rem] flex-1 sm:max-w-xs">
					<SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search roadmaps"
						aria-label="Search roadmaps"
						className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-xs outline-none transition-colors focus:border-foreground/30"
					/>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close roadmaps"
					className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
				{error && <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
				{loading ? (
					<p className="py-8 text-center text-sm text-muted-foreground">Loading roadmaps…</p>
				) : failed || data?.missing ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						The roadmap catalog is not imported yet. Run <code className="rounded bg-muted px-1">npm run roadmap:catalog</code>.
					</p>
				) : groups.length === 0 ? (
					<p className="py-8 text-center text-sm text-muted-foreground">No roadmaps match “{query}”.</p>
				) : (
					groups.map(([category, items]) => (
						<section key={category} className="mb-4">
							<h3 className="mb-1.5 font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">{category}</h3>
							<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
								{items.map((item) => (
									<RoadmapCard key={item.slug} item={item} starting={starting === item.slug} onLaunch={(next) => void launch(next)} />
								))}
							</div>
						</section>
					))
				)}
			</div>
			<div className="shrink-0 border-t border-border/60 px-4 py-2 font-ui text-[10px] uppercase tracking-widest text-muted-foreground/60">
				<span className="normal-case tracking-normal">Open a roadmap to start (or resume) a read session</span>
			</div>
		</HostDialog>
	);
}

export function RoadmapQuickStart() {
	const { data, loading, failed } = useCatalog();
	const [browserOpen, setBrowserOpen] = useState(false);
	const { launch, starting, error } = useRoadmapLauncher();
	const suggested = useMemo(() => {
		const items = data?.roadmaps ?? [];
		const bySlug = new Map(items.map((item) => [item.slug, item]));
		const open = items.filter((item) => item.existingChatId).slice(0, 3);
		const picked = SUGGESTED.map((slug) => bySlug.get(slug)).filter((item): item is RoadmapQuickItem => Boolean(item));
		const seen = new Set<string>();
		return [...open, ...picked].filter((item) => {
			if (seen.has(item.slug)) return false;
			seen.add(item.slug);
			return true;
		}).slice(0, 8);
	}, [data]);

	if (failed) return null;
	return (
		<section className="pointer-events-auto mx-auto w-full max-w-[46rem] px-4 pb-4" data-testid="roadmap-quick-start">
			<div className="mb-2 flex items-baseline justify-between gap-3">
				<span className="font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80">
					Start from a roadmap
				</span>
				<a
					href="https://roadmap.sh/roadmaps"
					target="_blank"
					rel="noreferrer"
					className="font-ui text-[10px] uppercase tracking-widest text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline"
				>
					roadmap.sh
				</a>
			</div>
			{error && <p role="alert" className="mb-2 text-xs text-destructive">{error}</p>}
			{loading ? (
				<p className="py-3 text-xs text-muted-foreground">Loading roadmaps…</p>
			) : data?.missing ? (
				<p className="py-3 text-xs text-muted-foreground">
					The roadmap catalog is not imported yet. Run <code className="rounded bg-muted px-1">npm run roadmap:catalog</code>.
				</p>
			) : (
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					{suggested.map((item) => (
						<RoadmapCard key={item.slug} item={item} starting={starting === item.slug} onLaunch={(next) => void launch(next)} compact />
					))}
				</div>
			)}
			<button
				type="button"
				onClick={() => setBrowserOpen(true)}
				className="mt-2 cursor-pointer font-ui text-[10px] uppercase tracking-widest text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline"
			>
				Browse all {data?.roadmaps.length ?? 0} roadmaps
			</button>
			{browserOpen && (
				<RoadmapBrowser open onClose={() => setBrowserOpen(false)} catalog={data} />
			)}
		</section>
	);
}
