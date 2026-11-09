package tui

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type pickItem Suggestion

func (i pickItem) FilterValue() string { return i.Value + " " + i.Description }

type pickDelegate struct{}

func (pickDelegate) Height() int                         { return 1 }
func (pickDelegate) Spacing() int                        { return 0 }
func (pickDelegate) Update(tea.Msg, *list.Model) tea.Cmd { return nil }
func (pickDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	it := item.(pickItem)
	cursor, value := "  ", suggestStyle.Render(it.Value)
	if index == m.Index() {
		cursor, value = selectedBar.String()+" ", suggestSel.Render(it.Value)
	}
	fmt.Fprint(w, cursor+value+"  "+mutedStyle.Render(it.Description))
}

type pickModel struct {
	list   list.Model
	choice string
	quit   bool
}

func (m pickModel) Init() tea.Cmd { return nil }

func (m pickModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.list.SetWidth(msg.Width)
	case tea.KeyMsg:
		if m.list.FilterState() != list.Filtering {
			switch msg.String() {
			case "enter":
				if it, ok := m.list.SelectedItem().(pickItem); ok {
					m.choice = it.Value
				}
				return m, tea.Quit
			case "q", "esc", "ctrl+c":
				m.quit = true
				return m, tea.Quit
			}
		} else if msg.String() == "ctrl+c" {
			m.quit = true
			return m, tea.Quit
		}
	}
	var cmd tea.Cmd
	m.list, cmd = m.list.Update(msg)
	return m, cmd
}

func (m pickModel) View() string {
	if m.choice != "" || m.quit {
		return ""
	}
	return m.list.View()
}

// Pick shows an inline, filterable chooser on stderr and returns the chosen
// value, or "" if the user cancelled.
func Pick(prompt string, items []Suggestion) (string, error) {
	li := make([]list.Item, len(items))
	for i, it := range items {
		li[i] = pickItem(it)
	}
	height := min(len(items), 12) + 4
	l := list.New(li, pickDelegate{}, 80, height)
	l.Title = prompt
	l.Styles.Title = titleStyle
	l.Styles.TitleBar = lipgloss.NewStyle()
	l.SetShowStatusBar(false)
	l.SetShowHelp(false)
	l.SetShowPagination(len(items) > 12)
	l.FilterInput.PromptStyle = promptStyle
	p := tea.NewProgram(pickModel{list: l}, tea.WithOutput(os.Stderr))
	res, err := p.Run()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(res.(pickModel).choice), nil
}
