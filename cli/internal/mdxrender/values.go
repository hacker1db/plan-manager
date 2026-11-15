package mdxrender

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// A value is a static JavaScript value: undefined, nil (null), bool, float64,
// string, *array, or *object. Only literals ever become values; nothing is
// evaluated.
type value any

type undefinedValue struct{}

var undefined value = undefinedValue{}

type array struct{ items []value }

// object keeps JavaScript property order: integer-like keys ascending, then
// string keys in insertion order.
type object struct {
	keys   []string
	values map[string]value
}

func newObject() *object { return &object{values: map[string]value{}} }

func (o *object) get(key string) (value, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.values[key]
	return v, ok
}

// field reads a property the way `record.key` does: missing is undefined.
func (o *object) field(key string) value {
	if v, ok := o.get(key); ok {
		return v
	}
	return undefined
}

func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return n, err == nil && n < math.MaxUint32
}

func (o *object) set(key string, v value) {
	if _, ok := o.values[key]; ok {
		o.values[key] = v
		return
	}
	o.values[key] = v
	index, isIndex := arrayIndex(key)
	if !isIndex {
		o.keys = append(o.keys, key)
		return
	}
	at := len(o.keys)
	for i, k := range o.keys {
		other, otherIndex := arrayIndex(k)
		if !otherIndex || other > index {
			at = i
			break
		}
	}
	o.keys = append(o.keys, "")
	copy(o.keys[at+1:], o.keys[at:])
	o.keys[at] = key
}

// jsString is String(value).
func jsString(v value) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedValue:
		return "undefined"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return numberString(x)
	case string:
		return x
	case *array:
		parts := make([]string, len(x.items))
		for i, item := range x.items {
			if item != nil && item != undefined {
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// text mirrors render.tsx: null and undefined render as nothing.
func text(v value) string {
	if v == nil || v == undefined {
		return ""
	}
	return jsString(v)
}

func truthy(v value) bool {
	switch x := v.(type) {
	case nil, undefinedValue:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// nullish is `value ?? fallback`.
func nullish(v, fallback value) value {
	if v == nil || v == undefined {
		return fallback
	}
	return v
}

func isFinite(v value) bool {
	f, ok := v.(float64)
	return ok && !math.IsInf(f, 0) && !math.IsNaN(f)
}

func isInteger(v value) bool {
	f, ok := v.(float64)
	return ok && isFinite(v) && math.Trunc(f) == f
}

// numberString formats a number like Number.prototype.toString().
func numberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// Shortest round-tripping digits and exponent: d.ddd e±x.
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	x, _ := strconv.Atoi(exp)
	k := len(digits)
	n := x + 1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		ex := n - 1
		es := "+" + strconv.Itoa(ex)
		if ex < 0 {
			es = strconv.Itoa(ex)
		}
		if k == 1 {
			out = digits + "e" + es
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + es
		}
	}
	return sign + out
}

func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// prettyJSON is `JSON.stringify(JSON.parse(text(value)), null, 2)`, falling
// back to the text when it is not JSON.
func prettyJSON(v value) string {
	source := text(v)
	p := &jsonParser{s: source}
	p.ws()
	parsed, ok := p.value()
	p.ws()
	if !ok || p.i != len(p.s) {
		return source
	}
	var b strings.Builder
	stringifyJSON(&b, parsed, "")
	return b.String()
}

type jsonParser struct {
	s string
	i int
}

func (p *jsonParser) ws() {
	for p.i < len(p.s) && strings.IndexByte(" \t\n\r", p.s[p.i]) >= 0 {
		p.i++
	}
}

func (p *jsonParser) value() (value, bool) {
	if p.i >= len(p.s) {
		return nil, false
	}
	switch c := p.s[p.i]; {
	case c == '{':
		p.i++
		o := newObject()
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == '}' {
			p.i++
			return o, true
		}
		for {
			p.ws()
			if p.i >= len(p.s) || p.s[p.i] != '"' {
				return nil, false
			}
			key, ok := p.str()
			if !ok {
				return nil, false
			}
			p.ws()
			if p.i >= len(p.s) || p.s[p.i] != ':' {
				return nil, false
			}
			p.i++
			p.ws()
			v, ok := p.value()
			if !ok {
				return nil, false
			}
			o.set(key.(string), v)
			p.ws()
			if p.i < len(p.s) && p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.s) && p.s[p.i] == '}' {
				p.i++
				return o, true
			}
			return nil, false
		}
	case c == '[':
		p.i++
		a := &array{}
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ']' {
			p.i++
			return a, true
		}
		for {
			p.ws()
			v, ok := p.value()
			if !ok {
				return nil, false
			}
			a.items = append(a.items, v)
			p.ws()
			if p.i < len(p.s) && p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.s) && p.s[p.i] == ']' {
				p.i++
				return a, true
			}
			return nil, false
		}
	case c == '"':
		return p.str()
	case c == 't' && strings.HasPrefix(p.s[p.i:], "true"):
		p.i += 4
		return true, true
	case c == 'f' && strings.HasPrefix(p.s[p.i:], "false"):
		p.i += 5
		return false, true
	case c == 'n' && strings.HasPrefix(p.s[p.i:], "null"):
		p.i += 4
		return nil, true
	case c == '-' || (c >= '0' && c <= '9'):
		start := p.i
		if c == '-' {
			p.i++
		}
		digits := func() int {
			n := 0
			for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
				p.i++
				n++
			}
			return n
		}
		if p.i < len(p.s) && p.s[p.i] == '0' {
			p.i++
		} else if digits() == 0 {
			return nil, false
		}
		if p.i < len(p.s) && p.s[p.i] == '.' {
			p.i++
			if digits() == 0 {
				return nil, false
			}
		}
		if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
			p.i++
			if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
				p.i++
			}
			if digits() == 0 {
				return nil, false
			}
		}
		f, err := strconv.ParseFloat(p.s[start:p.i], 64)
		if err != nil && !math.IsInf(f, 0) {
			return nil, false
		}
		return f, true
	}
	return nil, false
}

func (p *jsonParser) str() (value, bool) {
	p.i++
	var units []uint16
	var b strings.Builder
	flush := func() {
		if len(units) > 0 {
			b.WriteString(string(utf16.Decode(units)))
			units = nil
		}
	}
	for p.i < len(p.s) {
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			flush()
			return b.String(), true
		case c < 0x20:
			return nil, false
		case c == '\\':
			if p.i+1 >= len(p.s) {
				return nil, false
			}
			e := p.s[p.i+1]
			p.i += 2
			if e == 'u' {
				if p.i+4 > len(p.s) {
					return nil, false
				}
				n, err := strconv.ParseUint(p.s[p.i:p.i+4], 16, 16)
				if err != nil {
					return nil, false
				}
				p.i += 4
				units = append(units, uint16(n))
				continue
			}
			flush()
			switch e {
			case '"', '\\', '/':
				b.WriteByte(e)
			case 'b':
				b.WriteByte('\b')
			case 'f':
				b.WriteByte('\f')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			default:
				return nil, false
			}
		default:
			flush()
			r, size := utf8.DecodeRuneInString(p.s[p.i:])
			b.WriteRune(r)
			p.i += size
		}
	}
	return nil, false
}

func stringifyJSON(b *strings.Builder, v value, indent string) {
	inner := indent + "  "
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool, float64:
		if f, ok := x.(float64); ok && (math.IsInf(f, 0) || math.IsNaN(f)) {
			b.WriteString("null")
			return
		}
		b.WriteString(jsString(x))
	case string:
		quoteJSON(b, x)
	case *array:
		if len(x.items) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, item := range x.items {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			stringifyJSON(b, item, inner)
		}
		b.WriteString("\n" + indent + "]")
	case *object:
		if len(x.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, key := range x.keys {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			quoteJSON(b, key)
			b.WriteString(": ")
			stringifyJSON(b, x.values[key], inner)
		}
		b.WriteString("\n" + indent + "}")
	}
}

func quoteJSON(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteString(strconv.FormatInt(int64(r)>>4, 16))
				b.WriteString(strconv.FormatInt(int64(r)&0xf, 16))
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
