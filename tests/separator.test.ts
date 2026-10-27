import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const directory = mkdtempSync(join(tmpdir(), "pi-bar-separator-test-"));
const config = join(directory, "config.json");
const previousConfig = process.env.PI_BAR_CONFIG;
const previousShow = process.env.PI_BAR_SHOW;
process.env.PI_BAR_CONFIG = config;
delete process.env.PI_BAR_SHOW;
const { default: statusFooter, layoutFooter, parseSeparatorSpacing, parseSeparatorText } = await import("../extensions/status-footer.ts");
initTheme("dark", false);

beforeEach(() => rmSync(config, { force: true }));
after(() => {
	if (previousConfig === undefined) delete process.env.PI_BAR_CONFIG;
	else process.env.PI_BAR_CONFIG = previousConfig;
	if (previousShow !== undefined) process.env.PI_BAR_SHOW = previousShow;
	rmSync(directory, { recursive: true, force: true });
});

const items = [
	{ name: "model" as const, text: "model" },
	{ name: "thinking" as const, text: "med" },
];

test("separator text accepts any printable glyph up to the width cap, including empty", () => {
	assert.equal(parseSeparatorText("❯"), "❯");
	assert.equal(parseSeparatorText(""), "");
	assert.equal(parseSeparatorText(" | "), " | ", "spaces inside the glyph are kept literally");
	assert.equal(parseSeparatorText("abcdefgh"), "abcdefgh");
	assert.equal(parseSeparatorText("全全全全"), "全全全全", "wide characters count as two columns");
	assert.equal(parseSeparatorText("abcdefghi"), undefined, "over the 8-column cap");
	assert.equal(parseSeparatorText("全全全全全"), undefined);
	assert.equal(parseSeparatorText("a\nb"), undefined);
	assert.equal(parseSeparatorText("\x1b[31m|"), undefined, "terminal escape sequences are rejected");
	assert.equal(parseSeparatorText(42), undefined);
	assert.equal(parseSeparatorText(undefined), undefined);
});

test("separator spacing accepts integers 0 through 4 only", () => {
	for (const value of [0, 1, 2, 3, 4]) assert.equal(parseSeparatorSpacing(value), value);
	for (const value of [-1, 5, 1.5, NaN, Infinity, "2", null, undefined]) assert.equal(parseSeparatorSpacing(value), undefined, String(value));
});

test("custom glyph and spacing shape the roomy layout", () => {
	assert.equal(layoutFooter(items, [], 80, "|", 0), "model|med");
	assert.equal(layoutFooter(items, [], 80, "/", 1), "model / med");
	assert.equal(layoutFooter(items, [], 80, "/", 3), "model   /   med");
	assert.equal(layoutFooter(items, [], 80), "model  ❯  med", "defaults are unchanged");
});

test("tight layouts reduce spacing to at most one space per side", () => {
	assert.equal(layoutFooter(items, [], 11, "/", 3), "model / med");
	assert.equal(layoutFooter(items, [], 9, "/", 0), "model/med");
});

test("empty glyph uses spacing as the whole gap between items", () => {
	assert.equal(layoutFooter(items, [], 80, "", 0), "modelmed");
	assert.equal(layoutFooter(items, [], 80, "", 1), "model med");
	assert.equal(layoutFooter(items, [], 80, "", 3), "model   med");
});

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: never, ctx: ExtensionContext) => unknown;

function harness() {
	const handlers = new Map<string, Handler>();
	let command: Command;
	let footer: (Component & { dispose?(): void }) | undefined;
	let custom: Component | undefined;
	const notifications: Array<{ message: string; type: string }> = [];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const tui = { requestRender() {} };
	const ctx = {
		cwd: directory, mode: "tui", hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		getContextUsage: () => undefined,
		sessionManager: { getSessionId: () => "test-session", getLeafId: () => null, getEntries: () => [], getBranch: () => [] },
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			setFooter: (factory: Function | undefined) => {
				footer?.dispose?.();
				footer = factory?.(tui, theme, { getExtensionStatuses: () => new Map() });
			},
			custom: (factory: Function) => new Promise((resolve) => {
				custom = factory(tui, theme, {}, (value: unknown) => { custom = undefined; resolve(value); });
			}),
		},
	} as unknown as ExtensionContext;
	statusFooter({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (_name: string, definition: Command) => { command = definition; },
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI);
	return {
		notifications,
		start: async () => { await handlers.get("session_start")?.({} as never, ctx); },
		shutdown: async () => { await handlers.get("session_shutdown")?.({} as never, ctx); },
		command: (args: string) => command.handler(args, ctx as ExtensionCommandContext),
		render: () => stripVTControlCharacters(footer!.render(200)[0]),
		uiText: () => stripVTControlCharacters(custom!.render(160).join("\n")),
		input: (data: string) => custom!.handleInput!(data),
		isOpen: () => custom !== undefined,
	};
}

const saved = () => JSON.parse(readFileSync(config, "utf8"));

test("/bar settings edits separator and spacing, persists them, and renders the footer with them", async (t) => {
	writeFileSync(config, JSON.stringify({ segments: ["model", "thinking"] }));
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	assert.equal(h.render(), "test-model  ❯  medium");

	let closed = h.command("settings");
	assert.match(h.uiText(), /Separator spacing\s+2/);
	h.input("Separator spacing");
	h.input("\r");
	assert.match(h.uiText(), /Separator spacing\s+3/);
	h.input("\x1b");
	await closed;
	assert.equal(saved().separatorSpacing, 3);
	assert.deepEqual(saved().segments, ["model", "thinking"], "other settings are preserved");
	assert.equal(h.render(), "test-model   ❯   medium");

	closed = h.command("settings");
	h.input("Separator");
	h.input("\r");
	assert.match(h.uiText(), /Separator: .*❯/);
	h.input("\x7f");
	h.input("/");
	h.input("\r");
	h.input("\x1b");
	await closed;
	assert.equal(saved().separator, "/");
	assert.equal(h.render(), "test-model   /   medium");
});

test("/bar settings separator editor rejects invalid text and cancels without saving", async (t) => {
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	const closed = h.command("settings");
	h.input("Separator");
	h.input("\r");
	for (let index = 0; index < 3; index++) h.input("\x7f");
	for (const character of "abcdefghi") h.input(character);
	h.input("\r");
	assert.equal(h.notifications.at(-1)?.type, "warning");
	assert.equal(h.isOpen(), true, "invalid submit keeps the editor open");
	h.input("\x1b");
	h.input("\x1b");
	await closed;
	assert.equal(h.render(), "test-model  ❯  medium  ❯  —", "cancelled edits never reach the footer");
});

test("saved separator and spacing load on session start, ignoring invalid stored values", async (t) => {
	writeFileSync(config, JSON.stringify({ segments: ["model", "thinking"], separator: "|", separatorSpacing: 9 }));
	const h = harness();
	t.after(() => h.shutdown());
	await h.start();
	assert.equal(h.render(), "test-model  |  medium", "out-of-range spacing falls back to the default");
});
