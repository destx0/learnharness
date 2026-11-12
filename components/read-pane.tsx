"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpenIcon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { SessionMermaidContext } from "@/components/session-overlay";
import { studyDocumentWordCount, type StudyDocument } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * THE READING PANE (read sessions, owner 2026-11-04).
 *
 * The living study document lives on the ChatRecord; this pane renders it as
 * a navigable reading surface beside the conversation. Data flow:
 *
 *   edit_document (server) → saveDocument → document-changed event
 *   → ReadPane refetches /api/chats/:id/document → the latest guide renders
 *
 * The event is separate from record-changed on purpose: a mid-turn document
 * write must update this pane without touching the client's streaming
 * message state. turn-settled is a second, belt-and-suspenders refetch for a
 * missed event; reconnect resync covers a dropped SSE connection.
 *
 * The VIEW is split from the data wrapper (ReadDocumentView vs ReadPane) so
 * render tests can pin the reading surface without the events provider.
 */

export interface ReadPaneProps {
	chatId: string;
	initialDocument: StudyDocument | null;
	/** The session title — the pane's fallback title before the first doc. */
	sessionTitle: string;
	/** A document edit is currently being written (the live tool card). */
	writing: boolean;
	onClose: () => void;
	/** Placement/width utilities (the Chat owns the split-vs-overlay rule). */
	className?: string;
}

export function ReadPane({ chatId, initialDocument, sessionTitle, writing, onClose, className }: ReadPaneProps) {
	const [document, setDocument] = useState<StudyDocument | null>(initialDocument);
	// document-changed and turn-settled can overlap; only the newest request
	// may land, or an older response could overwrite a fresh edit.
	const requestRef = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++requestRef.current;
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/document`);
			if (!res.ok) return;
			const body = (await res.json()) as { document?: StudyDocument | null };
			if (request !== requestRef.current) return;
			setDocument(body.document ?? null);
		} catch {
			/* transient — turn-settled / reconnect resync is the net */
		}
	}, [chatId]);
	useServerEvent("document-changed", (p) => {
		if (p.chatId === chatId) void refresh();
	});
	useServerEvent("turn-settled", (p) => {
		if (p.chatId === chatId) void refresh();
	});
	useServerResync(() => {
		void refresh();
	});
	// One mount fetch settles both edges: the page seed may be stale after a
	// pane collapse/expand, and a first write may have landed between the
	// server render and hydration. Events handle the live path.
	useEffect(() => {
		void refresh();
	}, []);
	return (
		<ReadDocumentView
			document={document}
			sessionTitle={sessionTitle}
			writing={writing}
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
			if (part.type === "tool-edit_document" && (part.state === "input-streaming" || part.state === "input-available")) {
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

/** The pure reading surface (the render-test seam). */
export function ReadDocumentView({
	document,
	sessionTitle,
	writing,
	onClose,
	className,
}: {
	document: StudyDocument | null;
	sessionTitle: string;
	writing: boolean;
	onClose: () => void;
	className?: string;
}) {
	const sections = document?.sections ?? [];
	const title = document?.title?.trim() || sessionTitle || "Study guide";
	const words = studyDocumentWordCount(document);
	const minutes = readMinutes(words);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [activeId, setActiveId] = useState<string | null>(sections[0]?.id ?? null);

	// Keep the TOC highlight honest when a section is removed or the first
	// document arrives after mount.
	useEffect(() => {
		if (sections.length === 0) {
			setActiveId(null);
			return;
		}
		if (!sections.some((s) => s.id === activeId)) setActiveId(sections[0]!.id);
	}, [sections, activeId]);

	// Active-section tracking: the TOC highlights the section at the top of
	// the reading viewport. Root-scoped, so the pane's own scroll is the
	// only thing that moves it (the chat's scroll stays independent).
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

	return (
		<aside
			data-testid="read-pane"
			aria-label="Study document"
			className={cn("flex min-h-0 flex-col border-l border-border bg-background", className)}
		>
			{/* The header aligns with the chat's TopBar (h-15) so the split's
			    top edge is one line. Drag surface; the close button carves. */}
			<header className="lh-drag flex h-15 shrink-0 items-center gap-2.5 border-b border-border px-4">
				<BookOpenIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div className="font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80">
						Study document
					</div>
					<h2 className="truncate font-title text-lg leading-tight tracking-tight">{title}</h2>
				</div>
				{sections.length > 0 && (
					<span className="hidden shrink-0 font-ui text-[11px] text-muted-foreground sm:inline">
						{sections.length} {sections.length === 1 ? "section" : "sections"} · {minutes} min
					</span>
				)}
				{writing && (
					<span className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-muted-foreground">
						<BrailleSpinner label="Writing the document" />
						Writing…
					</span>
				)}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close document"
					data-testid="read-pane-close"
					className="lh-no-drag flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</header>

			{sections.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center" data-testid="read-pane-empty">
					<BookOpenIcon className="size-8 text-muted-foreground/40" aria-hidden="true" />
					<div className="font-title text-xl tracking-tight">
						{writing ? "Preparing your guide…" : "No document yet"}
					</div>
					<p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
						{writing
							? "The agent is writing the first summary of the topic."
							: "The guide will appear here as the agent writes it. You can ask for expansions in the conversation."}
					</p>
				</div>
			) : (
				<div className="flex min-h-0 flex-1">
					{/* Wide-pane TOC rail. Hidden on narrow panes where the
					    horizontal chip row above the prose takes over. */}
					<nav
						aria-label="Contents"
						data-testid="read-pane-toc"
						className="hidden w-36 shrink-0 overflow-y-auto border-r border-border/70 px-2.5 py-5 2xl:block"
					>
						<div className="mb-2 px-1.5 font-ui text-[10px] font-medium uppercase tracking-widest text-muted-foreground/80">
							Contents
						</div>
						<ul className="space-y-0.5">
							{sections.map((section) => (
								<li key={section.id}>
									<button
										type="button"
										onClick={() => scrollTo(section.id)}
										aria-current={activeId === section.id ? "true" : undefined}
										className={cn(
											"w-full cursor-pointer rounded-sm px-1.5 py-1 text-left font-ui text-xs leading-snug transition-colors",
											activeId === section.id
												? "bg-accent text-foreground"
												: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
										)}
									>
										{section.heading}
									</button>
								</li>
							))}
						</ul>
					</nav>

					<div ref={scrollRef} data-testid="read-pane-scroll" className="min-w-0 flex-1 overflow-y-auto">
						{/* Narrow-pane contents: a sticky chip row, same section
						    targets as the rail. */}
						<div className="sticky top-0 z-10 flex gap-1.5 overflow-x-auto border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur 2xl:hidden">
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
						<article className="mx-auto w-full max-w-[44rem] px-6 py-8">
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
								</section>
							))}
						</article>
					</div>
				</div>
			)}
		</aside>
	);
}
