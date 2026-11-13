"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	ArrowLeftIcon,
	ArrowUpRightIcon,
	BookOpenIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	HashIcon,
	HelpCircleIcon,
	PanelLeftIcon,
	PlusIcon,
	RefreshCwIcon,
	SparklesIcon,
	TriangleAlertIcon,
	WaypointsIcon,
	XIcon,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { SessionMermaidContext } from "@/components/session-overlay";
import {
	studyDocumentBreadcrumb,
	studyDocumentById,
	studyDocumentCanGoDeeper,
	studyDocumentList,
	studyDocumentStatus,
	studyDocumentWordCount,
	STUDY_ROOT_DOCUMENT_ID,
	type StudyDocument,
	type StudySectionQuestion,
	type StudyTopicSuggestion,
} from "@/src/core";
import { cn } from "@/lib/utils";
import { ReadGraphView } from "./read-graph";
import { isRoadmapDocument, RoadmapGraphView } from "./read-roadmap-graph";

/**
 * THE READING PANE (read sessions, owner 2026-11-04; deeper tree 2026-11-12).
 *
 * The living study document lives on the ChatRecord; this pane renders it as
 * a navigable reading surface beside the conversation. Data flow:
 *
 *   edit_document / suggest_deeper (server) → saveDocument
 *   → document-changed event → ReadPane refetches /api/chats/:id/document
 *   → the latest documents render
 *
 * The event is separate from record-changed on purpose: a mid-turn document
 * write must update this pane without touching the client's streaming
 * message state. turn-settled is a second refetch for settlement (a child
 * document's writing status becomes ready/failed there). Reconnect resync
 * covers a dropped SSE connection.
 *
 * Deeper documents form a tree: a chapter's suggested topic either opens an
 * existing document or writes a child. The pane switches to the child
 * immediately (its pending state is already in the record), so the learner
 * watches sections land. The tree drawer is the map; the optional graph
 * view adds cross-links and the whole shape.
 *
 * The VIEW is split from the data wrapper (ReadDocumentView vs ReadPane) so
 * render tests can pin the reading surface without the events provider.
 */

export interface ReadPaneProps {
	chatId: string;
	initialDocument: StudyDocument | null;
	initialDocuments?: StudyDocument[];
	initialReadingDocumentId?: string | null;
	/** The session title — the pane's fallback title before the first doc. */
	sessionTitle: string;
	/** A document edit is currently being written (the live tool card). */
	writing: boolean;
	onClose?: () => void;
	/** Placement utilities (the Chat owns the main-vs-overlay rule). */
	className?: string;
}

function documentList(initialDocument: StudyDocument | null, initialDocuments: readonly StudyDocument[]): StudyDocument[] {
	const docs: StudyDocument[] = [];
	if (initialDocument) docs.push(initialDocument);
	for (const doc of initialDocuments) if (!docs.some((d) => d.id === doc.id)) docs.push(doc);
	return docs;
}

function recordOf(documents: readonly StudyDocument[]): { document?: StudyDocument; documents: StudyDocument[] } {
	const root = documents.find((doc) => !doc.parent || !documents.some((candidate) => candidate.id === doc.parent!.documentId))
		?? documents[0];
	return { document: root, documents: documents.filter((doc) => doc.id !== root?.id) };
}

export function ReadPane({
	chatId,
	initialDocument,
	initialDocuments = [],
	initialReadingDocumentId = null,
	sessionTitle,
	writing,
	onClose,
	className,
}: ReadPaneProps) {
	const [documents, setDocuments] = useState<StudyDocument[]>(() => documentList(initialDocument, initialDocuments));
	const [activeId, setActiveId] = useState(() => {
		const docs = documentList(initialDocument, initialDocuments);
		if (initialReadingDocumentId && docs.some((doc) => doc.id === initialReadingDocumentId)) return initialReadingDocumentId;
		return initialDocument?.id ?? docs[0]?.id ?? STUDY_ROOT_DOCUMENT_ID;
	});
	const [treeOpen, setTreeOpen] = useState(false);
	const [view, setView] = useState<"read" | "graph">("read");
	const [suggestingKey, setSuggestingKey] = useState<string | null>(null);
	const [generatingKey, setGeneratingKey] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [focusSectionId, setFocusSectionId] = useState<string | null>(null);
	const activeIdRef = useRef(activeId);
	const scrollTops = useRef(new Map<string, number>());
	const requestRef = useRef(0);
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const activeSent = useRef<string | null>(null);

	useEffect(() => {
		activeIdRef.current = activeId;
	}, [activeId]);

	const refresh = useCallback(async () => {
		const request = ++requestRef.current;
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/document`, { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as {
				document?: StudyDocument | null;
				documents?: StudyDocument[];
				readingDocumentId?: string | null;
			};
			if (request !== requestRef.current) return;
			const next = documentList(body.document ?? null, body.documents ?? []);
			setDocuments(next);
			if (!next.some((doc) => doc.id === activeIdRef.current)) {
				const fallback = body.readingDocumentId && next.some((doc) => doc.id === body.readingDocumentId)
					? body.readingDocumentId
					: next[0]?.id ?? STUDY_ROOT_DOCUMENT_ID;
				setActiveId(fallback);
			}
		} catch {
			/* transient — turn-settled / reconnect resync is the net */
		}
	}, [chatId]);

	const scheduleRefresh = useCallback(() => {
		if (refreshTimer.current) clearTimeout(refreshTimer.current);
		refreshTimer.current = setTimeout(() => {
			refreshTimer.current = null;
			void refresh();
		}, 120);
	}, [refresh]);

	useServerEvent("document-changed", (p) => {
		if (p.chatId !== chatId) return;
		setSuggestingKey(null);
		setGeneratingKey(null);
		scheduleRefresh();
	});
	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		setSuggestingKey(null);
		setGeneratingKey(null);
		void refresh();
	});
	useServerResync(() => {
		void refresh();
	});
	// One mount fetch settles both edges: the page seed may be stale after a
	// pane collapse/expand, and a first write may have landed between the
	// server render and hydration. Events handle the live path.
	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(() => () => {
		if (refreshTimer.current) clearTimeout(refreshTimer.current);
	}, []);

	// Chat steers the open document. This is view state on the record, so
	// the next turn's hidden context marker names the right target.
	useEffect(() => {
		if (activeSent.current === activeId) return;
		if (!documents.some((doc) => doc.id === activeId)) return;
		activeSent.current = activeId;
		void fetch(`/api/chats/${encodeURIComponent(chatId)}/document/active`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ documentId: activeId }),
		}).catch(() => {
			activeSent.current = null;
		});
	}, [activeId, chatId, documents]);

	const record = useMemo(() => recordOf(documents), [documents]);
	const active = studyDocumentById(record, activeId) ?? record.document;
	const canGoDeeper = active ? studyDocumentCanGoDeeper(record, active.id) : false;

	const openDocument = (documentId: string, sectionId?: string) => {
		if (!documents.some((doc) => doc.id === documentId)) return;
		setView("read");
		setNotice(null);
		setFocusSectionId(sectionId ?? null);
		if (documentId !== activeId) setActiveId(documentId);
		setTreeOpen(false);
	};

	const suggest = async (documentId: string, sectionId: string) => {
		const key = `${documentId}:${sectionId}`;
		if (suggestingKey || generatingKey) return;
		setSuggestingKey(key);
		setNotice(null);
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/document/suggest`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ documentId, sectionId }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setNotice(body.error ?? "Could not start the deeper-topic suggestions.");
				setSuggestingKey(null);
			}
		} catch {
			setNotice("Could not reach the server.");
			setSuggestingKey(null);
		}
	};

	const goDeeper = async (documentId: string, sectionId: string, topicId: string) => {
		if (suggestingKey || generatingKey) return;
		setGeneratingKey(`${documentId}:${sectionId}:${topicId}`);
		setNotice(null);
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/document/deeper`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ documentId, sectionId, topicId }),
			});
			const body = (await res.json().catch(() => ({}))) as { error?: string; childDocument?: StudyDocument | null };
			if (!res.ok) {
				setNotice(body.error ?? "Could not start this topic.");
				setGeneratingKey(null);
				return;
			}
			if (body.childDocument) {
				const child = body.childDocument;
				setDocuments((current) => current.some((doc) => doc.id === child.id)
					? current.map((doc) => doc.id === child.id ? child : doc)
					: [...current, child]);
				setView("read");
				setFocusSectionId(null);
				setActiveId(child.id);
				setTreeOpen(false);
			}
			setGeneratingKey(null);
		} catch {
			setNotice("Could not reach the server.");
			setGeneratingKey(null);
		}
	};

	const retryDocument = (doc: StudyDocument) => {
		if (!doc.parent) return;
		void goDeeper(doc.parent.documentId, doc.parent.sectionId, doc.parent.topicId);
	};

	const removeRelated = async (documentId: string, targetDocumentId: string, targetSectionId?: string) => {
		setNotice(null);
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/document/related/remove`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ documentId, targetDocumentId, ...(targetSectionId ? { targetSectionId } : {}) }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setNotice(body.error ?? "Could not remove that link.");
			}
		} catch {
			setNotice("Could not reach the server.");
		}
	};

	return (
		<ReadDocumentView
			documents={documents}
			activeDocumentId={active?.id ?? activeId}
			sessionTitle={sessionTitle}
			writing={writing}
			view={view}
			treeOpen={treeOpen}
			focusSectionId={focusSectionId}
			initialScrollTop={scrollTops.current.get(active?.id ?? activeId) ?? 0}
			suggestingKey={suggestingKey}
			notice={notice}
			canGoDeeper={canGoDeeper}
			onToggleTree={() => setTreeOpen((open) => !open)}
			onOpenDocument={openDocument}
			onSuggest={(documentId, sectionId) => void suggest(documentId, sectionId)}
			onGoDeeper={(documentId, sectionId, topicId) => void goDeeper(documentId, sectionId, topicId)}
			onRetryDocument={retryDocument}
			onRemoveRelated={(documentId, targetDocumentId, targetSectionId) => void removeRelated(documentId, targetDocumentId, targetSectionId)}
			onOpenGraph={() => setView("graph")}
			onOpenReading={() => setView("read")}
			onScroll={(documentId, top) => scrollTops.current.set(documentId, top)}
			onClose={onClose}
			className={className}
		/>
	);
}

/** Is a document edit being written right now? The live tool card's state
 *  is the signal — not the turn's busy flag: the agent may be answering a
 *  chat question without touching the document. */
export function documentWriteInFlight(
	messages: ReadonlyArray<{ role?: string; parts?: ReadonlyArray<{ type: string; state?: string }> }>,
): boolean {
	// Only the newest assistant message can be the live turn. Scanning older
	// messages would let a dangling input-streaming part from an aborted
	// historical turn pin "Writing…" on forever.
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const message = messages[mi];
		if (message?.role !== "assistant") continue;
		for (const part of message.parts ?? []) {
			if ((part.type === "tool-edit_document" || part.type === "tool-suggest_deeper") && (part.state === "input-streaming" || part.state === "input-available")) {
				return true;
			}
		}
		return false;
	}
	return false;
}

export function readMinutes(words: number): number {
	return Math.max(1, Math.round(words / 220));
}

export interface ReadDocumentViewProps {
	documents?: StudyDocument[];
	activeDocumentId?: string;
	sessionTitle: string;
	writing?: boolean;
	view?: "read" | "graph";
	treeOpen?: boolean;
	focusSectionId?: string | null;
	initialScrollTop?: number;
	suggestingKey?: string | null;
	notice?: string | null;
	canGoDeeper?: boolean;
	onToggleTree?: () => void;
	onOpenDocument?: (documentId: string, sectionId?: string) => void;
	onSuggest?: (documentId: string, sectionId: string) => void;
	onGoDeeper?: (documentId: string, sectionId: string, topicId: string) => void;
	onRetryDocument?: (doc: StudyDocument) => void;
	onRemoveRelated?: (documentId: string, targetDocumentId: string, targetSectionId?: string) => void;
	onOpenGraph?: () => void;
	onOpenReading?: () => void;
	onScroll?: (documentId: string, top: number) => void;
	onClose?: () => void;
	className?: string;
}

/** The pure reading surface (the render-test seam). */
export function ReadDocumentView({
	documents = [],
	activeDocumentId,
	sessionTitle,
	writing = false,
	view = "read",
	treeOpen = false,
	focusSectionId = null,
	initialScrollTop = 0,
	suggestingKey = null,
	notice = null,
	canGoDeeper = true,
	onToggleTree = () => {},
	onOpenDocument = () => {},
	onSuggest = () => {},
	onGoDeeper = () => {},
	onRetryDocument = () => {},
	onRemoveRelated = () => {},
	onOpenGraph = () => {},
	onOpenReading = () => {},
	onScroll = () => {},
	onClose,
	className,
}: ReadDocumentViewProps) {
	const record = useMemo(() => recordOf(documents), [documents]);
	const active = (activeDocumentId ? studyDocumentById(record, activeDocumentId) : null) ?? record.document;
	const roadmapRoot = isRoadmapDocument(record.document) ? record.document : null;
	const breadcrumb = active ? studyDocumentBreadcrumb(record, active.id) : [];
	const parent = breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 2] : null;
	const sections = active?.sections ?? [];
	const words = studyDocumentWordCount(active);
	const minutes = readMinutes(words);
	const activeStatus = active ? studyDocumentStatus(active) : "ready";
	const isWriting = writing || activeStatus === "writing";

	return (
		<aside
			data-testid="read-pane"
			aria-label="Study document"
			className={cn("flex min-h-0 flex-col bg-background", className)}
		>
			{/* The header aligns with the chat's TopBar (h-15) so the split's
			    top edge is one line. Drag surface; the buttons carve. */}
			<header className="lh-drag flex h-15 shrink-0 items-center gap-2 border-b border-border px-3">
				<HintlessButton
					label={treeOpen ? "Hide contents" : "Show contents"}
					onClick={onToggleTree}
					testId="read-pane-tree-toggle"
					pressed={treeOpen}
				>
					<PanelLeftIcon className="size-4" />
				</HintlessButton>
				{parent && (
					<HintlessButton label="Back to the previous document" onClick={() => onOpenDocument(parent.id)} testId="read-pane-back">
						<ArrowLeftIcon className="size-4" />
					</HintlessButton>
				)}
				<BookOpenIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div
						data-testid="read-pane-breadcrumb"
						className="flex min-w-0 items-center gap-1 overflow-hidden font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80"
					>
						{breadcrumb.length > 1 ? breadcrumb.map((doc, index) => (
							<span key={doc.id} className="flex min-w-0 items-center gap-1">
								{index > 0 && <span className="text-muted-foreground/40" aria-hidden>/</span>}
								{index === breadcrumb.length - 1 ? (
									<span className="truncate text-muted-foreground">{doc.title || "Untitled"}</span>
								) : (
									<button
										type="button"
										onClick={() => onOpenDocument(doc.id)}
										className="lh-no-drag max-w-[12rem] cursor-pointer truncate rounded-sm text-left transition-colors hover:text-foreground"
									>
										{doc.title || "Untitled"}
									</button>
								)}
							</span>
						)) : <span>Study document</span>}
					</div>
					<h2 className="truncate font-title text-lg leading-tight tracking-tight">
						{active?.title?.trim() || sessionTitle || "Study guide"}
					</h2>
				</div>
				{sections.length > 0 && (
					<span className="hidden shrink-0 font-ui text-[11px] text-muted-foreground sm:inline">
						{sections.length} {sections.length === 1 ? "section" : "sections"} · {minutes} min
					</span>
				)}
				{isWriting && (
					<span className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-muted-foreground">
						<BrailleSpinner label="Writing the document" />
						Writing…
					</span>
				)}
				<HintlessButton
					label={view === "graph" ? "Back to reading" : "Open the topic graph"}
					onClick={view === "graph" ? onOpenReading : onOpenGraph}
					testId="read-pane-graph-toggle"
					pressed={view === "graph"}
				>
					{view === "graph" ? <BookOpenIcon className="size-4" /> : <WaypointsIcon className="size-4" />}
				</HintlessButton>
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						aria-label="Close document"
						data-testid="read-pane-close"
						className="lh-no-drag flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-4" />
					</button>
				)}
			</header>

			<div className="relative flex min-h-0 flex-1">
				{treeOpen && (
					<>
						<button
							type="button"
							aria-label="Close contents"
							onClick={onToggleTree}
							className="absolute inset-0 z-10 cursor-default bg-background/35 backdrop-blur-[1px]"
						/>
						<nav
							aria-label="Contents"
							data-testid="read-pane-toc"
							className="absolute inset-y-0 left-0 z-20 w-72 max-w-[85%] overflow-y-auto border-r border-border bg-background shadow-xl"
						>
							<div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
								<span className="font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80">
									Contents
								</span>
								<button
									type="button"
									onClick={onToggleTree}
									aria-label="Close contents"
									className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									<XIcon className="size-3.5" />
								</button>
							</div>
							<StudyTree
								record={record}
								activeDocumentId={active?.id ?? ""}
								onOpenDocument={onOpenDocument}
								onGoDeeper={onGoDeeper}
							/>
						</nav>
					</>
				)}

				{view === "graph" ? (
					roadmapRoot ? (
						<RoadmapGraphView
							root={roadmapRoot}
							documents={documents}
							activeDocumentId={active?.id ?? ""}
							onOpenDocument={onOpenDocument}
							onGoDeeper={onGoDeeper}
							className="min-w-0 flex-1"
						/>
					) : (
						<ReadGraphView
							documents={documents}
							activeDocumentId={active?.id ?? ""}
							onOpenDocument={onOpenDocument}
							onGoDeeper={onGoDeeper}
							className="min-w-0 flex-1"
						/>
					)
				) : sections.length === 0 ? (
					<EmptyDocument
						document={active}
						sessionTitle={sessionTitle}
						writing={isWriting}
						onRetry={active ? () => onRetryDocument(active) : undefined}
						onBack={parent ? () => onOpenDocument(parent.id) : undefined}
					/>
				) : (
					<div className="flex min-h-0 min-w-0 flex-1">
						<ReadArticle
							key={active!.id}
							document={active!}
							documents={documents}
							record={record}
							notice={notice}
							suggestingKey={suggestingKey}
							canGoDeeper={canGoDeeper}
							focusSectionId={focusSectionId}
							initialScrollTop={initialScrollTop}
							onOpenDocument={onOpenDocument}
							onSuggest={onSuggest}
							onGoDeeper={onGoDeeper}
							onRemoveRelated={onRemoveRelated}
							onScroll={onScroll}
						/>
					</div>
				)}
			</div>
		</aside>
	);
}

function HintlessButton({
	label,
	onClick,
	testId,
	pressed,
	children,
}: {
	label: string;
	onClick: () => void;
	testId: string;
	pressed?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			aria-pressed={pressed}
			data-testid={testId}
			className={cn(
				"lh-no-drag flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
				pressed ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

function EmptyDocument({
	document,
	sessionTitle,
	writing,
	onRetry,
	onBack,
}: {
	document: StudyDocument | null | undefined;
	sessionTitle: string;
	writing: boolean;
	onRetry?: () => void;
	onBack?: () => void;
}) {
	const failed = document ? studyDocumentStatus(document) === "failed" : false;
	const title = document?.title?.trim() || sessionTitle;
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center" data-testid="read-pane-empty">
			{failed ? (
				<TriangleAlertIcon className="size-8 text-muted-foreground/40" aria-hidden="true" />
			) : (
				<BookOpenIcon className="size-8 text-muted-foreground/40" aria-hidden="true" />
			)}
			<div className="font-title text-xl tracking-tight">
				{failed ? "This topic could not be written" : writing ? "Preparing your topic…" : document ? "No sections yet" : "No document yet"}
			</div>
			<p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
				{failed
					? `The agent stopped before writing "${title}". You can retry, or go back to the chapter it came from.`
					: writing
						? `The agent is writing "${title}". Its sections will appear here as they land.`
						: document
							? "Ask for an expansion in the conversation, or go back to the chapter you came from."
							: "The guide will appear here as the agent writes it. You can ask for expansions in the conversation."}
			</p>
			<div className="flex items-center gap-2">
				{failed && onRetry && (
					<button
						type="button"
						onClick={onRetry}
						className="cursor-pointer rounded-md border border-border px-3 py-1.5 font-ui text-xs transition-colors hover:bg-accent"
					>
						Retry this topic
					</button>
				)}
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						className="cursor-pointer rounded-md px-3 py-1.5 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						Back to the chapter
					</button>
				)}
			</div>
		</div>
	);
}

function StudyTree({
	record,
	activeDocumentId,
	onOpenDocument,
	onGoDeeper,
}: {
	record: { document?: StudyDocument; documents: StudyDocument[] };
	activeDocumentId: string;
	onOpenDocument: (documentId: string, sectionId?: string) => void;
	onGoDeeper: (documentId: string, sectionId: string, topicId: string) => void;
}) {
	const docs = studyDocumentList(record);
	const breadcrumb = activeDocumentId ? studyDocumentBreadcrumb(record, activeDocumentId) : [];
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set([
		...(record.document ? [record.document.id] : []),
		...breadcrumb.map((doc) => doc.id),
	]));
	useEffect(() => {
		setExpanded((current) => {
			const next = new Set(current);
			next.add(activeDocumentId);
			for (const doc of breadcrumb) next.add(doc.id);
			if (next.size === current.size) return current;
			return next;
		});
	}, [activeDocumentId]);
	const childrenOf = (documentId: string, sectionId?: string) => docs.filter((doc) =>
		doc.parent?.documentId === documentId && (sectionId === undefined || doc.parent.sectionId === sectionId),
	);
	const roots = docs.filter((doc) => !doc.parent || !studyDocumentById(record, doc.parent.documentId));
	const seen = new Set<string>();
	const renderDoc = (doc: StudyDocument, depth: number): ReactNode => {
		if (seen.has(doc.id)) return null;
		seen.add(doc.id);
		const isOpen = expanded.has(doc.id);
		const status = studyDocumentStatus(doc);
		const childrenWithoutSection = childrenOf(doc.id).filter((child) =>
			!doc.sections.some((section) => section.id === child.parent?.sectionId),
		);
		return (
			<div key={doc.id}>
				<div className="flex items-center gap-0.5 pr-2" style={{ paddingLeft: 6 + depth * 12 }}>
					<button
						type="button"
						onClick={() => setExpanded((current) => {
							const next = new Set(current);
							if (next.has(doc.id)) next.delete(doc.id);
							else next.add(doc.id);
							return next;
						})}
						aria-label={isOpen ? `Collapse ${doc.title}` : `Expand ${doc.title}`}
						className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						{isOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
					</button>
					<button
						type="button"
						onClick={() => onOpenDocument(doc.id)}
						aria-current={doc.id === activeDocumentId ? "true" : undefined}
						className={cn(
							"flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left font-ui text-xs leading-snug transition-colors",
							doc.id === activeDocumentId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
						)}
					>
						{doc.parent ? <HashIcon className="size-3 shrink-0 opacity-70" /> : <BookOpenIcon className="size-3 shrink-0 opacity-70" />}
						<span className="truncate">{doc.title || "Untitled"}</span>
						{status === "writing" && <BrailleSpinner label="Writing" />}
						{status === "failed" && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-destructive" aria-label="Failed" />}
					</button>
				</div>
				{isOpen && (
					<div>
						{doc.sections.map((section) => (
							<div key={section.id}>
								<button
									type="button"
									onClick={() => onOpenDocument(doc.id, section.id)}
									className="flex w-full cursor-pointer items-center gap-1.5 rounded-sm py-1 pr-2 text-left font-ui text-[11px] leading-snug text-muted-foreground/80 transition-colors hover:bg-accent/60 hover:text-foreground"
									style={{ paddingLeft: 34 + depth * 12 }}
								>
									<span className="truncate">{section.heading}</span>
								</button>
								{childrenOf(doc.id, section.id).map((child) => renderDoc(child, depth + 1))}
								{(section.suggestions ?? [])
									.filter((topic) => !topic.documentId && !childrenOf(doc.id, section.id).some((child) => child.parent?.topicId === topic.id))
									.map((topic) => (
										<button
											key={`${section.id}:${topic.id}`}
											type="button"
											onClick={() => onGoDeeper(doc.id, section.id, topic.id)}
											className="flex w-full cursor-pointer items-center gap-1.5 rounded-sm py-1 pr-2 text-left font-ui text-[11px] leading-snug text-muted-foreground/60 transition-colors hover:bg-accent/60 hover:text-foreground"
											style={{ paddingLeft: 34 + (depth + 1) * 12 }}
											title={topic.blurb}
										>
											<SparklesIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
											<span className="truncate">{topic.heading}</span>
										</button>
									))}
							</div>
						))}
						{childrenWithoutSection.map((child) => renderDoc(child, depth + 1))}
						{doc.sections.length === 0 && status === "writing" && (
							<div className="py-1 font-ui text-[11px] italic text-muted-foreground/70" style={{ paddingLeft: 34 + depth * 12 }}>
								Writing the first sections…
							</div>
						)}
					</div>
				)}
			</div>
		);
	};
	return (
		<div className="py-2">
			{roots.map((doc) => renderDoc(doc, 0))}
			{docs.filter((doc) => !seen.has(doc.id)).map((doc) => renderDoc(doc, 0))}
		</div>
	);
}

function ReadArticle({
	document,
	documents,
	record,
	notice,
	suggestingKey,
	canGoDeeper,
	focusSectionId,
	initialScrollTop,
	onOpenDocument,
	onSuggest,
	onGoDeeper,
	onRemoveRelated,
	onScroll,
}: {
	document: StudyDocument;
	documents: StudyDocument[];
	record: { document?: StudyDocument; documents: StudyDocument[] };
	notice: string | null;
	suggestingKey: string | null;
	canGoDeeper: boolean;
	focusSectionId: string | null;
	initialScrollTop: number;
	onOpenDocument: (documentId: string, sectionId?: string) => void;
	onSuggest: (documentId: string, sectionId: string) => void;
	onGoDeeper: (documentId: string, sectionId: string, topicId: string) => void;
	onRemoveRelated: (documentId: string, targetDocumentId: string, targetSectionId?: string) => void;
	onScroll: (documentId: string, top: number) => void;
}) {
	const sections = document.sections;
	const scrollRef = useRef<HTMLDivElement>(null);
	const [activeId, setActiveId] = useState<string | null>(sections[0]?.id ?? null);

	// Restore this document's place; a fresh document starts at the top.
	useLayoutEffect(() => {
		const root = scrollRef.current;
		if (root) root.scrollTop = initialScrollTop;
	}, []);
	useEffect(() => {
		if (!focusSectionId) return;
		const root = scrollRef.current;
		const el = root?.querySelector<HTMLElement>(`[data-section-id="${focusSectionId}"]`);
		el?.scrollIntoView({ behavior: "smooth", block: "start" });
		setActiveId(focusSectionId);
	}, [focusSectionId, sections.length]);

	// Keep the active highlight honest when a section is removed or the
	// first document arrives after mount.
	useEffect(() => {
		if (sections.length === 0) {
			setActiveId(null);
			return;
		}
		if (!sections.some((s) => s.id === activeId)) setActiveId(sections[0]!.id);
	}, [sections, activeId]);

	// Active-section tracking: the quick-nav highlights the section at the
	// top of the reading viewport. Root-scoped, so the pane's own scroll is
	// the only thing that moves it (the chat's scroll stays independent).
	useEffect(() => {
		const root = scrollRef.current;
		if (!root || sections.length === 0) return;
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((e) => e.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
				const id = (visible?.target as HTMLElement | undefined)?.dataset.sectionId;
				if (id) setActiveId(id);
			},
			{ root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
		);
		for (const section of sections) {
			const el = root.querySelector<HTMLElement>(`[data-section-id="${section.id}"]`);
			if (el) observer.observe(el);
		}
		return () => observer.disconnect();
	}, [sections]);

	const scrollTo = (id: string) => {
		const el = scrollRef.current?.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
		el?.scrollIntoView({ behavior: "smooth", block: "start" });
		setActiveId(id);
	};

	const related = (document.related ?? []).flatMap((link) => {
		const target = studyDocumentById(record, link.documentId);
		if (!target) return [];
		const section = link.sectionId ? target.sections.find((candidate) => candidate.id === link.sectionId) : undefined;
		if (link.sectionId && !section) return [];
		return [{ link, target, section }];
	});

	return (
		<div
			ref={scrollRef}
			data-testid="read-pane-scroll"
			className="min-w-0 flex-1 overflow-y-auto"
			onScroll={(event) => onScroll(document.id, event.currentTarget.scrollTop)}
		>
			{/* Narrow-pane contents: a sticky chapter chip row, same section
			    targets as the tree. Hidden on wide screens where the tree is
			    the primary map. */}
			<div className="sticky top-0 z-10 flex gap-1.5 overflow-x-auto border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
				{sections.map((section) => (
					<button
						key={section.id}
						type="button"
						onClick={() => scrollTo(section.id)}
						aria-current={activeId === section.id ? "true" : undefined}
						className={cn(
							"shrink-0 cursor-pointer rounded-full border px-2.5 py-0.5 font-ui text-[11px] transition-colors",
							activeId === section.id
								? "border-border bg-accent text-foreground"
								: "border-border/60 text-muted-foreground hover:text-foreground",
						)}
					>
						{section.heading}
					</button>
				))}
			</div>
			{notice && (
				<p role="status" className="mx-auto mt-4 w-full max-w-[48rem] rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
					{notice}
				</p>
			)}
			<article className="mx-auto w-full max-w-[48rem] px-8 py-10">
				{sections.map((section, i) => (
					<section
						key={section.id}
						id={`read-section-${section.id}`}
						data-section-id={section.id}
						className={cn("scroll-mt-16", i > 0 && "mt-12 border-t border-border/50 pt-10")}
					>
						<h3 className="mb-3 font-title text-xl leading-snug tracking-tight">{section.heading}</h3>
						<div className="lh-prose">
							{/* Mermaid renders inline; the chat's full-screen focus
							    overlay lives in the chat column, so the pane opts out
							    of the expand affordance rather than opening a focus
							    the pane would hide on narrow screens. */}
							<SessionMermaidContext.Provider value={null}>
								<MessageResponse>{section.body}</MessageResponse>
							</SessionMermaidContext.Provider>
						</div>
						<SelfCheck questions={section.questions ?? []} />
						<SectionDirections
							document={document}
							sectionId={section.id}
							sectionHeading={section.heading}
							suggestions={section.suggestions ?? []}
							docs={documents}
							suggestingKey={suggestingKey}
							canGoDeeper={canGoDeeper}
							collapsed={document.roadmap !== undefined && (section.suggestions ?? []).some((topic) => topic.roadmap !== undefined)}
							onSuggest={onSuggest}
							onGoDeeper={onGoDeeper}
							onOpenDocument={onOpenDocument}
						/>
					</section>
				))}
				{related.length > 0 && (
					<section className="mt-12 border-t border-border/50 pt-8" data-testid="read-pane-related">
						<div className="mb-3 font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80">
							Related topics
						</div>
						<div className="grid gap-2">
							{related.map(({ link, target, section }) => (
								<div key={`${link.documentId}:${link.sectionId ?? ""}`} className="group flex items-stretch gap-1">
									<button
										type="button"
										onClick={() => onOpenDocument(target.id, section?.id)}
										className="min-w-0 flex-1 cursor-pointer rounded-md border border-border/60 px-3 py-2 text-left transition-colors hover:border-border hover:bg-accent/40"
									>
										<span className="flex items-center gap-1.5 font-ui text-xs font-medium">
											{target.title || "Untitled"}
											{section && <span className="font-normal text-muted-foreground">· {section.heading}</span>}
											<ArrowUpRightIcon className="size-3 shrink-0 text-muted-foreground" />
										</span>
										<span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{link.reason}</span>
									</button>
									<button
										type="button"
										onClick={() => onRemoveRelated(document.id, link.documentId, link.sectionId)}
										aria-label="Remove related link"
										className="flex w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
									>
										<XIcon className="size-3.5" />
									</button>
								</div>
							))}
						</div>
					</section>
				)}
			</article>
		</div>
	);
}

function SelfCheck({ questions }: { questions: readonly StudySectionQuestion[] }) {
	if (questions.length === 0) return null;
	return (
		// Native details: collapsed by default, keyboard-accessible, no state.
		<details className="group mt-6 rounded-md border border-border/60" data-testid="read-section-questions">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80 [&::-webkit-details-marker]:hidden">
				<HelpCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
				Check yourself
				<span className="font-normal normal-case tracking-normal text-muted-foreground/60">
					{questions.length} {questions.length === 1 ? "question" : "questions"}
				</span>
				<ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-180" aria-hidden="true" />
			</summary>
			<div className="space-y-2 border-t border-border/50 p-3">
				{questions.map((entry, index) => (
					<details key={entry.id} className="group/q rounded-md border border-border/50 bg-background/60">
						<summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2 text-sm leading-relaxed [&::-webkit-details-marker]:hidden">
							<span className="font-ui text-[10px] text-muted-foreground/60" aria-hidden="true">{index + 1}.</span>
							<span className="min-w-0 flex-1">{entry.question}</span>
							<ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open/q:rotate-180" aria-hidden="true" />
						</summary>
						<div className="lh-prose border-t border-border/50 px-3 py-2 text-sm">
							<SessionMermaidContext.Provider value={null}>
								<MessageResponse>{entry.answer}</MessageResponse>
							</SessionMermaidContext.Provider>
						</div>
					</details>
				))}
			</div>
		</details>
	);
}

function SectionDirections({
	document,
	sectionId,
	sectionHeading,
	suggestions,
	docs,
	suggestingKey,
	canGoDeeper,
	collapsed = false,
	onSuggest,
	onGoDeeper,
	onOpenDocument,
}: {
	document: StudyDocument;
	sectionId: string;
	sectionHeading: string;
	suggestions: readonly StudyTopicSuggestion[];
	docs: readonly StudyDocument[];
	suggestingKey: string | null;
	canGoDeeper: boolean;
	collapsed?: boolean;
	onSuggest: (documentId: string, sectionId: string) => void;
	onGoDeeper: (documentId: string, sectionId: string, topicId: string) => void;
	onOpenDocument: (documentId: string, sectionId?: string) => void;
}) {
	const key = `${document.id}:${sectionId}`;
	const suggesting = suggestingKey === key;
	if (suggestions.length === 0 && !canGoDeeper) return null;
	const children = docs.filter((doc) =>
		doc.parent?.documentId === document.id && doc.parent.sectionId === sectionId,
	);
	const cards = suggestions.length > 0 ? (
		<div className="grid gap-2 sm:grid-cols-2">
			{suggestions.map((topic) => {
				const child = children.find((doc) =>
					doc.parent?.sectionId === sectionId && doc.parent.topicId === topic.id,
				);
				const existing = topic.documentId ? docs.find((doc) => doc.id === topic.documentId) : undefined;
				const target = child ?? existing;
				const status = child ? studyDocumentStatus(child) : null;
				return (
					<button
						key={topic.id}
						type="button"
						onClick={() => {
							if (child && status === "failed") onGoDeeper(document.id, sectionId, topic.id);
							else if (target) onOpenDocument(target.id, topic.sectionId);
							else onGoDeeper(document.id, sectionId, topic.id);
						}}
						className="group flex min-h-16 cursor-pointer flex-col items-start gap-1 rounded-md border border-border/60 px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent/40"
					>
						<span className="flex w-full items-center gap-1.5 font-ui text-xs font-medium">
							<span className="min-w-0 flex-1 truncate">{topic.heading}</span>
							{status === "writing" ? (
								<BrailleSpinner label="Writing" />
							) : status === "failed" ? (
								<TriangleAlertIcon className="size-3 shrink-0 text-destructive" />
							) : target ? (
								<ArrowUpRightIcon className="size-3 shrink-0 text-muted-foreground" />
							) : (
								<PlusIcon className="size-3 shrink-0 text-muted-foreground" />
							)}
						</span>
						<span className="text-xs leading-relaxed text-muted-foreground">{topic.blurb}</span>
						<span className="font-ui text-[10px] uppercase tracking-widest text-muted-foreground/50">
							{status === "writing" ? "Writing…" : status === "failed" ? "Retry" : target ? "Open topic" : "Write this topic"}
						</span>
					</button>
				);
			})}
		</div>
	) : null;
	if (collapsed && suggestions.length > 0) {
		return (
			<details className="group mt-6 rounded-md border border-border/60" data-testid="read-roadmap-subtopics">
				<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70 [&::-webkit-details-marker]:hidden">
					<WaypointsIcon className="size-3.5 shrink-0" aria-hidden="true" />
					Roadmap subtopics
					<span className="font-normal normal-case tracking-normal text-muted-foreground/60">{suggestions.length}</span>
					<ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-180" aria-hidden="true" />
				</summary>
				<div className="border-t border-border/50 p-3">{cards}</div>
			</details>
		);
	}
	return (
		<div className="mt-6" data-testid="read-section-deeper">
			<div className="flex items-center gap-2">
				<span className="font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
					Go deeper
				</span>
				{suggestions.length > 0 && canGoDeeper && (
					<button
						type="button"
						onClick={() => onSuggest(document.id, sectionId)}
						disabled={suggesting}
						aria-label={`Suggest new directions for ${sectionHeading}`}
						className="flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40"
					>
						<RefreshCwIcon className={cn("size-3", suggesting && "animate-spin")} />
					</button>
				)}
				<span className="h-px flex-1 bg-border/50" />
			</div>
			{suggesting ? (
				<div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
					<BrailleSpinner label="Thinking of directions" />
					Thinking of directions…
				</div>
			) : suggestions.length > 0 ? (
				<div className="mt-3">{cards}</div>
			) : (
				<button
					type="button"
					onClick={() => onSuggest(document.id, sectionId)}
					className="mt-3 flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border/70 px-3 py-1.5 font-ui text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent/30 hover:text-foreground"
				>
					<SparklesIcon className="size-3.5" />
					Suggest deeper topics
				</button>
			)}
		</div>
	);
}
