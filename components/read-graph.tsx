"use client";

/**
 * THE TOPIC GRAPH (read sessions, 2026-11-12).
 *
 * A map of the deeper-document tree the read pane grows: document nodes,
 * their chapter nodes, the "deeper" edges from a chapter to the child
 * document it spawned, and dashed agent-authored related links. Read view
 * is the primary surface; this is the overview toggle.
 *
 * Placement is dagre (the same Sugiyama engine as the plan block), left to
 * right: a document, its chapters, then the documents those chapters grew.
 * Related links are drawn after placement so they never bend the tree.
 * Hand-built SVG throughout, with the shared pan/zoom math.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { graphlib } from "dagre-d3-es";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { studyDocumentStatus, type StudyDocument, type StudyDocumentStatus } from "@/src/core";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "./pan-zoom";

export interface ReadGraphNode {
	id: string;
	kind: "document" | "section" | "suggestion";
	documentId: string;
	sectionId?: string;
	topicId?: string;
	label: string;
	status?: StudyDocumentStatus;
	/** The document's generation depth (0 = root). */
	depth: number;
}

export interface ReadGraphEdge {
	id: string;
	from: string;
	to: string;
	kind: "contains" | "deeper" | "related" | "suggestion";
	reason?: string;
}

export interface ReadGraphData {
	nodes: ReadGraphNode[];
	edges: ReadGraphEdge[];
}

const DOC_WIDTH = 200;
const DOC_HEIGHT = 62;
const SECTION_WIDTH = 176;
const SECTION_HEIGHT = 40;
const SUGGESTION_WIDTH = 164;
const SUGGESTION_HEIGHT = 32;

export function readGraphNodeId(documentId: string, sectionId?: string): string {
	return sectionId ? `sec:${documentId}:${sectionId}` : `doc:${documentId}`;
}

/** Pure projection of the document tree into graph nodes and edges. */
export function buildReadGraph(documents: readonly StudyDocument[]): ReadGraphData {
	const byId = new Map(documents.map((doc) => [doc.id, doc]));
	const nodes: ReadGraphNode[] = [];
	const edges: ReadGraphEdge[] = [];
	const generatedTopics = new Set<string>();
	for (const doc of documents) {
		if (doc.parent) generatedTopics.add(`${doc.parent.documentId}\u0000${doc.parent.sectionId}\u0000${doc.parent.topicId}`);
	}
	const depthOf = (doc: StudyDocument): number => {
		let depth = 0;
		let current: StudyDocument | undefined = doc;
		const seen = new Set<string>();
		while (current?.parent && !seen.has(current.id)) {
			seen.add(current.id);
			current = byId.get(current.parent.documentId);
			if (!current) break;
			depth++;
		}
		return depth;
	};
	for (const doc of documents) {
		const depth = depthOf(doc);
		nodes.push({
			id: readGraphNodeId(doc.id),
			kind: "document",
			documentId: doc.id,
			label: doc.title || "Untitled",
			status: studyDocumentStatus(doc),
			depth,
		});
		for (const section of doc.sections) {
			const sectionNode = readGraphNodeId(doc.id, section.id);
			nodes.push({
				id: sectionNode,
				kind: "section",
				documentId: doc.id,
				sectionId: section.id,
				label: section.heading,
				depth,
			});
			edges.push({ id: `contains:${doc.id}:${section.id}`, from: readGraphNodeId(doc.id), to: sectionNode, kind: "contains" });
		}
	}
	// A chapter spawns exactly the child whose parent link names it.
	const seenDeeper = new Set<string>();
	for (const doc of documents) {
		if (!doc.parent) continue;
		const parent = byId.get(doc.parent.documentId);
		if (!parent?.sections.some((section) => section.id === doc.parent!.sectionId)) continue;
		const from = readGraphNodeId(parent.id, doc.parent.sectionId);
		const to = readGraphNodeId(doc.id);
		const key = `${from}\u0000${to}`;
		if (seenDeeper.has(key)) continue;
		seenDeeper.add(key);
		edges.push({ id: `deeper:${from}:${to}`, from, to, kind: "deeper" });
	}
	// Ungenerated chapter suggestions are ghost nodes: the roadmap's next
	// level stays visible before the learner commits a turn to it.
	for (const doc of documents) {
		const depth = depthOf(doc);
		for (const section of doc.sections) {
			for (const topic of section.suggestions ?? []) {
				if (topic.documentId) continue; // already-written target is a real doc node
				if (generatedTopics.has(`${doc.id}\u0000${section.id}\u0000${topic.id}`)) continue;
				const nodeId = `sug:${doc.id}:${section.id}:${topic.id}`;
				nodes.push({
					id: nodeId,
					kind: "suggestion",
					documentId: doc.id,
					sectionId: section.id,
					topicId: topic.id,
					label: topic.heading,
					depth: depth + 1,
				});
				edges.push({
					id: `suggestion:${nodeId}`,
					from: readGraphNodeId(doc.id, section.id),
					to: nodeId,
					kind: "suggestion",
				});
			}
		}
	}
	// Agent-authored cross-links. Targets that vanished are dropped from
	// the view (the reading footer hides them too).
	const seenRelated = new Set<string>();
	for (const doc of documents) {
		for (const link of doc.related ?? []) {
			const target = byId.get(link.documentId);
			if (!target) continue;
			if (link.sectionId && !target.sections.some((section) => section.id === link.sectionId)) continue;
			const from = readGraphNodeId(doc.id);
			const to = readGraphNodeId(target.id, link.sectionId);
			if (from === to) continue;
			const key = `${from}\u0000${to}`;
			if (seenRelated.has(key)) continue;
			seenRelated.add(key);
			edges.push({ id: `related:${from}:${to}`, from, to, kind: "related", reason: link.reason });
		}
	}
	return { nodes, edges };
}

interface PlacedNode extends ReadGraphNode {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PlacedGraph {
	nodes: PlacedNode[];
	edges: Array<ReadGraphEdge & { path: string }>;
	width: number;
	height: number;
}

/** Deterministic dagre placement; related edges are routed after the tree
 *  layout so they cannot distort it. Pure apart from dagre. */
export function layoutReadGraph(data: ReadGraphData): PlacedGraph {
	const ids = new Set(data.nodes.map((node) => node.id));
	if (data.nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
	const g = new graphlib.Graph({ compound: false, multigraph: true });
	g.setGraph({ rankdir: "LR", nodesep: 16, ranksep: 74, marginx: 28, marginy: 28 });
	for (const node of data.nodes) {
		g.setNode(node.id, {
			width: node.kind === "document" ? DOC_WIDTH : node.kind === "section" ? SECTION_WIDTH : SUGGESTION_WIDTH,
			height: node.kind === "document" ? DOC_HEIGHT : node.kind === "section" ? SECTION_HEIGHT : SUGGESTION_HEIGHT,
		});
	}
	for (const edge of data.edges) {
		if (edge.kind === "related") continue;
		if (ids.has(edge.from) && ids.has(edge.to)) g.setEdge(edge.from, edge.to, { label: "", width: 0, height: 0 });
	}
	// (the d.ts marks opts required; the runtime ignores it)
	dagreLayout(g, undefined);
	const placed = new Map<string, PlacedNode>();
	for (const node of data.nodes) {
		const pos = g.node(node.id) as { x?: number; y?: number } | undefined;
		const width = node.kind === "document" ? DOC_WIDTH : node.kind === "section" ? SECTION_WIDTH : SUGGESTION_WIDTH;
		const height = node.kind === "document" ? DOC_HEIGHT : node.kind === "section" ? SECTION_HEIGHT : SUGGESTION_HEIGHT;
		placed.set(node.id, {
			...node,
			width,
			height,
			x: (pos?.x ?? 0) - width / 2,
			y: (pos?.y ?? 0) - height / 2,
		});
	}
	const minX = Math.min(...[...placed.values()].map((node) => node.x));
	const minY = Math.min(...[...placed.values()].map((node) => node.y));
	// Normalize to a small origin pad; the SVG transform owns pan/zoom.
	for (const node of placed.values()) {
		node.x += 28 - minX;
		node.y += 28 - minY;
	}
	const width = Math.max(...[...placed.values()].map((node) => node.x + node.width)) + 28;
	const height = Math.max(...[...placed.values()].map((node) => node.y + node.height)) + 28;
	const edges: Array<ReadGraphEdge & { path: string }> = [];
	for (const edge of data.edges) {
		const from = placed.get(edge.from);
		const to = placed.get(edge.to);
		if (!from || !to) continue;
		edges.push({ ...edge, path: edge.kind === "related" ? relatedPath(from, to, edge.id) : treePath(from, to) });
	}
	return { nodes: [...placed.values()], edges, width, height };
}

function rightMiddle(node: PlacedNode): { x: number; y: number } {
	return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function leftMiddle(node: PlacedNode): { x: number; y: number } {
	return { x: node.x, y: node.y + node.height / 2 };
}

function treePath(from: PlacedNode, to: PlacedNode): string {
	const a = rightMiddle(from);
	const b = leftMiddle(to);
	const bend = Math.max(28, Math.abs(b.x - a.x) * 0.45);
	return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}

function relatedPath(from: PlacedNode, to: PlacedNode, seed: string): string {
	const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
	const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy) || 1;
	let hash = 0;
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
	const offset = ((Math.abs(hash) % 44) - 22);
	const cx = (a.x + b.x) / 2 - (dy / length) * offset;
	const cy = (a.y + b.y) / 2 + (dx / length) * offset;
	return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function ReadGraphView({
	documents,
	activeDocumentId,
	onOpenDocument,
	onGoDeeper,
	className,
}: {
	documents: readonly StudyDocument[];
	activeDocumentId: string;
	onOpenDocument: (documentId: string, sectionId?: string) => void;
	onGoDeeper: (documentId: string, sectionId: string, topicId: string) => void;
	className?: string;
}) {
	const data = useMemo(() => buildReadGraph(documents), [documents]);
	const placed = useMemo(() => layoutReadGraph(data), [data]);
	const containerRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
	const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
	const movedRef = useRef(false);

	const viewportSize = useCallback(() => {
		const el = containerRef.current;
		return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
	}, []);
	const fit = useCallback(() => {
		const size = viewportSize();
		if (!size.w || !size.h || placed.width === 0) return;
		const box = { w: placed.width, h: placed.height };
		setView(fitGraphView(box, size, fitZoomFor(box, size)));
	}, [placed.height, placed.width, viewportSize]);
	useLayoutEffect(() => {
		fit();
	}, [fit]);

	// Wheel needs a non-passive native listener; React's onWheel can be
	// passive depending on the host, and the graph must not scroll the page.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const size = viewportSize();
			if (!size.w || !size.h || placed.width === 0) return;
			const box = { w: placed.width, h: placed.height };
			const rect = el.getBoundingClientRect();
			const focus = { x: event.clientX - rect.left, y: event.clientY - rect.top };
			const floor = fitZoomFor(box, size);
			setView((current) => zoomedGraphView(current, Math.exp(-event.deltaY * 0.0015), floor, focus, box, size));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [placed.height, placed.width, viewportSize]);

	const zoomBy = (factor: number) => {
		const size = viewportSize();
		if (!size.w || !size.h || placed.width === 0) return;
		const box = { w: placed.width, h: placed.height };
		const focus = { x: size.w / 2, y: size.h / 2 };
		setView((current) => zoomedGraphView(current, factor, fitZoomFor(box, size), focus, box, size));
	};

	const nodeClick = (node: ReadGraphNode) => {
		if (movedRef.current) return;
		if (node.kind === "suggestion" && node.sectionId && node.topicId) {
			onGoDeeper(node.documentId, node.sectionId, node.topicId);
			return;
		}
		onOpenDocument(node.documentId, node.sectionId);
	};

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)} data-testid="read-graph">
			<div className="flex h-10 shrink-0 items-center gap-3 border-b border-border/60 px-4">
				<span className="font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80">
					Topic graph
				</span>
				<span className="font-ui text-[11px] text-muted-foreground">
					{documents.length} {documents.length === 1 ? "document" : "documents"}
				</span>
				<div className="ml-auto flex items-center gap-1">
					<button
						type="button"
						onClick={() => zoomBy(1.2)}
						aria-label="Zoom in"
						className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={() => zoomBy(1 / 1.2)}
						aria-label="Zoom out"
						className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<MinusIcon className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={fit}
						aria-label="Fit graph"
						className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<MaximizeIcon className="size-3.5" />
					</button>
				</div>
			</div>
			<div
				ref={containerRef}
				data-testid="read-graph-canvas"
				className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
				onPointerDown={(event) => {
					// A press on a node is a click, not a pan. Without this
					// guard, pointer capture retargets the click to the canvas.
					movedRef.current = false;
					if ((event.target as Element | null)?.closest?.("[data-read-graph-node]")) return;
					dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					const drag = dragRef.current;
					if (!drag || drag.pointerId !== event.pointerId) return;
					const dx = event.clientX - drag.x;
					const dy = event.clientY - drag.y;
					if (Math.abs(dx) + Math.abs(dy) > 2) {
						drag.moved = true;
						movedRef.current = true;
					}
					drag.x = event.clientX;
					drag.y = event.clientY;
					setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
				}}
				onPointerUp={(event) => {
					if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
				}}
				onPointerCancel={() => { dragRef.current = null; }}
			>
				{data.nodes.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Go deeper from a chapter to grow the graph.
					</div>
				) : (
					<svg className="size-full" role="img" aria-label="Topic graph">
						<defs>
							<marker id="read-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
								<path d="M 0 0 L 8 4 L 0 8 z" fill="var(--border)" />
							</marker>
						</defs>
						<g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
							{placed.edges.map((edge) => (
								<path
									key={edge.id}
									d={edge.path}
									fill="none"
									stroke={edge.kind === "related" ? "var(--primary)" : "var(--border)"}
									strokeWidth={edge.kind === "related" ? 1 : 1.25}
									strokeDasharray={edge.kind === "related" || edge.kind === "suggestion" ? "4 4" : undefined}
									opacity={edge.kind === "related" ? 0.55 : edge.kind === "suggestion" ? 0.45 : 0.8}
									markerEnd={edge.kind === "deeper" ? "url(#read-graph-arrow)" : undefined}
								>
									{edge.reason ? <title>{edge.reason}</title> : null}
								</path>
							))}
							{placed.nodes.map((node) => {
								const active = node.documentId === activeDocumentId && node.kind === "document";
								const documentNode = node.kind === "document";
								const suggestionNode = node.kind === "suggestion";
								return (
									<g
										key={node.id}
										data-read-graph-node=""
										transform={`translate(${node.x} ${node.y})`}
										className="cursor-pointer"
										role="button"
										tabIndex={0}
										aria-label={node.label}
										onClick={() => nodeClick(node)}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												nodeClick(node);
											}
										}}
									>
										<title>{node.label}</title>
										<rect
											width={node.width}
											height={node.height}
											rx={documentNode ? 10 : 7}
											fill={suggestionNode ? "var(--background)" : "var(--card)"}
											stroke={active ? "var(--primary)" : "var(--border)"}
											strokeWidth={active ? 1.6 : 1}
											strokeDasharray={suggestionNode ? "4 3" : undefined}
											opacity={suggestionNode ? 0.8 : documentNode ? 1 : 0.92}
										/>
										<text
											x={suggestionNode ? 22 : 12}
											y={documentNode ? 25 : 21}
											fill={suggestionNode ? "var(--muted-foreground)" : "var(--foreground)"}
											fontSize={documentNode ? 12 : suggestionNode ? 10 : 11}
											fontFamily="var(--font-ui, ui-sans-serif)"
											fontWeight={documentNode ? 600 : 400}
										>
											{truncate(node.label, documentNode ? 27 : suggestionNode ? 24 : 25)}
										</text>
										{suggestionNode && (
											<text x={10} y={21} fill="var(--muted-foreground)" fontSize={11} fontFamily="var(--font-ui, ui-sans-serif)">+</text>
										)}
										{documentNode && (
											<>
												<circle
													cx={16}
													cy={43}
													r={3}
													fill={node.status === "failed" ? "var(--destructive)" : node.status === "writing" ? "var(--primary)" : "var(--muted-foreground)"}
													className={node.status === "writing" ? "animate-pulse" : undefined}
												/>
												<text
													x={25}
													y={47}
													fill="var(--muted-foreground)"
													fontSize={9}
													fontFamily="var(--font-ui, ui-sans-serif)"
													letterSpacing="0.06em"
													style={{ textTransform: "uppercase" }}
												>
													{node.status === "writing" ? "writing" : node.status === "failed" ? "failed" : `level ${node.depth}`}
												</text>
											</>
										)}
									</g>
								);
							})}
						</g>
					</svg>
				)}
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-4 py-2 font-ui text-[10px] uppercase tracking-widest text-muted-foreground/80">
				<span className="flex items-center gap-1.5"><span className="size-2 rounded-sm border border-border bg-card" /> Document</span>
				<span className="flex items-center gap-1.5"><span className="size-2 rounded-sm border border-border/80 bg-card/70" /> Chapter</span>
				<span className="flex items-center gap-1.5"><span className="h-px w-4 border-t border-dashed border-primary/70" /> Related</span>
				<span className="flex items-center gap-1.5"><span className="size-2 rounded-sm border border-dashed border-border bg-background" /> Suggested</span>
				<span className="ml-auto normal-case tracking-normal">Click a topic to open or write it</span>
			</div>
		</div>
	);
}
