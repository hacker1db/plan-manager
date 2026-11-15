package mdxrender

import (
	"strings"
	"unicode"
	"unicode/utf8"

	gast "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	gtext "github.com/yuin/goldmark/text"
)

// A port of micromark-extension-gfm-autolink-literal (www., http(s)://, and
// email literals), replacing goldmark's Linkify, whose rules differ. goldmark
// only triggers inline parsers on punctuation and whitespace, so literals are
// found right after those and at line starts.

var kindLiteralLink = gast.NewNodeKind("LiteralAutolink")

type literalLinkNode struct {
	gast.BaseInline
	url, text string
}

func (n *literalLinkNode) Kind() gast.NodeKind { return kindLiteralLink }
func (n *literalLinkNode) Dump(source []byte, level int) {
	gast.DumpHelper(n, source, level, map[string]string{"URL": n.url}, nil)
}

func asciiAlpha(r rune) bool        { return r < 128 && r|0x20 >= 'a' && r|0x20 <= 'z' }
func asciiAlphanumeric(r rune) bool { return asciiAlpha(r) || (r >= '0' && r <= '9') }
func gfmAtext(r rune) bool {
	return r == '+' || r == '-' || r == '.' || r == '_' || asciiAlphanumeric(r)
}

// unicodePunctuation is micromark's /\p{P}|\p{S}/u.
func unicodePunctuation(r rune) bool { return r >= 0 && (unicode.IsPunct(r) || unicode.IsSymbol(r)) }

type literalScanner struct{ s string }

func (l literalScanner) at(i int) rune {
	if i >= len(l.s) {
		return -1
	}
	r, _ := utf8.DecodeRuneInString(l.s[i:])
	return r
}

func (l literalScanner) size(i int) int {
	_, n := utf8.DecodeRuneInString(l.s[i:])
	return n
}

func endOfWord(r rune) bool { return r < 0 || isLineEndingOrSpace(r) || isUnicodeWhitespace(r) }

// trail reports whether trailing punctuation at i runs to the end of the link.
func (l literalScanner) trail(i int) bool {
	for {
		r := l.at(i)
		switch {
		case strings.ContainsRune(`!"')*,.:;?_~`, r) && r >= 0:
			i++
		case r == '&':
			i++
			if !asciiAlpha(l.at(i)) {
				return false
			}
			for asciiAlpha(l.at(i)) {
				i++
			}
			if l.at(i) != ';' {
				return false
			}
			i++
		case r == ']':
			i++
			if n := l.at(i); n < 0 || n == '(' || n == '[' || endOfWord(n) {
				return true
			}
		case r == '<' || endOfWord(r):
			return true
		default:
			return false
		}
	}
}

func (l literalScanner) domain(i int) (int, bool) {
	seen, underscoreLast, underscoreLastLast := false, false, false
	for {
		r := l.at(i)
		if r == '.' || r == '_' {
			if l.trail(i) {
				break
			}
			if r == '_' {
				underscoreLast = true
			} else {
				underscoreLastLast, underscoreLast = underscoreLast, false
			}
			i++
			continue
		}
		if endOfWord(r) || (r != '-' && unicodePunctuation(r)) {
			break
		}
		seen = true
		i += l.size(i)
	}
	return i, seen && !underscoreLast && !underscoreLastLast
}

func (l literalScanner) path(i int) int {
	open, closed := 0, 0
	for {
		r := l.at(i)
		switch {
		case r == '(':
			open++
			i++
		case r == ')' && closed < open:
			closed++
			i++
		case r >= 0 && strings.ContainsRune(`!"&')*,.:;<?]_~`, r):
			if l.trail(i) {
				return i
			}
			if r == ')' {
				closed++
			}
			i++
		case endOfWord(r):
			return i
		default:
			i += l.size(i)
		}
	}
}

func previousWww(prev rune) bool {
	return prev < 0 || strings.ContainsRune("(*_[]~", prev) || isLineEndingOrSpace(prev)
}

func (l literalScanner) www(prev rune) (int, bool) {
	if !previousWww(prev) || len(l.s) < 5 || !strings.EqualFold(l.s[:4], "www.") {
		return 0, false
	}
	end, ok := l.domain(0)
	if !ok {
		return 0, false
	}
	return l.path(end), true
}

func (l literalScanner) protocol(prev rune) (int, bool) {
	if asciiAlpha(prev) {
		return 0, false
	}
	i := 0
	for i < len(l.s) && i < 5 && asciiAlpha(rune(l.s[i])) {
		i++
	}
	if p := strings.ToLower(l.s[:i]); (p != "http" && p != "https") || !strings.HasPrefix(l.s[i:], "://") {
		return 0, false
	}
	i += 3
	if r := l.at(i); endOfWord(r) || r < 32 || r == 127 || unicodePunctuation(r) {
		return 0, false
	}
	end, ok := l.domain(i)
	if !ok {
		return 0, false
	}
	return l.path(end), true
}

func (l literalScanner) email(prev rune) (int, bool) {
	if !gfmAtext(l.at(0)) || prev == '/' || gfmAtext(prev) {
		return 0, false
	}
	i := 0
	for gfmAtext(l.at(i)) {
		i++
	}
	if l.at(i) != '@' {
		return 0, false
	}
	i++
	data, dot := false, false
	for {
		r := l.at(i)
		if r == '.' {
			if !asciiAlphanumeric(l.at(i + 1)) {
				break
			}
			dot = true
			i++
			continue
		}
		if r == '-' || r == '_' || asciiAlphanumeric(r) {
			data = true
			i++
			continue
		}
		break
	}
	if data && dot && asciiAlpha(l.at(i-1)) {
		return i, true
	}
	return 0, false
}

type autolinkParser struct{}

func (autolinkParser) Trigger() []byte {
	t := []byte{' '}
	for c := byte('!'); c <= '~'; c++ {
		if !asciiAlphanumeric(rune(c)) {
			t = append(t, c)
		}
	}
	return t
}

func (autolinkParser) Parse(parent gast.Node, block gtext.Reader, pc parser.Context) gast.Node {
	if pc.IsInLinkLabel() {
		return nil
	}
	line, seg := block.PeekLine()
	if len(line) == 0 {
		return nil
	}
	skip := 0
	prev := rune(-1)
	first, size := utf8.DecodeRune(line)
	if first == ' ' || first == '\t' || unicodePunctuation(first) || isUnicodeWhitespace(first) {
		skip, prev = size, first
	} else if p := block.PrecendingCharacter(); p != '\n' {
		prev = p
	}
	l := literalScanner{s: string(line[skip:])}
	// micromark tries the email construct first at every start character.
	url, end, ok := "", 0, false
	if end, ok = l.email(prev); ok {
		url = "mailto:" + l.s[:end]
	} else if end, ok = l.www(prev); ok {
		url = "http://" + l.s[:end]
	} else if end, ok = l.protocol(prev); ok {
		url = l.s[:end]
	}
	if !ok || end == 0 {
		return nil
	}
	if skip > 0 {
		gast.MergeOrAppendTextSegment(parent, seg.WithStop(seg.Start+skip))
	}
	block.Advance(skip + end)
	return &literalLinkNode{url: url, text: l.s[:end]}
}
