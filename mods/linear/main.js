// Linear issues in a Herdr panel, read through the `linear` CLI (schpet/linear-cli).
// Click the circle to mark an issue done, the title to open it, the header to pick a list.
//
// Block props (all optional):
//   args     `linear issue query` filters shown until a list is picked
//            default ["--assignee", "@me", "--all-teams", "--state", "unstarted", "--state", "started"]
//   title    header label for that default list                  default "My issues"
//   refresh  seconds between reads (>= 15)                       default 60
//   key      keeps the picked list apart when several panels are shown
//
// Commands: linear.refresh, linear.menu. The panel takes the keyboard from pane.go (ctrl-h).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, theme, props, shared, setShared, openOverlay, closeOverlay, nextCommand, run } from "herdr";

const ACTIVE = ["--state", "unstarted", "--state", "started"];
const MINE = ["--assignee", "@me", "--all-teams"];
const DEFAULT_ARGS = [...MINE, ...ACTIVE];
const DEFAULT_REFRESH_S = 60;
const INSTALL_HINT = "brew install schpet/tap/linear, then linear auth login";

const PRESETS = [
  { label: "My issues", args: DEFAULT_ARGS },
  { label: "In progress", args: [...MINE, "--state", "started"] },
  { label: "Todo", args: [...MINE, "--state", "unstarted"] },
  { label: "Backlog", args: [...MINE, "--state", "backlog"] },
  { label: "Unassigned", args: ["--all-teams", "--unassigned", ...ACTIVE] },
];

// Linear priorities: 1 urgent, 2 high, 3 medium, 4 low, 0 none.
const priorityColor = (t, p) => ({ 1: t.ansi1, 2: t.ansi3, 3: t.ansi4 })[p] ?? t.dim;
const priorityRank = (p) => (p > 0 ? p : 5);
const STATE_RANK = { started: 0, unstarted: 1, backlog: 2, triage: 3 };

const config = () => {
  const p = props() ?? {};
  return {
    args: Array.isArray(p.args) && p.args.length ? p.args : DEFAULT_ARGS,
    title: p.title || "My issues",
    refresh: Math.max(15, Number(p.refresh) || DEFAULT_REFRESH_S) * 1000,
    key: `linear.view.${p.key || "default"}`,
  };
};

// The picked list, else the block's default filters.
const currentView = (key = config().key) => {
  const c = config();
  return shared(key) ?? { label: c.title, args: c.args };
};

const sameView = (a, b) => JSON.stringify(a?.args) === JSON.stringify(b?.args);

const listArgs = (view) => ["issue", "query", ...view.args, "--json", "--limit", "all", "--no-pager"];

// The CLI prints "✗ message" and a hint: keep the first line, without the mark.
const errorText = (e) => String(e?.message ?? e).split("\n")[0].replace(/^✗\s*/, "");

// `linear` comes from the user's PATH; a failed start means it isn't installed.
async function linear(args) {
  let r;
  try {
    r = await exec("linear", args, { timeout: 20000 });
  } catch (e) {
    const err = new Error(String(e?.message ?? e));
    err.missing = true;
    throw err;
  }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `linear exited ${r.code}`);
  return r.stdout;
}

const openIssue = (issue) => linear(["issue", "view", issue.identifier, "--web"]).catch(() => {});

export default class Linear extends View {
  init(_props, cx) {
    if (props()?.menu) return this.initMenu(cx);
    this.issues = [];
    this.error = null;
    this.missing = false;
    this.loading = true;
    this.refreshing = false;
    this.again = false;
    this.pending = new Set();
    this.hovered = null;
    this.sel = 0;
    this.handle = cx.focus_handle();
    this.listScroll = ScrollHandle.new();
    cx.timer.every(config().refresh, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx);
        else if (c === "menu") this.openMenu("dialog");
        // pane.go landed here, or a popup over the panel closed.
        else if (c === "focus") this.handle.focus();
        cx.notify();
      }
    });
    this.refresh(cx);
  }

  refresh(cx) {
    // One read at a time; a request during a read runs once it ends.
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const view = currentView();
      try {
        const out = await linear(listArgs(view));
        this.issues = JSON.parse(out).sort(
          (a, b) =>
            (STATE_RANK[a.state?.type] ?? 9) - (STATE_RANK[b.state?.type] ?? 9) ||
            priorityRank(a.priority) - priorityRank(b.priority) ||
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
        );
        this.error = null;
        this.missing = false;
      } catch (e) {
        this.missing = Boolean(e.missing);
        this.error = e.missing ? null : errorText(e);
        // Rows of another list would read as this one's.
        if (!sameView(view, this.loadedView)) this.issues = [];
      }
      this.loadedView = view;
      this.loading = false;
      this.refreshing = false;
      this.updated = new Date();
      if (this.again) {
        this.again = false;
        this.refresh(cx);
      }
      cx.notify();
    });
  }

  complete(issue, cx) {
    if (this.pending.has(issue.id)) return;
    this.pending.add(issue.id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await linear(["issue", "update", issue.identifier, "--state", "completed"]);
      } catch (e) {
        this.error = errorText(e);
      }
      this.pending.delete(issue.id);
      this.refresh(cx);
    });
  }

  // A popup at the pointer from a click; a dialog from a key or command, which has no pointer.
  openMenu(kind = "popup") {
    openOverlay({ mod: "linear", kind, width: 280, height: 440, props: { menu: true, key: config().key } });
  }

  // j/k move, x marks done, Enter opens, r refreshes, / or m picks a list, l or Esc goes back.
  panelKey(e, cx) {
    const k = e.key;
    const n = this.issues.length;
    const move = (to) => {
      this.sel = Math.max(0, Math.min(n - 1, to));
      this.listScroll.scroll_to_item(this.sel);
    };
    const issue = this.issues[this.sel];
    if (e.modifiers?.control || e.modifiers?.platform) return;
    if (k === "j" || k === "down") move(this.sel + 1);
    else if (k === "k" || k === "up") move(this.sel - 1);
    else if (k === "G" || (k === "g" && e.modifiers?.shift)) move(n - 1);
    else if (k === "g") move(0);
    else if (k === "x" || k === "space") issue && this.complete(issue, cx);
    else if (k === "enter" || k === "o") issue && openIssue(issue);
    else if (k === "r") this.refresh(cx);
    else if (k === "/" || k === "m") this.openMenu("dialog");
    else if (k === "l" || k === "escape") run("pane.go", { direction: "right" });
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  row(t, issue, i, focused) {
    const selected = focused && i === this.sel;
    const done = this.pending.has(issue.id);
    const color = priorityColor(t, issue.priority);
    return h_flex()
      .id(`ln-${issue.id}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = issue.id;
        else if (this.hovered === issue.id) this.hovered = null;
        cx.notify();
      })
      .child(
        div()
          .id(`ln-done-${issue.id}`)
          .flex_none()
          .size(14)
          .rounded(7)
          .border(1.5)
          .border_color(color)
          .cursor_pointer()
          .when(done || this.hovered === issue.id, (el) => el.bg(color))
          .tooltip(`Mark done · ${issue.priorityLabel ?? "No priority"}`)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.complete(issue, cx);
          }),
      )
      .child(div().flex_none().text_size(11).text_color(t.dim).child(issue.identifier))
      .child(
        div()
          .id(`ln-open-${issue.id}`)
          .flex_1()
          .min_w(0)
          .truncate()
          .cursor_pointer()
          .text_color(done ? t.dim : t.foreground)
          .tooltip("Open in Linear")
          .on_click(() => openIssue(issue))
          .child(issue.title),
      )
      .child(
        div()
          .flex_none()
          .size(8)
          .rounded(4)
          .bg(issue.state?.color ?? t.dim)
          .tooltip(issue.state?.name ?? ""),
      );
  }

  render(cx) {
    if (props()?.menu) return this.renderMenu(cx);
    const t = theme();
    const view = currentView();
    // A list picked in the menu, or by another copy: read it once.
    if (this.loadedView && !this.refreshing && !sameView(view, this.loadedView)) {
      this.loadedView = view;
      cx.spawn(async (cx) => this.refresh(cx));
    }
    const note = (text, color) => div().px(16).pb(6).text_size(12).text_color(color).child(text);
    const focused = this.handle.is_focused();
    this.sel = Math.max(0, Math.min(this.issues.length - 1, this.sel));
    const updated = this.updated ? `Refresh · updated ${this.updated.toLocaleTimeString().slice(0, 5)}` : "Refresh";
    return v_flex()
      .id("ln-panel")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.panelKey(e, cx))
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .child(
        h_flex()
          .px(16)
          .h(41)
          .pt(14)
          .pb(5)
          .flex_none()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .id("ln-pick")
              .min_w(0)
              .gap(4)
              .items_center()
              .cursor_pointer()
              .text_size(11.5)
              .font_medium()
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .tooltip("Choose a list")
              .on_click(() => this.openMenu())
              .child(div().min_w(0).truncate().child(this.missing ? "Linear" : `${view.label} · ${this.issues.length}`))
              .child(svg("mods/linear/chevron-down.svg").size(12).flex_none()),
          )
          .child(
            div()
              .id("ln-refresh")
              .flex_none()
              .cursor_pointer()
              .text_color(this.refreshing ? t.foreground : t.dim)
              .hover((s) => s.text_color(t.foreground))
              .tooltip(updated)
              .on_click((_e, cx) => this.refresh(cx))
              .child(
                this.refreshing
                  ? svg("mods/linear/refresh.svg").size(14).spin(900)
                  : svg("mods/linear/refresh.svg").size(14),
              ),
          ),
      )
      .when(this.missing, (el) => el.child(note("The linear CLI isn't installed or isn't on PATH.", t.foreground)).child(note(INSTALL_HINT, t.dim)))
      .when(Boolean(this.error), (el) => el.child(note(this.error, t.ansi1)))
      .when(this.loading, (el) => el.child(note("Loading…", t.dim)))
      .when(!this.loading && !this.error && !this.missing && this.issues.length === 0, (el) => el.child(note("Nothing to do.", t.dim)))
      .child(
        v_flex()
          .id("ln-list")
          .flex_1()
          .min_h(0)
          .px(8)
          .overflow_y_scrollbar()
          .track_scroll(this.listScroll)
          .children(this.issues.map((issue, i) => this.row(t, issue, i, focused))),
      )
      .when(focused, (el) =>
        el.child(
          div()
            .px(16)
            .py(6)
            .flex_none()
            .text_size(10.5)
            .text_color(t.dim)
            .child("j/k move · x done · ⏎ open · / list · l back"),
        ),
      );
  }

  // The list menu: presets, teams, projects, labels and a free search.

  initMenu(cx) {
    this.teams = [];
    this.projects = [];
    this.labels = [];
    this.at = null;
    this.moved = false;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ value: "", placeholder: "Search issues  ( / )" });
    this.input.on("submit", () => {
      const text = this.input.value().trim();
      if (text) this.pick({ label: `“${text}”`, args: ["--all-teams", "--search", text] });
    });
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.inputFocused = false;
      cx.notify();
    });
    // The list has the keyboard first, so j/k move at once; / or i types a search.
    this.handle = cx.focus_handle();
    this.handle.focus();
    // A dialog puts the first input in focus: take it back unless / or i asked for it.
    this.wantInput = false;
    cx.timer.after(300, () => this.wantInput || this.handle.focus());
    cx.spawn(async (cx) => {
      const read = async (args) => JSON.parse(await linear([...args, "--json"]));
      const [teams, projects, labels] = await Promise.all([
        read(["team", "list"]).catch(() => []),
        read(["project", "list"]).catch(() => []),
        read(["label", "list"]).catch(() => []),
      ]);
      this.teams = teams.map((t) => ({ label: t.name, args: ["--team", t.key, ...ACTIVE] }));
      this.projects = projects.map((p) => ({ label: p.name, args: ["--all-teams", "--project", p.id, ...ACTIVE] }));
      // Labels can repeat across teams: one entry per name.
      const names = [...new Set(labels.map((l) => l.name))];
      this.labels = names.map((name) => ({ label: name, args: ["--all-teams", "--label", name, ...ACTIVE] }));
      cx.notify();
    });
  }

  sections() {
    return [
      { title: "Lists", items: PRESETS },
      { title: "Teams", items: this.teams },
      { title: "Projects", items: this.projects },
      { title: "Labels", items: this.labels },
    ].filter((s) => s.items.length > 0);
  }

  pick(view) {
    const p = props();
    setShared(p.key, view);
    closeOverlay(p.overlay);
    run("linear.refresh");
  }

  // Up/down/j/k move by one, h/l to the previous/next section's first item, g/G to the ends.
  menuKey(e, cx, items, starts) {
    const k = e.key;
    const ctrl = e.modifiers?.control;
    const move = (to) => {
      this.moved = true;
      this.at = Math.max(0, Math.min(items.length - 1, to));
      this.scroll.scroll_to_item(this.rowOf[this.at]);
    };
    if (k === "escape") {
      if (this.inputFocused) this.handle.focus();
      else closeOverlay(props().overlay);
    } else if (k === "down" || (ctrl && (k === "j" || k === "n"))) move(this.at + 1);
    else if (k === "up" || (ctrl && (k === "k" || k === "p"))) move(this.at - 1);
    else if (this.inputFocused) return;
    else if (k === "j") move(this.at + 1);
    else if (k === "k") move(this.at - 1);
    else if (k === "l") move(starts.find((s) => s > this.at) ?? this.at);
    else if (k === "h") move([...starts].reverse().find((s) => s < this.at) ?? 0);
    else if (k === "G" || (k === "g" && e.modifiers?.shift)) move(items.length - 1);
    else if (k === "g") move(0);
    else if (k === "enter") items[this.at] && this.pick(items[this.at]);
    else if (k === "/" || k === "i") {
      this.wantInput = true;
      this.input.focus();
    }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  renderMenu() {
    const t = theme();
    const on = currentView(props().key);
    const sections = this.sections();
    const items = sections.flatMap((s) => s.items);
    const starts = [];
    for (let i = 0, n = 0; i < sections.length; n += sections[i].items.length, i++) starts.push(n);
    // Until a key moves it, the selection follows the current list, which may load late.
    if (!this.moved || this.at >= items.length) this.at = Math.max(0, items.findIndex((v) => sameView(v, on)));
    // The list's children are headers and rows: where each item's row sits, for scrolling.
    this.rowOf = [];
    let row = 0;
    for (const s of sections) {
      row++;
      for (const _ of s.items) this.rowOf.push(row++);
    }
    const section = (text) => div().px(8).pt(8).pb(4).text_size(11).text_color(t.dim).child(text);
    let index = 0;
    const item = (v) => {
      const i = index++;
      const selected = i === this.at;
      return h_flex()
        .id(`ln-menu-${i}`)
        .h(30)
        .px(8)
        .gap(9)
        .flex_none()
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .cursor_pointer()
        .when(selected, (el) => el.bg(t.selected))
        .hover((el) => el.bg(selected ? t.selected : t.hover))
        .on_click(() => this.pick(v))
        .child(div().flex_1().min_w(0).truncate().child(v.label))
        .when(sameView(v, on), (el) => el.child(svg("mods/linear/check.svg").size(14).flex_none()));
    };
    return v_flex()
      .id("ln-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.menuKey(e, cx, items, starts))
      .size_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(
        div()
          .px(4)
          .pt(4)
          .pb(2)
          .child(
            Input.new(this.input)
              .h(30)
              .px(8)
              .rounded(7)
              .border_1()
              .border_color(this.inputFocused ? t.accent : t.input)
              .bg(t.background)
              .text_size(12.5),
          ),
      )
      .child(
        v_flex()
          .id("ln-menu-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .track_scroll(this.scroll)
          .children(sections.flatMap((s) => [section(s.title), ...s.items.map(item)])),
      )
      .child(
        div()
          .px(8)
          .pt(4)
          .pb(2)
          .flex_none()
          .text_size(10.5)
          .text_color(t.dim)
          .child(this.inputFocused ? "⏎ search · ↑↓ move · esc back" : "j/k move · h/l section · ⏎ pick · / search"),
      );
  }
}
