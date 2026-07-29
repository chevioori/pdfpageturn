import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";

interface PDFPageTurnSettings {
	enabled: boolean;
}

const DEFAULT_SETTINGS: PDFPageTurnSettings = {
	enabled: true,
};

/** Kept clear of touch zones so an edge-swipe (Obsidian Mobile's swipe-to-go-back) can
 * always start uncontested by our overlay, in addition to us never calling
 * preventDefault() before a gesture is confirmed to be a tap. */
const EDGE_SAFE_MARGIN_PX = 24;

/** A touch that moves more than this, or lasts longer than this, is treated as a
 * scroll/swipe rather than a page-turn tap. */
const TAP_MAX_MOVEMENT_PX = 10;
const TAP_MAX_DURATION_MS = 400;

type PageDirection = 1 | -1;

export default class PDFPageTurnPlugin extends Plugin {
	settings: PDFPageTurnSettings;
	private overlays = new Map<WorkspaceLeaf, HTMLElement>();
	private pendingObservers = new Map<WorkspaceLeaf, MutationObserver>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PDFPageTurnSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => this.refreshAllOverlays());
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.refreshAllOverlays())
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.refreshAllOverlays())
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.refreshAllOverlays())
		);
	}

	onunload() {
		for (const overlay of this.overlays.values()) overlay.remove();
		this.overlays.clear();
		for (const observer of this.pendingObservers.values()) observer.disconnect();
		this.pendingObservers.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Attaches an overlay to every currently open PDF leaf and tears down overlays
	 * that no longer apply (leaf closed, view changed, or the feature was toggled off). */
	refreshAllOverlays(): void {
		const pdfLeaves = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view?.getViewType() === "pdf") pdfLeaves.add(leaf);
		});

		for (const [leaf, overlay] of this.overlays) {
			if (!pdfLeaves.has(leaf) || !this.settings.enabled || !overlay.isConnected) {
				overlay.remove();
				this.overlays.delete(leaf);
			}
		}

		for (const [leaf, observer] of this.pendingObservers) {
			if (!pdfLeaves.has(leaf) || !this.settings.enabled) {
				observer.disconnect();
				this.pendingObservers.delete(leaf);
			}
		}

		if (!this.settings.enabled) return;

		for (const leaf of pdfLeaves) {
			if (this.overlays.has(leaf) || this.pendingObservers.has(leaf)) continue;
			this.tryAttachOverlay(leaf);
		}
	}

	/** Attaches an overlay immediately if the PDF has finished rendering pages; otherwise
	 * (the leaf just opened and pdf.js hasn't rendered yet) watches for pages to appear
	 * and attaches as soon as they do. */
	private tryAttachOverlay(leaf: WorkspaceLeaf): void {
		const overlay = this.createOverlay(leaf);
		if (overlay) {
			this.overlays.set(leaf, overlay);
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const host: HTMLElement | undefined = (leaf.view as any)?.contentEl;
		if (!host) return;

		const observer = new MutationObserver(() => {
			const created = this.createOverlay(leaf);
			if (!created) return;
			observer.disconnect();
			this.pendingObservers.delete(leaf);
			this.overlays.set(leaf, created);
		});
		observer.observe(host, { childList: true, subtree: true });
		this.pendingObservers.set(leaf, observer);
	}

	/** Attaches the overlay to the PDF's actual scrollable content container (not the
	 * whole view), so it never covers Obsidian's toolbar or other chrome that lives
	 * outside that container. Returns null if the PDF hasn't rendered any pages yet. */
	private createOverlay(leaf: WorkspaceLeaf): HTMLElement | null {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = leaf.view as any;
		const host: HTMLElement | undefined = view?.contentEl;
		if (!host) return null;

		const located = this.locatePdfViewer(host);
		if (!located) return null;
		const { container } = located;

		if (getComputedStyle(container).position === "static") {
			container.addClass("pdf-page-turn-host");
		}
		container.style.setProperty("--pdf-page-turn-edge-margin", `${EDGE_SAFE_MARGIN_PX}px`);

		const overlay = container.createDiv({ cls: "pdf-page-turn-overlay" });
		const leftZone = overlay.createDiv({
			cls: "pdf-page-turn-zone pdf-page-turn-zone-left",
		});
		const rightZone = overlay.createDiv({
			cls: "pdf-page-turn-zone pdf-page-turn-zone-right",
		});

		this.attachZoneHandlers(leftZone, view, -1);
		this.attachZoneHandlers(rightZone, view, 1);

		return overlay;
	}

	private attachZoneHandlers(
		zone: HTMLElement,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		view: any,
		direction: PageDirection
	): void {
		let tracking = false;
		let startX = 0;
		let startY = 0;
		let startTime = 0;

		// touchstart/touchmove are passive (no preventDefault) so scrolling and any
		// system swipe-back gesture are never blocked while a gesture is in flight.
		zone.addEventListener(
			"touchstart",
			(e: TouchEvent) => {
				if (e.touches.length !== 1) {
					tracking = false;
					return;
				}
				const t = e.touches[0];
				startX = t.clientX;
				startY = t.clientY;
				startTime = Date.now();
				tracking = true;
			},
			{ passive: true }
		);

		zone.addEventListener(
			"touchmove",
			(e: TouchEvent) => {
				if (!tracking) return;
				const t = e.touches[0];
				if (
					Math.abs(t.clientX - startX) > TAP_MAX_MOVEMENT_PX ||
					Math.abs(t.clientY - startY) > TAP_MAX_MOVEMENT_PX
				) {
					// Movement beyond a tiny threshold means this is a scroll or swipe,
					// not a tap: stop tracking and let it behave exactly as it normally would.
					tracking = false;
				}
			},
			{ passive: true }
		);

		zone.addEventListener(
			"touchend",
			(e: TouchEvent) => {
				if (!tracking) return;
				tracking = false;
				if (Date.now() - startTime <= TAP_MAX_DURATION_MS) {
					// Only a confirmed quick tap prevents the default (ghost-click) behavior.
					e.preventDefault();
					this.turnPage(view, direction);
				}
			},
			{ passive: false }
		);

		zone.addEventListener(
			"touchcancel",
			() => {
				tracking = false;
			},
			{ passive: true }
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private turnPage(view: any, direction: PageDirection): void {
		const host: HTMLElement | undefined = view?.contentEl;
		if (!host) return;

		const located = this.locatePdfViewer(host);
		if (!located) return;
		const { container, pages } = located;

		const pageHeight = this.getCurrentPageHeight(pages, container);
		if (!pageHeight) return;

		const maxScroll = container.scrollHeight - container.clientHeight;
		const target = Math.min(
			Math.max(container.scrollTop + direction * pageHeight, 0),
			maxScroll
		);
		container.scrollTo({ top: target, behavior: "instant" });
	}

	/** pdf.js (the PDF renderer Obsidian embeds) always wraps rendered pages in
	 * `div.page[data-page-number]` elements; walking up from one to the nearest
	 * actually-scrollable ancestor finds the viewer's scroll container without
	 * depending on Obsidian's own, version-specific wrapper class names. This is also
	 * exactly the element the overlay attaches to, so it never covers surrounding
	 * chrome like the PDF toolbar. */
	private locatePdfViewer(
		host: HTMLElement
	): { container: HTMLElement; pages: NodeListOf<HTMLElement> } | null {
		const pages = host.querySelectorAll<HTMLElement>("div.page[data-page-number]");
		if (pages.length === 0) return null;

		// Walk up but never past `host`: escaping into ancestors outside the PDF view
		// could land on an unrelated scrollable element (e.g. the workspace shell).
		let el: HTMLElement | null = pages[0].parentElement;
		while (el && el !== host) {
			if (el.scrollHeight > el.clientHeight + 1) return { container: el, pages };
			el = el.parentElement;
		}

		// No narrower scrollable ancestor exists inside the view (e.g. a short PDF that
		// fits without scrolling, or layout hasn't settled yet) — fall back to the view's
		// own content element so the overlay still attaches instead of silently failing.
		return { container: host, pages };
	}

	/** Height of one page "slot" (page plus its inter-page margin), computed as the
	 * offset distance between the current page and the next page so that repeated
	 * taps land on exact page boundaries instead of drifting. */
	private getCurrentPageHeight(
		pages: NodeListOf<HTMLElement>,
		container: HTMLElement
	): number {
		const scrollTop = container.scrollTop;
		let currentIndex = 0;
		for (let i = 0; i < pages.length; i++) {
			if (pages[i].offsetTop <= scrollTop + 1) currentIndex = i;
			else break;
		}
		const current = pages[currentIndex];
		const next = pages[currentIndex + 1];
		return next ? next.offsetTop - current.offsetTop : current.offsetHeight;
	}
}

class PDFPageTurnSettingTab extends PluginSettingTab {
	plugin: PDFPageTurnPlugin;

	constructor(app: App, plugin: PDFPageTurnPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Enable tap-to-turn overlay")
			.setDesc(
				"When on, invisible touch zones are added over open PDFs: tap the right third of the screen to go to the next page, the left third for the previous page. The middle third is left untouched for normal PDF interaction."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAllOverlays();
				})
			);
	}
}
