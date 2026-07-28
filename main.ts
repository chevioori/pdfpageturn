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
			if (!pdfLeaves.has(leaf) || !this.settings.enabled) {
				overlay.remove();
				this.overlays.delete(leaf);
			}
		}

		if (!this.settings.enabled) return;

		for (const leaf of pdfLeaves) {
			if (!this.overlays.has(leaf)) {
				const overlay = this.createOverlay(leaf);
				if (overlay) this.overlays.set(leaf, overlay);
			}
		}
	}

	private createOverlay(leaf: WorkspaceLeaf): HTMLElement | null {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = leaf.view as any;
		const host: HTMLElement | undefined = view?.contentEl;
		if (!host) return null;

		if (getComputedStyle(host).position === "static") {
			host.addClass("pdf-page-turn-host");
		}
		host.style.setProperty("--pdf-page-turn-edge-margin", `${EDGE_SAFE_MARGIN_PX}px`);

		const overlay = host.createDiv({ cls: "pdf-page-turn-overlay" });
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

		const pages = host.querySelectorAll<HTMLElement>("div.page[data-page-number]");
		if (pages.length === 0) return;

		const container = this.findScrollContainer(pages[0]);
		if (!container) return;

		const pageHeight = this.getCurrentPageHeight(pages, container);
		if (!pageHeight) return;

		const maxScroll = container.scrollHeight - container.clientHeight;
		const target = Math.min(
			Math.max(container.scrollTop + direction * pageHeight, 0),
			maxScroll
		);
		container.scrollTo({ top: target, behavior: "smooth" });
	}

	/** pdf.js (the PDF renderer Obsidian embeds) always wraps rendered pages in
	 * `div.page[data-page-number]` elements; walking up from one to the nearest
	 * actually-scrollable ancestor finds the viewer's scroll container without
	 * depending on Obsidian's own, version-specific wrapper class names. */
	private findScrollContainer(pageEl: HTMLElement): HTMLElement | null {
		let el: HTMLElement | null = pageEl.parentElement;
		while (el) {
			if (el.scrollHeight > el.clientHeight + 1) return el;
			el = el.parentElement;
		}
		return null;
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
