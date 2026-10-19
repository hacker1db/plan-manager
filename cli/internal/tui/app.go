package tui

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/styles"
	"github.com/charmbracelet/lipgloss"

	"github.com/hacker1db/plan-manager/cli/internal/lock"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
)

// Backend supplies the plan operations the TUI performs. The CLI wires these
// to the same functions its commands use.
type Backend struct {
	SetStatus  func(idOrSlug, status string) error
	Archive    func(idOrSlug string) error
	Create     func(title string) (*plans.Plan, error)
	Complete   func(line string) []Suggestion
	EditorCmd  func(path string) *exec.Cmd
	Executable string
}

type mode int

const (
	modeNormal mode = iota
	modeCommand
	modeStatus
	modeConfirmArchive
	modeNewTitle
	modeTasks
	modeOutput
)

type focus int

const (
	focusList focus = iota
	focusPreview
)

var tabs = []string{"All", "Active", "Completed", "Archived"}

type keyMap struct {
	Up, Down, Filter, Tabs, Focus, Edit, Status, Archive, Tasks, New, Open, Copy, Command, Reload, Help, Quit key.Binding
}

func (k keyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Up, k.Filter, k.Edit, k.Status, k.Tasks, k.New, k.Command, k.Help, k.Quit}
}

func (k keyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Up, k.Down, k.Filter, k.Tabs, k.Focus},
		{k.Edit, k.Status, k.Archive, k.Tasks, k.New},
		{k.Open, k.Copy, k.Command, k.Reload, k.Help, k.Quit},
	}
}

var keys = keyMap{
	Up:      key.NewBinding(key.WithKeys("up", "k"), key.WithHelp("↑/k", "up")),
	Down:    key.NewBinding(key.WithKeys("down", "j"), key.WithHelp("↓/j", "down")),
	Filter:  key.NewBinding(key.WithKeys("/"), key.WithHelp("/", "filter")),
	Tabs:    key.NewBinding(key.WithKeys("1", "2", "3", "4", "[", "]"), key.WithHelp("1-4 [ ]", "status tabs")),
	Focus:   key.NewBinding(key.WithKeys("tab", "enter"), key.WithHelp("tab/enter", "focus preview")),
	Edit:    key.NewBinding(key.WithKeys("e"), key.WithHelp("e", "edit")),
	Status:  key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "status")),
	Archive: key.NewBinding(key.WithKeys("a"), key.WithHelp("a", "archive")),
	Tasks:   key.NewBinding(key.WithKeys("t"), key.WithHelp("t", "tasks")),
	New:     key.NewBinding(key.WithKeys("n"), key.WithHelp("n", "new")),
	Open:    key.NewBinding(key.WithKeys("o"), key.WithHelp("o", "open in browser")),
	Copy:    key.NewBinding(key.WithKeys("y"), key.WithHelp("y", "copy path")),
	Command: key.NewBinding(key.WithKeys(":"), key.WithHelp(":", "command")),
	Reload:  key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "reload")),
	Help:    key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "more keys")),
	Quit:    key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
}

// planItem adapts a plan to the list component.
type planItem struct{ p *plans.Plan }

func (i planItem) FilterValue() string {
	return i.p.Meta.Title + " " + strings.Join(i.p.Meta.Tags, " ") + " " + plans.Slug(i.p.FilePath)
}

type planDelegate struct{}

func (planDelegate) Height() int                         { return 2 }
func (planDelegate) Spacing() int                        { return 1 }
func (planDelegate) Update(tea.Msg, *list.Model) tea.Cmd { return nil }
func (planDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	p := item.(planItem).p
	width := max(10, m.Width()-3)
	icon := lipgloss.NewStyle().Foreground(StatusColor(p.Meta.Status)).Render(StatusIcon(p.Meta.Status))
	title := truncate(p.Meta.Title, width-2)
	meta := p.Meta.Status + " · " + RelativeTime(p.Meta.Updated)
	if len(p.Meta.Tags) > 0 {
		meta += " · #" + strings.Join(p.Meta.Tags, " #")
	}
	meta = truncate(meta, width-2)
	if index == m.Index() {
		fmt.Fprintf(w, "%s%s %s\n%s  %s", selectedBar, icon, suggestSel.Render(title), selectedBar, mutedStyle.Render(meta))
		return
	}
	fmt.Fprintf(w, " %s %s\n   %s", icon, textStyle.Render(title), faintStyle.Render(meta))
}

type (
	reloadMsg struct{ selectID string }
	tickMsg   struct{}
	flashMsg  struct {
		text string
		err  bool
	}
	editedMsg struct {
		id  string
		err error
	}
	outputMsg struct {
		line string
		out  string
		err  error
	}
)

type model struct {
	b Backend

	all     []*plans.Plan
	list    list.Model
	preview viewport.Model
	help    help.Model
	cmdbar  commandBar
	title   textinput.Model

	tab       int
	focus     focus
	mode      mode
	statusSel int
	taskSel   int
	tasks     []plans.Task
	output    string

	flash      string
	flashErr   bool
	flashUntil time.Time

	width, height int
	fingerprint   string
	style         string
	renderers     map[int]*glamour.TermRenderer
	rendered      map[string]string
	previewID     string
	pendingSelect string
	targetID      string
}

// Run starts the full-screen plan manager.
func Run(b Backend) error {
	style := styles.LightStyle
	if lipgloss.HasDarkBackground() {
		style = styles.DarkStyle
	}
	l := list.New(nil, planDelegate{}, 40, 20)
	l.SetShowTitle(false)
	l.SetShowStatusBar(false)
	l.SetShowHelp(false)
	l.SetShowFilter(false)
	l.DisableQuitKeybindings()
	l.KeyMap.ShowFullHelp.SetEnabled(false)
	l.KeyMap.CloseFullHelp.SetEnabled(false)
	l.FilterInput.PromptStyle = promptStyle
	l.FilterInput.Prompt = "filter ❯ "
	l.Styles.NoItems = mutedStyle.Padding(1, 2)

	ti := textinput.New()
	ti.Prompt = "title ❯ "
	ti.PromptStyle = promptStyle
	ti.Placeholder = "Migrate auth service"
	ti.PlaceholderStyle = ghostStyle

	h := help.New()
	h.Styles.ShortKey = keyStyle
	h.Styles.FullKey = keyStyle
	h.Styles.ShortDesc = mutedStyle
	h.Styles.FullDesc = mutedStyle
	h.Styles.ShortSeparator = faintStyle
	h.Styles.FullSeparator = faintStyle

	m := model{
		b: b, list: l, preview: viewport.New(40, 20), help: h, cmdbar: newCommandBar(b.Complete), title: ti,
		tab: 1, style: style, renderers: map[int]*glamour.TermRenderer{}, rendered: map[string]string{},
	}
	_, err := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion()).Run()
	return err
}

func (m model) Init() tea.Cmd {
	return tea.Batch(tea.SetWindowTitle("plan"), func() tea.Msg { return reloadMsg{} }, tick())
}

func tick() tea.Cmd { return tea.Tick(2*time.Second, func(time.Time) tea.Msg { return tickMsg{} }) }

// libraryFingerprint changes whenever a plan file is added, removed, or modified.
func libraryFingerprint() string {
	var b strings.Builder
	for _, dir := range []string{plans.Home(), plans.ArchiveDir()} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if info, err := e.Info(); err == nil && strings.HasSuffix(e.Name(), ".md") {
				fmt.Fprintf(&b, "%s/%s:%d:%d;", dir, e.Name(), info.Size(), info.ModTime().UnixNano())
			}
		}
	}
	return b.String()
}

func loadAll() []*plans.Plan {
	var out []*plans.Plan
	for _, f := range plans.AllPlanFiles() {
		if p, err := plans.Read(f); err == nil {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Meta.Updated > out[j].Meta.Updated })
	return out
}

func isArchived(p *plans.Plan) bool {
	return p.Meta.Status == plans.StatusArchived || plans.IsArchivedPath(p.FilePath)
}

func (m *model) visible() []list.Item {
	var items []list.Item
	for _, p := range m.all {
		ok := false
		switch m.tab {
		case 0:
			ok = true
		case 1:
			ok = p.Meta.Status == plans.StatusActive && !isArchived(p)
		case 2:
			ok = p.Meta.Status == plans.StatusCompleted && !isArchived(p)
		case 3:
			ok = isArchived(p)
		}
		if ok {
			items = append(items, planItem{p})
		}
	}
	return items
}

func (m *model) selected() *plans.Plan {
	if it, ok := m.list.SelectedItem().(planItem); ok {
		return it.p
	}
	return nil
}

func (m *model) applyItems(selectID string) tea.Cmd {
	if selectID == "" {
		if p := m.selected(); p != nil {
			selectID = p.Meta.ID
		}
	}
	cmd := m.list.SetItems(m.visible())
	// With a filter applied the visible items are recomputed asynchronously,
	// so the selection is restored once the filtered list arrives.
	m.pendingSelect = selectID
	m.restoreSelection()
	m.previewID = ""
	m.syncPreview()
	return cmd
}

// restoreSelection moves the cursor to pendingSelect once it is visible.
// Select indexes the visible (possibly filtered) items, not the full list.
func (m *model) restoreSelection() {
	if m.pendingSelect == "" {
		return
	}
	for i, it := range m.list.VisibleItems() {
		if it.(planItem).p.Meta.ID == m.pendingSelect {
			m.list.Select(i)
			m.pendingSelect = ""
			return
		}
	}
}

// target returns the plan a modal was opened for, looked up by ID so a
// background reload can't redirect the action to a different plan.
func (m *model) target() *plans.Plan {
	for _, p := range m.all {
		if p.Meta.ID == m.targetID {
			return p
		}
	}
	return nil
}

func (m *model) setFlash(text string, isErr bool) {
	m.flash, m.flashErr, m.flashUntil = text, isErr, time.Now().Add(4*time.Second)
}

func (m *model) layout() (listW, previewW, bodyH int) {
	footer := 2
	if m.mode == modeCommand {
		footer = m.cmdbar.height() + 1
	} else if m.mode == modeNewTitle {
		footer = 3
	}
	bodyH = max(5, m.height-3-footer)
	listW = max(32, m.width*2/5)
	if m.width < 80 {
		listW = m.width
	}
	previewW = max(0, m.width-listW)
	return
}

func (m *model) resize() {
	listW, previewW, bodyH := m.layout()
	m.list.SetSize(listW-2, bodyH-2)
	if previewW == 0 {
		previewW = m.width
	}
	m.preview.Width = max(10, previewW-4)
	m.preview.Height = max(3, bodyH-2)
	m.help.Width = m.width
	m.previewID = ""
	m.syncPreview()
}

func (m *model) renderer(width int) *glamour.TermRenderer {
	if r, ok := m.renderers[width]; ok {
		return r
	}
	r, err := glamour.NewTermRenderer(glamour.WithStandardStyle(m.style), glamour.WithWordWrap(width))
	if err != nil {
		return nil
	}
	m.renderers[width] = r
	return r
}

func (m *model) renderPlan(p *plans.Plan, width int) string {
	key := p.Revision() + ":" + strconv.Itoa(width)
	if s, ok := m.rendered[key]; ok {
		return s
	}
	head := []string{
		titleStyle.Width(width).Render(p.Meta.Title),
		StatusBadge(p.Meta.Status) + mutedStyle.Render("  ·  updated "+RelativeTime(p.Meta.Updated)+"  ·  created "+RelativeTime(p.Meta.Created)),
	}
	if len(p.Meta.Tags) > 0 {
		head = append(head, mutedStyle.Render("#"+strings.Join(p.Meta.Tags, "  #")))
	}
	if tasks := plans.Tasks(p.Body); len(tasks) > 0 {
		done := 0
		for _, t := range tasks {
			if t.Checked {
				done++
			}
		}
		head = append(head, progressBar(done, len(tasks), min(30, width-14))+mutedStyle.Render(fmt.Sprintf("  %d/%d tasks", done, len(tasks))))
	}
	head = append(head, faintStyle.Render(truncate(p.Meta.ID+"  "+p.FilePath, width)), "")
	body := p.Body
	if r := m.renderer(width); r != nil {
		if out, err := r.Render(body); err == nil {
			body = out
		}
	}
	s := strings.Join(head, "\n") + "\n" + strings.Trim(body, "\n")
	m.rendered[key] = s
	return s
}

func progressBar(done, total, width int) string {
	if width < 4 || total == 0 {
		return ""
	}
	filled := done * width / total
	return lipgloss.NewStyle().Foreground(colorActive).Render(strings.Repeat("━", filled)) +
		faintStyle.Render(strings.Repeat("━", width-filled))
}

func (m *model) syncPreview() {
	if m.mode == modeOutput {
		return
	}
	p := m.selected()
	if p == nil {
		m.preview.SetContent(mutedStyle.Render("No plans here yet. Press n to create one, or : for any command."))
		m.previewID = ""
		return
	}
	id := p.Meta.ID + p.Revision()
	if id == m.previewID {
		return
	}
	m.previewID = id
	m.preview.SetContent(m.renderPlan(p, m.preview.Width))
	m.preview.GotoTop()
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.resize()
		return m, nil
	case reloadMsg:
		m.all = loadAll()
		m.fingerprint = libraryFingerprint()
		cmd := m.applyItems(msg.selectID)
		if m.mode == modeTasks {
			m.refreshTasks()
		}
		return m, cmd
	case tickMsg:
		if fp := libraryFingerprint(); fp != m.fingerprint && m.list.FilterState() != list.Filtering && m.mode == modeNormal {
			return m, tea.Batch(tick(), func() tea.Msg { return reloadMsg{} })
		}
		return m, tick()
	case flashMsg:
		m.setFlash(msg.text, msg.err)
		return m, func() tea.Msg { return reloadMsg{} }
	case editedMsg:
		if msg.err != nil {
			m.setFlash("Editor failed: "+msg.err.Error(), true)
		}
		return m, func() tea.Msg { return reloadMsg{selectID: msg.id} }
	case outputMsg:
		m.output = renderOutput(msg)
		m.mode = modeOutput
		m.preview.SetContent(m.output)
		m.preview.GotoTop()
		m.previewID = ""
		return m, func() tea.Msg { return reloadMsg{} }
	case tea.MouseMsg:
		if m.mode == modeNormal || m.mode == modeOutput {
			var cmd tea.Cmd
			m.preview, cmd = m.preview.Update(msg)
			return m, cmd
		}
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	var cmd tea.Cmd
	m.list, cmd = m.list.Update(msg)
	if m.pendingSelect != "" {
		m.restoreSelection()
		m.syncPreview()
	}
	return m, cmd
}

func renderOutput(o outputMsg) string {
	head := promptStyle.Render("plan ❯ ") + textStyle.Render(o.line)
	status := lipgloss.NewStyle().Foreground(colorActive).Render("✓ done")
	if o.err != nil {
		status = errorStyle.Render("✗ " + o.err.Error())
	}
	body := strings.TrimRight(o.out, "\n")
	if body == "" {
		body = mutedStyle.Render("(no output)")
	}
	return head + "\n" + status + "\n\n" + body + "\n\n" + faintStyle.Render("esc to return")
}

func (m model) handleKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.mode {
	case modeCommand:
		line, done, cmd := m.cmdbar.update(k)
		if !done {
			return m, cmd
		}
		m.cmdbar.close()
		m.mode = modeNormal
		m.resize()
		if line == "" {
			return m, nil
		}
		return m, m.runLine(line)
	case modeNewTitle:
		switch k.String() {
		case "esc", "ctrl+c":
			m.mode = modeNormal
			m.title.Blur()
			m.resize()
			return m, nil
		case "enter":
			title := strings.TrimSpace(m.title.Value())
			m.mode = modeNormal
			m.title.Blur()
			m.resize()
			if title == "" {
				return m, nil
			}
			p, err := m.b.Create(title)
			if err != nil {
				m.setFlash(err.Error(), true)
				return m, nil
			}
			m.tab = 1
			id := p.Meta.ID
			return m, tea.ExecProcess(m.b.EditorCmd(p.FilePath), func(err error) tea.Msg { return editedMsg{id: id, err: err} })
		}
		var cmd tea.Cmd
		m.title, cmd = m.title.Update(k)
		return m, cmd
	case modeStatus:
		switch k.String() {
		case "esc", "q":
			m.mode = modeNormal
		case "up", "k":
			m.statusSel = (m.statusSel + 2) % 3
		case "down", "j":
			m.statusSel = (m.statusSel + 1) % 3
		case "1", "2", "3":
			m.statusSel = int(k.String()[0] - '1')
			fallthrough
		case "enter":
			m.mode = modeNormal
			if p := m.target(); p != nil {
				status := plans.Statuses[m.statusSel]
				if err := m.b.SetStatus(p.Meta.ID, status); err != nil {
					m.setFlash(err.Error(), true)
				} else {
					m.setFlash(fmt.Sprintf("%s → %s", p.Meta.Title, status), false)
				}
				return m, func() tea.Msg { return reloadMsg{selectID: p.Meta.ID} }
			}
		}
		return m, nil
	case modeConfirmArchive:
		m.mode = modeNormal
		if p := m.target(); p != nil && (k.String() == "y" || k.String() == "Y") {
			if err := m.b.Archive(p.Meta.ID); err != nil {
				m.setFlash(err.Error(), true)
			} else {
				m.setFlash("Archived "+p.Meta.Title, false)
			}
			return m, func() tea.Msg { return reloadMsg{} }
		}
		return m, nil
	case modeTasks:
		return m.handleTaskKey(k)
	case modeOutput:
		switch k.String() {
		case "esc", "q", "enter":
			m.mode = modeNormal
			m.previewID = ""
			m.syncPreview()
			return m, nil
		case ":":
			m.mode = modeCommand
			m.resize()
			return m, m.cmdbar.open("")
		}
		var cmd tea.Cmd
		m.preview, cmd = m.preview.Update(k)
		return m, cmd
	}

	if m.list.FilterState() == list.Filtering {
		var cmd tea.Cmd
		m.list, cmd = m.list.Update(k)
		m.syncPreview()
		return m, cmd
	}

	p := m.selected()
	switch k.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "esc":
		if m.focus == focusPreview {
			m.focus = focusList
			return m, nil
		}
	case "?":
		m.help.ShowAll = !m.help.ShowAll
		return m, nil
	case "1", "2", "3", "4":
		m.tab = int(k.String()[0] - '1')
		return m, m.applyItems("")
	case "]":
		m.tab = (m.tab + 1) % len(tabs)
		return m, m.applyItems("")
	case "[":
		m.tab = (m.tab + len(tabs) - 1) % len(tabs)
		return m, m.applyItems("")
	case "tab", "enter":
		if m.focus == focusList {
			m.focus = focusPreview
		} else {
			m.focus = focusList
		}
		return m, nil
	case ":":
		m.mode = modeCommand
		m.resize()
		return m, m.cmdbar.open("")
	case "n":
		m.mode = modeNewTitle
		m.title.SetValue("")
		m.resize()
		return m, m.title.Focus()
	case "r":
		m.setFlash("Reloaded", false)
		return m, func() tea.Msg { return reloadMsg{} }
	}
	if p != nil {
		switch k.String() {
		case "e":
			id := p.Meta.ID
			return m, tea.ExecProcess(m.b.EditorCmd(p.FilePath), func(err error) tea.Msg { return editedMsg{id: id, err: err} })
		case "s":
			m.mode = modeStatus
			m.targetID = p.Meta.ID
			for i, s := range plans.Statuses {
				if s == p.Meta.Status {
					m.statusSel = i
				}
			}
			return m, nil
		case "a":
			if plans.IsArchivedPath(p.FilePath) {
				m.setFlash("Already in the archive", false)
				return m, nil
			}
			m.mode = modeConfirmArchive
			m.targetID = p.Meta.ID
			return m, nil
		case "t":
			m.mode = modeTasks
			m.taskSel = 0
			m.refreshTasks()
			if len(m.tasks) == 0 {
				m.mode = modeNormal
				m.setFlash("This plan has no - [ ] tasks", false)
			}
			return m, nil
		case "o":
			return m, m.runBackground([]string{"open", p.Meta.ID}, "Opened in browser")
		case "y":
			if err := copyToClipboard(p.FilePath); err != nil {
				m.setFlash("Copy failed: "+err.Error(), true)
			} else {
				m.setFlash("Copied "+p.FilePath, false)
			}
			return m, nil
		}
	}

	var cmd tea.Cmd
	if m.focus == focusPreview {
		m.preview, cmd = m.preview.Update(k)
		return m, cmd
	}
	m.list, cmd = m.list.Update(k)
	m.syncPreview()
	return m, cmd
}

func (m *model) refreshTasks() {
	if p := m.selected(); p != nil {
		m.tasks = plans.Tasks(p.Body)
		m.taskSel = min(m.taskSel, max(0, len(m.tasks)-1))
	}
}

func (m model) handleTaskKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "esc", "q", "t":
		m.mode = modeNormal
		m.previewID = ""
		m.syncPreview()
	case "up", "k":
		if m.taskSel > 0 {
			m.taskSel--
		}
	case "down", "j":
		if m.taskSel < len(m.tasks)-1 {
			m.taskSel++
		}
	case " ", "x", "enter":
		p := m.selected()
		if p == nil || len(m.tasks) == 0 {
			return m, nil
		}
		t := m.tasks[m.taskSel]
		if err := toggleTask(p, t.Index, !t.Checked); err != nil {
			m.setFlash(err.Error(), true)
		}
		return m, func() tea.Msg { return reloadMsg{selectID: p.Meta.ID} }
	}
	return m, nil
}

// toggleTask flips one checkbox, refusing if the file changed since it was read.
func toggleTask(p *plans.Plan, index int, checked bool) error {
	_, err := lock.With(plans.Home(), func() (struct{}, error) {
		cur, err := plans.Read(p.FilePath)
		if err != nil {
			return struct{}{}, err
		}
		if cur.Revision() != p.Revision() {
			return struct{}{}, fmt.Errorf("plan changed on disk; reloaded — try again")
		}
		body, ok := plans.UpdateTaskMarker(cur.Body, index, checked)
		if !ok {
			return struct{}{}, fmt.Errorf("task %d not found", index)
		}
		return struct{}{}, plans.Write(cur.FilePath, cur.Meta, body)
	})
	return err
}

func copyToClipboard(text string) error {
	var c *exec.Cmd
	switch {
	case runtime.GOOS == "darwin":
		c = exec.Command("pbcopy")
	case os.Getenv("WAYLAND_DISPLAY") != "":
		c = exec.Command("wl-copy")
	default:
		c = exec.Command("xclip", "-selection", "clipboard")
	}
	c.Stdin = strings.NewReader(text)
	return c.Run()
}

var interactiveCommands = map[string]bool{"new": true, "edit": true, "tui": true, "ui": true}

// runLine executes a command-bar line through the plan binary. Commands that
// need the terminal (editors, sign-in, foreground server) take it over;
// everything else runs in the background and its output is shown in place.
func (m *model) runLine(line string) tea.Cmd {
	args := SplitArgs(line)
	if len(args) > 0 && args[0] == "plan" {
		args = args[1:]
	}
	if len(args) == 0 {
		return nil
	}
	needsTTY := interactiveCommands[args[0]] ||
		(args[0] == "auth" && len(args) > 1 && args[1] == "login") ||
		(args[0] == "serve" && contains(args, "--foreground"))
	if needsTTY {
		c := exec.Command(m.b.Executable, args...)
		return tea.ExecProcess(c, func(err error) tea.Msg {
			if err != nil {
				return flashMsg{text: "plan " + line + ": " + err.Error(), err: true}
			}
			return flashMsg{text: "plan " + line + " finished"}
		})
	}
	exe := m.b.Executable
	return func() tea.Msg {
		c := exec.Command(exe, args...)
		c.Env = append(os.Environ(), "NO_COLOR=1")
		out, err := c.CombinedOutput()
		if ee, ok := err.(*exec.ExitError); ok {
			err = fmt.Errorf("exit %d", ee.ExitCode())
		}
		return outputMsg{line: line, out: string(out), err: err}
	}
}

func (m *model) runBackground(args []string, success string) tea.Cmd {
	exe := m.b.Executable
	return func() tea.Msg {
		out, err := exec.Command(exe, args...).CombinedOutput()
		if err != nil {
			return flashMsg{text: strings.TrimSpace(string(out)), err: true}
		}
		return flashMsg{text: success}
	}
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func (m model) View() string {
	if m.width == 0 {
		return ""
	}
	listW, previewW, bodyH := m.layout()

	counts := map[string]int{}
	for _, p := range m.all {
		if isArchived(p) {
			counts["archived"]++
		} else {
			counts[p.Meta.Status]++
		}
	}
	brand := titleStyle.Render("◆ plan")
	stats := mutedStyle.Render(fmt.Sprintf("%d active · %d completed · %d archived", counts["active"], counts["completed"], counts["archived"]))
	home := faintStyle.Render(truncate(shortenHome(plans.Home()), max(10, m.width-lipgloss.Width(brand)-lipgloss.Width(stats)-6)))
	gap := max(1, m.width-lipgloss.Width(brand)-lipgloss.Width(home)-lipgloss.Width(stats)-4)
	header := " " + brand + "  " + home + strings.Repeat(" ", gap) + stats + " "

	var tabRow []string
	for i, t := range tabs {
		label := fmt.Sprintf("%d %s", i+1, t)
		if i == m.tab {
			tabRow = append(tabRow, activeTab.Render(label))
		} else {
			tabRow = append(tabRow, tabStyle.Render(label))
		}
	}
	tabsLine := " " + strings.Join(tabRow, " ")
	if m.list.FilterState() != list.Unfiltered {
		tabsLine += "   " + m.list.FilterInput.View()
	}

	lp, pp := paneStyle, paneStyle
	if m.focus == focusList && m.mode == modeNormal {
		lp = focusedPane
	} else if m.mode != modeCommand {
		pp = focusedPane
	}
	var body string
	switch {
	case previewW > 0:
		left := lp.Width(listW - 2).Height(bodyH - 2).Render(m.list.View())
		right := pp.Width(previewW-2).Height(bodyH-2).Padding(0, 1).Render(m.rightPane(previewW-4, bodyH-2))
		body = lipgloss.JoinHorizontal(lipgloss.Top, left, right)
	case m.focus == focusPreview || (m.mode != modeNormal && m.mode != modeCommand && m.mode != modeNewTitle):
		// Too narrow for two panes: show the detail pane in place of the list.
		body = focusedPane.Width(m.width-2).Height(bodyH-2).Padding(0, 1).Render(m.rightPane(m.width-4, bodyH-2))
	default:
		body = lp.Width(listW - 2).Height(bodyH - 2).Render(m.list.View())
	}

	var footer string
	switch m.mode {
	case modeCommand:
		footer = m.cmdbar.view(m.width)
	case modeNewTitle:
		footer = " " + titleStyle.Render("New plan") + mutedStyle.Render("  enter to create and open in $EDITOR · esc to cancel") + "\n " + m.title.View()
	default:
		footer = " " + m.help.View(keys)
	}
	flash := ""
	if m.flash != "" && time.Now().Before(m.flashUntil) {
		if m.flashErr {
			flash = " " + errorStyle.Render("✗ "+m.flash)
		} else {
			flash = " " + lipgloss.NewStyle().Foreground(colorActive).Render("✓ "+m.flash)
		}
	}
	return lipgloss.JoinVertical(lipgloss.Left, header, tabsLine, body, flash, footer)
}

func (m model) rightPane(width, height int) string {
	switch m.mode {
	case modeStatus:
		return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, m.statusModal())
	case modeConfirmArchive:
		if p := m.target(); p != nil {
			msg := titleStyle.Render("Archive this plan?") + "\n\n" + textStyle.Render(p.Meta.Title) + "\n" +
				mutedStyle.Render("Marks it archived and moves the file to archive/.") + "\n\n" +
				keyStyle.Render("y") + mutedStyle.Render(" archive   ") + keyStyle.Render("any other key") + mutedStyle.Render(" cancel")
			return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, modalStyle.Render(msg))
		}
	case modeTasks:
		return m.tasksView(width, height)
	}
	return m.preview.View()
}

func (m model) statusModal() string {
	rows := []string{titleStyle.Render("Set status"), ""}
	for i, s := range plans.Statuses {
		label := fmt.Sprintf("%d  %s", i+1, StatusBadge(s))
		if i == m.statusSel {
			rows = append(rows, selectedBar.String()+" "+label)
		} else {
			rows = append(rows, "  "+label)
		}
	}
	rows = append(rows, "", mutedStyle.Render("↑↓ choose · enter apply · esc cancel"))
	return modalStyle.Render(strings.Join(rows, "\n"))
}

func (m model) tasksView(width, height int) string {
	p := m.selected()
	if p == nil {
		return ""
	}
	done := 0
	for _, t := range m.tasks {
		if t.Checked {
			done++
		}
	}
	rows := []string{
		titleStyle.Render(truncate(p.Meta.Title, width)),
		progressBar(done, len(m.tasks), min(30, width-14)) + mutedStyle.Render(fmt.Sprintf("  %d/%d done", done, len(m.tasks))),
		"",
	}
	avail := max(1, height-5)
	start := 0
	if m.taskSel >= avail {
		start = m.taskSel - avail + 1
	}
	for i := start; i < len(m.tasks) && i < start+avail; i++ {
		t := m.tasks[i]
		box := faintStyle.Render("☐")
		text := textStyle.Render(truncate(t.Text, width-6-2*t.Depth))
		if t.Checked {
			box = lipgloss.NewStyle().Foreground(colorActive).Render("☑")
			text = mutedStyle.Strikethrough(true).Render(truncate(t.Text, width-6-2*t.Depth))
		}
		cursor := "  "
		if i == m.taskSel {
			cursor = selectedBar.String() + " "
		}
		rows = append(rows, cursor+strings.Repeat("  ", t.Depth)+box+" "+text)
	}
	rows = append(rows, "", mutedStyle.Render("space/x toggle · ↑↓ move · esc done"))
	return strings.Join(rows, "\n")
}

func shortenHome(p string) string {
	if h, err := os.UserHomeDir(); err == nil && strings.HasPrefix(p, h) {
		return "~" + p[len(h):]
	}
	return filepath.Clean(p)
}
