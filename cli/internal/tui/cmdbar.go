package tui

import (
	"strconv"
	"strings"
	"unicode"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const maxSuggestions = 6

// commandBar is a one-line command editor that shows completions for the
// current word as you type, so the next part of a command is always visible
// without pressing Tab. Tab or → accepts the highlighted suggestion.
type commandBar struct {
	input       textinput.Model
	complete    func(string) []Suggestion
	suggestions []Suggestion
	sel         int
	history     []string
	histIdx     int
}

func newCommandBar(complete func(string) []Suggestion) commandBar {
	in := textinput.New()
	in.Prompt = "plan ❯ "
	in.PromptStyle = promptStyle
	in.TextStyle = textStyle
	in.Placeholder = "type a command — e.g. status, archive, search, push"
	in.PlaceholderStyle = ghostStyle
	return commandBar{input: in, complete: complete}
}

func (b *commandBar) open(prefill string) tea.Cmd {
	b.input.SetValue(prefill)
	b.input.CursorEnd()
	b.histIdx = len(b.history)
	b.refresh()
	return b.input.Focus()
}

func (b *commandBar) close() { b.input.Blur() }

func (b *commandBar) refresh() {
	b.suggestions = b.complete(b.input.Value())
	if len(b.suggestions) == 1 && b.suggestions[0].Value == b.token() {
		b.suggestions = nil
	}
	b.sel = 0
}

// token is the word under construction (text after the last space).
func (b *commandBar) token() string {
	v := b.input.Value()
	if i := strings.LastIndexFunc(v, unicode.IsSpace); i >= 0 {
		return v[i+1:]
	}
	return v
}

func (b *commandBar) accept() bool {
	if len(b.suggestions) == 0 {
		return false
	}
	v := b.input.Value()
	base := v[:len(v)-len(b.token())]
	b.input.SetValue(base + b.suggestions[b.sel].Value + " ")
	b.input.CursorEnd()
	b.refresh()
	return true
}

func (b *commandBar) atEnd() bool { return b.input.Position() == len([]rune(b.input.Value())) }

// update handles a key. It returns the submitted line when Enter is pressed
// and done=true when the bar should close.
func (b *commandBar) update(msg tea.Msg) (submitted string, done bool, cmd tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "esc", "ctrl+c":
			return "", true, nil
		case "enter":
			line := strings.TrimSpace(b.input.Value())
			if line != "" {
				b.history = append(b.history, line)
			}
			return line, true, nil
		case "tab":
			b.accept()
			return "", false, nil
		case "right":
			if b.atEnd() && b.accept() {
				return "", false, nil
			}
		case "down", "ctrl+n":
			if len(b.suggestions) > 0 {
				b.sel = (b.sel + 1) % min(len(b.suggestions), maxSuggestions)
				return "", false, nil
			}
		case "up", "ctrl+p":
			if len(b.suggestions) > 0 && k.String() == "up" {
				n := min(len(b.suggestions), maxSuggestions)
				b.sel = (b.sel + n - 1) % n
				return "", false, nil
			}
			if b.histIdx > 0 {
				b.histIdx--
				b.input.SetValue(b.history[b.histIdx])
				b.input.CursorEnd()
				b.refresh()
			}
			return "", false, nil
		}
	}
	before := b.input.Value()
	b.input, cmd = b.input.Update(msg)
	if b.input.Value() != before {
		b.refresh()
	}
	return "", false, cmd
}

func (b *commandBar) view(width int) string {
	line := b.input.View()
	if b.atEnd() && len(b.suggestions) > 0 {
		tok, s := b.token(), b.suggestions[b.sel].Value
		if strings.HasPrefix(strings.ToLower(s), strings.ToLower(tok)) && len(s) > len(tok) {
			ghost := []rune(s[len(tok):])
			cur := b.input.Cursor
			cur.SetChar(string(ghost[0]))
			cur.TextStyle = ghostStyle
			line = b.input.PromptStyle.Render(b.input.Prompt) + b.input.TextStyle.Render(b.input.Value()) +
				cur.View() + ghostStyle.Render(string(ghost[1:]))
		}
	}
	rows := []string{line}
	for i, s := range b.suggestions {
		if i == maxSuggestions {
			rows = append(rows, faintStyle.Render("      … "+strconv.Itoa(len(b.suggestions)-maxSuggestions)+" more — keep typing to narrow"))
			break
		}
		marker, val := "   ", suggestStyle.Render(s.Value)
		if i == b.sel {
			marker, val = " "+selectedBar.String()+" ", suggestSel.Render(s.Value)
		}
		row := marker + lipgloss.NewStyle().Width(28).Render(val)
		if s.Description != "" {
			row += mutedStyle.Render(truncate(s.Description, max(10, width-34)))
		}
		rows = append(rows, row)
	}
	hint := faintStyle.Render("   tab/→ accept · ↑↓ choose · enter run · esc cancel")
	rows = append(rows, hint)
	return strings.Join(rows, "\n")
}

func (b *commandBar) height() int {
	n := min(len(b.suggestions), maxSuggestions)
	if len(b.suggestions) > maxSuggestions {
		n++
	}
	return n + 2
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 1 {
		return "…"
	}
	return string(r[:n-1]) + "…"
}

// SplitArgs splits a command line on whitespace, honoring single and double
// quotes and backslash escapes.
func SplitArgs(line string) []string {
	var args []string
	var cur strings.Builder
	inArg := false
	var quote rune
	escaped := false
	for _, r := range line {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\' && quote != '\'':
			escaped, inArg = true, true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote, inArg = r, true
		case unicode.IsSpace(r):
			if inArg {
				args = append(args, cur.String())
				cur.Reset()
				inArg = false
			}
		default:
			cur.WriteRune(r)
			inArg = true
		}
	}
	if inArg {
		args = append(args, cur.String())
	}
	return args
}
