// Package tui contains the interactive plan manager and small terminal
// widgets (pickers, pretty printers) used by the CLI.
package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// Suggestion is a completion candidate with an optional description.
type Suggestion struct {
	Value       string
	Description string
}

var (
	colorAccent    = lipgloss.AdaptiveColor{Light: "#5B4BDB", Dark: "#A99BFF"}
	colorMuted     = lipgloss.AdaptiveColor{Light: "#7A7A85", Dark: "#8A8A99"}
	colorFaint     = lipgloss.AdaptiveColor{Light: "#B5B5C0", Dark: "#4A4A58"}
	colorText      = lipgloss.AdaptiveColor{Light: "#1E1E28", Dark: "#E6E6F0"}
	colorActive    = lipgloss.AdaptiveColor{Light: "#0B7A55", Dark: "#4ADE9B"}
	colorCompleted = lipgloss.AdaptiveColor{Light: "#2563C9", Dark: "#7AB4FF"}
	colorArchived  = lipgloss.AdaptiveColor{Light: "#8A6D1F", Dark: "#D9B65C"}
	colorDanger    = lipgloss.AdaptiveColor{Light: "#C52A3A", Dark: "#FF7A85"}

	titleStyle   = lipgloss.NewStyle().Bold(true).Foreground(colorAccent)
	mutedStyle   = lipgloss.NewStyle().Foreground(colorMuted)
	faintStyle   = lipgloss.NewStyle().Foreground(colorFaint)
	textStyle    = lipgloss.NewStyle().Foreground(colorText)
	errorStyle   = lipgloss.NewStyle().Foreground(colorDanger)
	keyStyle     = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	selectedBar  = lipgloss.NewStyle().Foreground(colorAccent).SetString("▌")
	tabStyle     = lipgloss.NewStyle().Padding(0, 1).Foreground(colorMuted)
	activeTab    = lipgloss.NewStyle().Padding(0, 1).Bold(true).Foreground(colorText).Background(lipgloss.AdaptiveColor{Light: "#E4E0FF", Dark: "#2E2850"})
	paneStyle    = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(colorFaint)
	focusedPane  = paneStyle.BorderForeground(colorAccent)
	modalStyle   = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(colorAccent).Padding(1, 2)
	promptStyle  = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	ghostStyle   = lipgloss.NewStyle().Foreground(colorFaint)
	suggestStyle = lipgloss.NewStyle().Foreground(colorText)
	suggestSel   = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
)

// StatusColor returns the color used for a plan status.
func StatusColor(status string) lipgloss.AdaptiveColor {
	switch status {
	case "completed":
		return colorCompleted
	case "archived":
		return colorArchived
	}
	return colorActive
}

// StatusIcon returns a single-glyph marker for a plan status.
func StatusIcon(status string) string {
	switch status {
	case "completed":
		return "✓"
	case "archived":
		return "▪"
	}
	return "●"
}

// StatusBadge renders a colored "● active" label.
func StatusBadge(status string) string {
	return lipgloss.NewStyle().Foreground(StatusColor(status)).Render(StatusIcon(status) + " " + status)
}

// RelativeTime renders an ISO timestamp as "3h ago".
func RelativeTime(iso string) string {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		return iso
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
	return t.Local().Format("Jan 2, 2006")
}

// ListLine renders one colored row for `plan list` on a terminal.
func ListLine(id, status, title string, tags []string) string {
	line := faintStyle.Render(id) + "  " +
		lipgloss.NewStyle().Foreground(StatusColor(status)).Width(12).Render(StatusIcon(status)+" "+status) +
		textStyle.Bold(true).Render(title)
	if len(tags) > 0 {
		line += " " + mutedStyle.Render("#"+strings.Join(tags, " #"))
	}
	return line
}
