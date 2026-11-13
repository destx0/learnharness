"use client";

/**
 * THE ROADMAP MAP (2026-11-13).
 *
 * The roadmap.sh-style layout for an imported roadmap root. Every main
 * topic is a card on a central primary spine, with its roadmap subtopics in
 * a muted group box to the left or right. Theme colors throughout. Unlike the compact
 * doc/chapter graph, this is the whole subject at a glance: all main
 * topics and all subtopics are present from the start. A subtopic without
 * a generated document is still clickable (it starts the deep-dive turn);
 * one with a child opens that child. Main topics open their section in the
 * root guide.
 *
 * Data comes from the seeded root document itself (sections + suggestions),
 * so the map needs no extra fetch. The `roadmap` field supplies track
 * grouping and the source link.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { studyDocumentStatus, type StudyDocument, type StudyDocumentStatus } from "@/src/core";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "./pan-zoom";

const PAD = 40;
const TITLE_H = 96;
const MAIN_W = 210;
const MAIN_H = 38;
const LEAF_W = 150;
const LEAF_H = 30;
const LEAF_GAP_X = 8;
const LEAF_GAP_Y = 6;
const BOX_PAD = 10;
const SPINE_GAP = 26;
const ROW_GAP = 30;
const TRACK_GAP = 24;

export interface RoadmapGraphTopicNode {
	id: string;
	kind: "topic";
	label: string;
	documentId: string;
	sectionId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	track?: string;
}

export interface RoadmapGraphSubtopicNode {
	id: string;
	kind: "subtopic";
	label: string;
	documentId: string;
	sectionId: string;
	topicId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	childDocumentId?: string;
	status?: StudyDocumentStatus;
}

export type RoadmapGraphNode = RoadmapGraphTopicNode | RoadmapGraphSubtopicNode;

export interface RoadmapGraphBox {
	id: string;
	topicId: string;
	side: "left" | "right";
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface RoadmapGraphLine {
	id: string;
	kind: "spine" | "branch";
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface RoadmapGraphTrackLabel {
	id: string;
	x: number;
	y: number;
	text: string;
}

export interface RoadmapGraphLayout {
	title: string;
	source?: string;
	nodes: RoadmapGraphNode[];
	boxes: RoadmapGraphBox[];
	lines: RoadmapGraphLine[];
	trackLabels: RoadmapGraphTrackLabel[];
	width: number;
	height: number;
	mainTopics: number;
	subtopics: number;
}

/** A roadmap root is the seeded document carrying the roadmap grouping and
 *  roadmap-pointed suggestions. Child documents never match. */
export function isRoadmapDocument(doc: StudyDocument | null | undefined): doc is StudyDocument {
	return Boolean(doc?.roadmap);
}

/** Pure projection of the seeded root into the roadmap.sh-style layout. */
export function buildRoadmapGraph(
	root: StudyDocument,
	documents: readonly StudyDocument[],
): RoadmapGraphLayout {
	const topicSections = root.sections.filter((section) => section.id !== "overview");
	const trackByTopic = new Map<string, string>();
	for (const track of root.roadmap?.tracks ?? []) {
		for (const topicId of track.topicIds) trackByTopic.set(topicId, track.title);
	}
	const children = new Map<string, StudyDocument>();
	for (const doc of documents) {
		if (doc.parent?.documentId === root.id) {
			children.set(`${doc.parent.sectionId}\u0000${doc.parent.topicId}`, doc);
		}
	}
	const specs = topicSections.map((section) => {
		const suggestions = section.suggestions ?? [];
		const count = suggestions.length;
		// A big topic splits into left and right group boxes like the
		// roadmap.sh poster (Networking & Protocols); small topics use one
		// box alternating sides.
		const split = count > 6;
		const half = split ? Math.ceil(count / 2) : count;
		const chunks = split
			? [suggestions.slice(0, half), suggestions.slice(half)]
			: [suggestions];
		const columns = Math.max(1, ...chunks.map((chunk) => chunk.length > 2 ? 2 : 1));
		const rows = Math.max(1, ...chunks.map((chunk) => Math.ceil(chunk.length / columns)));
		const boxWidth = count > 0 ? columns * LEAF_W + (columns - 1) * LEAF_GAP_X + 2 * BOX_PAD : 0;
		const boxHeight = count > 0 ? rows * LEAF_H + (rows - 1) * LEAF_GAP_Y + 2 * BOX_PAD : 0;
		return { section, suggestions, count, split, chunks, columns, boxWidth, boxHeight };
	});
	const maxBoxWidth = Math.max(0, ...specs.map((spec) => spec.boxWidth));
	const spineX = PAD + maxBoxWidth + SPINE_GAP + MAIN_W / 2;
	const width = spineX + maxBoxWidth + SPINE_GAP + MAIN_W / 2 + PAD;
	const nodes: RoadmapGraphNode[] = [];
	const boxes: RoadmapGraphBox[] = [];
	const lines: RoadmapGraphLine[] = [];
	const trackLabels: RoadmapGraphTrackLabel[] = [];
	let cursor = TITLE_H + 8;
	let previousCenter: number | null = null;
	let previousTrack: string | undefined;
	for (const [index, spec] of specs.entries()) {
		const track = trackByTopic.get(spec.section.id);
		if (index === 0 || track !== previousTrack) {
			cursor += TRACK_GAP;
			if (track) {
				trackLabels.push({ id: `track:${track}`, x: PAD, y: cursor - 12, text: track });
			}
			previousTrack = track;
		}
		const rowHeight = Math.max(spec.boxHeight, MAIN_H);
		const centerY = cursor + rowHeight / 2;
		const mainY = centerY - MAIN_H / 2;
		nodes.push({
			id: `topic:${spec.section.id}`,
			kind: "topic",
			label: spec.section.heading,
			documentId: root.id,
			sectionId: spec.section.id,
			x: spineX - MAIN_W / 2,
			y: mainY,
			width: MAIN_W,
			height: MAIN_H,
			...(track ? { track } : {}),
		});
		if (previousCenter !== null) {
			lines.push({
				id: `spine:${index}`,
				kind: "spine",
				x1: spineX,
				y1: previousCenter,
				x2: spineX,
				y2: centerY,
			});
		}
		const sides: Array<"left" | "right"> = spec.split
			? ["left", "right"]
			: [index % 2 === 0 ? "left" : "right"];
		for (const [sideIndex, side] of sides.entries()) {
			const chunk = spec.chunks[sideIndex] ?? [];
			if (chunk.length === 0) continue;
			const boxX = side === "left"
				? spineX - MAIN_W / 2 - SPINE_GAP - spec.boxWidth
				: spineX + MAIN_W / 2 + SPINE_GAP;
			const boxY = cursor;
			boxes.push({
				id: `box:${spec.section.id}:${side}`,
				topicId: spec.section.id,
				side,
				x: boxX,
				y: boxY,
				width: spec.boxWidth,
				height: spec.boxHeight,
			});
			lines.push({
				id: `branch:${spec.section.id}:${side}`,
				kind: "branch",
				x1: side === "left" ? spineX - MAIN_W / 2 : spineX + MAIN_W / 2,
				y1: centerY,
				x2: side === "left" ? boxX + spec.boxWidth : boxX,
				y2: centerY,
			});
			for (const [subIndex, suggestion] of chunk.entries()) {
				const column = subIndex % spec.columns;
				const row = Math.floor(subIndex / spec.columns);
				const child = children.get(`${spec.section.id}\u0000${suggestion.id}`);
				nodes.push({
					id: `subtopic:${spec.section.id}:${suggestion.id}`,
					kind: "subtopic",
					label: suggestion.heading,
					documentId: root.id,
					sectionId: spec.section.id,
					topicId: suggestion.id,
					x: boxX + BOX_PAD + column * (LEAF_W + LEAF_GAP_X),
					y: boxY + BOX_PAD + row * (LEAF_H + LEAF_GAP_Y),
					width: LEAF_W,
					height: LEAF_H,
					...(child ? { childDocumentId: child.id, status: studyDocumentStatus(child) } : {}),
				});
			}
		}
		previousCenter = centerY;
		cursor += rowHeight + ROW_GAP;
	}
	return {
		title: root.title,
		...(root.roadmap?.source ? { source: root.roadmap.source } : {}),
		nodes,
		boxes,
		lines,
		trackLabels,
		width,
		height: Math.max(cursor + PAD, TITLE_H + 80),
		mainTopics: specs.length,
		subtopics: specs.reduce((n, spec) => n + spec.count, 0),
	};
}

function truncate(value: string, max: number): string {
	const text = value.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function statusColor(status: StudyDocumentStatus | undefined): string | null {
	if (status === "ready") return "var(--primary)";
	if (status === "writing") return "var(--primary)";
	if (status === "failed") return "var(--destructive)";
	return null;
}

export function RoadmapGraphView({
	root,
	documents,
	activeDocumentId,
	onOpenDocument,
	onGoDeeper,
	className,
}: {
	root: StudyDocument;
	documents: readonly StudyDocument[];
	activeDocumentId: string;
	onOpenDocument: (documentId: string, sectionId?: string) => void;
	onGoDeeper: (documentId: string, sectionId: string, topicId: string) => void;
	className?: string;
}) {
	const layout = useMemo(() => buildRoadmapGraph(root, documents), [root, documents]);
	const activeTopic = activeDocumentId === root.id
		? null
		: documents.find((doc) => doc.id === activeDocumentId)?.parent?.sectionId ?? null;
	const activeChild = activeDocumentId === root.id ? null : activeDocumentId;
	const containerRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
	const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
	const movedRef = useRef(false);

	const viewportSize = useCallback(() => {
		const el = containerRef.current;
		return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
	}, []);
	const fitWidth = useCallback(() => {
		const size = viewportSize();
		if (!size.w || !size.h || layout.width === 0) return;
		const zoom = Math.min(1, (size.w - 24) / layout.width);
		setView({ zoom, x: (size.w - layout.width * zoom) / 2, y: 12 });
	}, [layout.width, viewportSize]);
	const fitAll = useCallback(() => {
		const size = viewportSize();
		if (!size.w || !size.h || layout.width === 0) return;
		const box = { w: layout.width, h: layout.height };
		setView(fitGraphView(box, size, fitZoomFor(box, size)));
	}, [layout.height, layout.width, viewportSize]);
	useLayoutEffect(() => {
		fitWidth();
	}, [fitWidth]);

	// Same non-passive wheel discipline as the compact graph: wheel zooms
	// the map, never scrolls the surrounding page.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const size = viewportSize();
			if (!size.w || !size.h || layout.width === 0) return;
			const box = { w: layout.width, h: layout.height };
			const rect = el.getBoundingClientRect();
			const focus = { x: event.clientX - rect.left, y: event.clientY - rect.top };
			const floor = fitZoomFor(box, size);
			setView((current) => zoomedGraphView(current, Math.exp(-event.deltaY * 0.0015), floor, focus, box, size));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [layout.height, layout.width, viewportSize]);

	const zoomBy = (factor: number) => {
		const size = viewportSize();
		if (!size.w || !size.h || layout.width === 0) return;
		const box = { w: layout.width, h: layout.height };
		const focus = { x: size.w / 2, y: size.h / 2 };
		setView((current) => zoomedGraphView(current, factor, fitZoomFor(box, size), focus, box, size));
	};

	const clickTopic = (node: RoadmapGraphTopicNode) => {
		if (movedRef.current) return;
		onOpenDocument(root.id, node.sectionId);
	};
	const clickSubtopic = (node: RoadmapGraphSubtopicNode) => {
		if (movedRef.current) return;
		if (node.childDocumentId) onOpenDocument(node.childDocumentId);
		else onGoDeeper(root.id, node.sectionId, node.topicId);
	};

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)} data-testid="read-roadmap-graph">
			<div className="flex h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-4">
				<span className="font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80">
					Topic map
				</span>
				<span className="font-ui text-[11px] text-muted-foreground">
					{layout.mainTopics} main topics · {layout.subtopics} subtopics
				</span>
				{layout.source && (
					<a
						href={layout.source}
						target="_blank"
						rel="noreferrer"
						className="font-ui text-[11px] text-primary underline-offset-2 hover:underline"
					>
						roadmap.sh
					</a>
				)}
				<div className="ml-auto flex items-center gap-1">
					<button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in" className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						<PlusIcon className="size-3.5" />
					</button>
					<button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						<MinusIcon className="size-3.5" />
					</button>
					<button type="button" onClick={fitWidth} aria-label="Fit width" title="Fit width" className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						<MaximizeIcon className="size-3.5" />
					</button>
					<button type="button" onClick={fitAll} aria-label="Fit whole map" title="Fit whole map" className="flex h-7 cursor-pointer items-center rounded-md px-1.5 font-ui text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						All
					</button>
				</div>
			</div>
			<div
				ref={containerRef}
				data-testid="read-roadmap-canvas"
				className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
				onPointerDown={(event) => {
					movedRef.current = false;
					if ((event.target as Element | null)?.closest?.("[data-roadmap-node]")) return;
					dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					const drag = dragRef.current;
					if (!drag || drag.pointerId !== event.pointerId) return;
					const dx = event.clientX - drag.x;
					const dy = event.clientY - drag.y;
					if (Math.abs(dx) + Math.abs(dy) > 2) movedRef.current = true;
					drag.x = event.clientX;
					drag.y = event.clientY;
					setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
				}}
				onPointerUp={(event) => {
					if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
				}}
				onPointerCancel={() => { dragRef.current = null; }}
			>
				<div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-md border border-border/60 bg-background/90 px-2.5 py-2 font-ui text-[10px] text-muted-foreground shadow-sm backdrop-blur">
					<span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-[2px] border border-border bg-card" /> Main topic</span>
					<span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-[2px] border border-border bg-background" /> Subtopic</span>
					<span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-primary" /> Generated</span>
					<span className="flex items-center gap-1.5"><span className="h-px w-4 border-t border-dashed border-primary/60" /> Suggested</span>
				</div>
				{layout.nodes.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						No roadmap topics yet.
					</div>
				) : (
					<svg className="size-full" role="img" aria-label={`${root.title} roadmap`}>
						<g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
							<text
								x={layout.width / 2}
								y={44}
								textAnchor="middle"
								fill="var(--foreground)"
								fontSize={30}
								fontWeight={700}
								fontFamily="var(--font-title, ui-serif, serif)"
							>
								{layout.title}
							</text>
							<text
								x={layout.width / 2}
								y={66}
								textAnchor="middle"
								fill="var(--muted-foreground)"
								fontSize={11}
								fontFamily="var(--font-ui, ui-sans-serif)"
							>
								{layout.mainTopics} main topics · {layout.subtopics} subtopics · click a card to read or write it
							</text>
							{layout.trackLabels.map((label) => (
								<g key={label.id}>
									<line x1={PAD} y1={label.y + 6} x2={layout.width - PAD} y2={label.y + 6} stroke="var(--border)" strokeDasharray="3 5" opacity={0.65} />
									<text
										x={PAD}
										y={label.y}
										fill="var(--muted-foreground)"
										fontSize={10}
										letterSpacing="0.1em"
										fontFamily="var(--font-ui, ui-sans-serif)"
										style={{ textTransform: "uppercase" }}
									>
										{label.text}
									</text>
								</g>
							))}
							{layout.lines.map((line) => (
								<line
									key={line.id}
									x1={line.x1}
									y1={line.y1}
									x2={line.x2}
									y2={line.y2}
									stroke="var(--primary)"
									strokeWidth={line.kind === "spine" ? 2.6 : 1.4}
									strokeDasharray={line.kind === "branch" ? "2 4" : undefined}
									strokeLinecap="round"
									opacity={line.kind === "branch" ? 0.5 : 0.75}
								/>
							))}
							{layout.boxes.map((box) => (
								<rect
									key={box.id}
									x={box.x}
									y={box.y}
									width={box.width}
									height={box.height}
									rx={8}
									fill="var(--muted)"
									fillOpacity={0.35}
									stroke="var(--border)"
									strokeWidth={1}
								/>
							))}
							{layout.nodes.map((node) => {
								if (node.kind === "topic") {
									const active = activeTopic === node.sectionId;
									return (
										<g
											key={node.id}
											data-roadmap-node=""
											transform={`translate(${node.x} ${node.y})`}
											className="cursor-pointer transition-opacity hover:opacity-80"
											role="button"
											tabIndex={0}
											aria-label={`Open ${node.label}`}
											onClick={() => clickTopic(node)}
											onKeyDown={(event) => {
												if (event.key === "Enter" || event.key === " ") {
													event.preventDefault();
													clickTopic(node);
												}
											}}
										>
											<title>{node.label}</title>
											<rect
												width={node.width}
												height={node.height}
												rx={5}
												fill="var(--card)"
												stroke={active ? "var(--primary)" : "var(--border)"}
												strokeWidth={active ? 2 : 1.2}
											/>
											<rect x={1} y={1} width={3.5} height={node.height - 2} rx={1.75} fill="var(--primary)" opacity={0.85} />
											<text
												x={14}
												y={24}
												fill="var(--foreground)"
												fontSize={12}
												fontWeight={600}
												fontFamily="var(--font-ui, ui-sans-serif)"
											>
												{truncate(node.label, 26)}
											</text>
										</g>
									);
								}
								const dot = statusColor(node.status);
								const active = activeChild !== null && node.childDocumentId === activeChild;
								return (
									<g
										key={node.id}
										data-roadmap-node=""
										transform={`translate(${node.x} ${node.y})`}
										className="cursor-pointer transition-opacity hover:opacity-80"
										role="button"
										tabIndex={0}
										aria-label={node.childDocumentId ? `Open ${node.label}` : `Write ${node.label}`}
										onClick={() => clickSubtopic(node)}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												clickSubtopic(node);
											}
										}}
									>
										<title>{node.label}</title>
										<rect
											width={node.width}
											height={node.height}
											rx={4}
											fill="var(--background)"
											stroke={active ? "var(--primary)" : "var(--border)"}
											strokeWidth={active ? 1.8 : 0.9}
										/>
										<text
											x={9}
											y={19}
											fill="var(--foreground)"
											fontSize={10}
											fontFamily="var(--font-ui, ui-sans-serif)"
										>
											{truncate(node.label, 23)}
										</text>
										{dot && (
											<circle
												cx={node.width - 9}
												cy={node.height / 2}
												r={3}
												fill={dot}
												className={node.status === "writing" ? "animate-pulse" : undefined}
											/>
										)}
									</g>
								);
							})}
						</g>
					</svg>
				)}
			</div>
			<div className="flex shrink-0 items-center border-t border-border/60 px-4 py-2 font-ui text-[10px] uppercase tracking-widest text-muted-foreground/80">
				<span className="ml-auto normal-case tracking-normal">Drag to pan · wheel to zoom</span>
			</div>
		</div>
	);
}
